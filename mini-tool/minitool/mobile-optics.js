'use strict';
// Mobile proposal-A low-resolution optical field (halation only since
// 2026-09-21; see below). Physical scale: halation radii come from the pinned
// per-stock film parameters (um). The field runs the native halation
// (multi-bounce gaussian) at bounded field resolution, then stores the
// ADDITIVE LINEAR glow (after-before, raw units) so full-resolution tiles add
// it back before the log step — identical semantics to native's linear-domain
// halation. (2026-09-22 起改为线性加性:log10 增量在 orig≈0 的暗像素上会爆炸
// 到 +6~8 个数量级,深色毛发被烧成橙色斑点;线性差有界且双线性插值安全。)
// 2026-09-21 起 scatter 不再进场：scatter_core(~2um)/scatter_tail(~9-27um)
// 在 768 场像素(≈46um/px)下全部亚像素、在场里近似恒等（mobile 实测因此完全
// 丢失胶片微反差，见 validation/scatter-gap/）。小尺度 scatter 改为全尺寸
// tile 内 GPU 处理（mobile-film.js scatter passes），场只负责长程 halation；
// 原生「先 scatter 后 halation」的顺序在 65um 尺度下差异可忽略（halation 对
// 散射前后输入几乎不敏感），故场直接用未散射 raw 计算。
const FilmifyMobileOptics=(()=>{
 // Sample a (size,size,size,3) table at encoded-sRGB coords (r,g,b), using
 // the same trilinear + texel-centre convention as the mobile shader.
 function texel(values,size,x,y,z){
  const xi=Math.min(size-1,Math.max(0,Math.floor(x*size)));
  const yi=Math.min(size-1,Math.max(0,Math.floor(y*size)));
  const zi=Math.min(size-1,Math.max(0,Math.floor(z*size)));
  const p=((zi*size+yi)*size+xi)*3;
  return values[p]!==undefined?[values[p],values[p+1],values[p+2]]:[0,0,0];
 }
 function sampleTable(values,size,r,g,b){
  const c0=Math.max(0,Math.min(1,r))*(size-1);
  const c1=Math.max(0,Math.min(1,g))*(size-1);
  const c2=Math.max(0,Math.min(1,b))*(size-1);
  const i0=Math.floor(c0),i1=Math.floor(c1),i2=Math.floor(c2);
  const f0=c0-i0,f1=c1-i1,f2=c2-i2;
  // 修复（2026-09-21）：x1 原误用绿色索引 i1（交叉索引），与 renderer GLSL
  // sampleTable 的正确三线性不一致，导致光学场 delta 相对错误的 raw 基线，
  // 暗部产生系统偏差；现改为 (i0+1+.5)/size，与主渲染基线一致。
  const x0=(i0+.5)/size,x1=(i0+1+.5)/size;
  const y0=(i1+.5)/size,y1=(i1+1+.5)/size;
  const z0=(i2+.5)/size,z1=(i2+1+.5)/size;
  const c000=texel(values,size,x0,y0,z0),c100=texel(values,size,x1,y0,z0);
  const c010=texel(values,size,x0,y1,z0),c110=texel(values,size,x1,y1,z0);
  const c001=texel(values,size,x0,y0,z1),c101=texel(values,size,x1,y0,z1);
  const c011=texel(values,size,x0,y1,z1),c111=texel(values,size,x1,y1,z1);
  const out=[0,0,0];
  for(let ch=0;ch<3;ch++){
   const v00=c000[ch]+(c100[ch]-c000[ch])*f0,v10=c010[ch]+(c110[ch]-c010[ch])*f0;
   const v01=c001[ch]+(c101[ch]-c001[ch])*f0,v11=c011[ch]+(c111[ch]-c011[ch])*f0;
   const v0=v00+(v10-v00)*f1,v1=v01+(v11-v01)*f1;
   out[ch]=v0+(v1-v0)*f2;
  }
  return out;
 }
 // Half-float packing for RGBA16F upload (linear glow values; 11-bit mantissa
 // and ~6e-5 最小正规格化数对加性辉光足够——更小的量远低于输出 LSB,欠载到 0
 // 无害). Shared buffers avoid per-pixel allocation (3x field pixels per photo).
 const _f32=new Float32Array(1),_u32=new Uint32Array(_f32.buffer);
 function floatToHalf(v){
  _f32[0]=v;const x=_u32[0];
  let sign=(x>>>16)&0x8000,exp=((x>>>23)&0xff)-127+15,man=x&0x7fffff;
  if(exp<=0){if(exp<-10)return sign;man=(man|0x800000)>>(1-exp);return sign|((man+0x1000+((man>>13)&1))>>13);}
  if(exp>=31)return sign|0x7c00;
  man+=0x1000+((man>>13)&1);if(man>=0x800000){man=0;exp++;}
  if(exp>=31)return sign|0x7c00;
  return sign|(exp<<10)|(man>>13);
 }
 // Long CPU loops yield to the event loop between row strips: the field build
 // sits between the progress callback and the first tile render, and an
 // unsliced 768px build blocks the main thread for 0.5-1s+ on phones.
 const breather=typeof filmifyYield==='function'?filmifyYield:function(){return Promise.resolve();};
 // CineBloom camera diffusion, ported from pinned spektrafilm diffusion.py.
 // Exact sampled radial PSF + reflect-padded FFT convolution on the bounded
 // optical field. This is a field-resolution approximation, not a full-size
 // FFT. No threshold, tint overlay or sRGB blur: energy is redistributed in raw.
 function fftPlan(n){
  const rev=new Uint32Array(n),co=new Float32Array(n/2),si=new Float32Array(n/2);
  for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;rev[i]=j;}
  for(let i=0;i<n/2;i++){co[i]=Math.cos(2*Math.PI*i/n);si[i]=Math.sin(2*Math.PI*i/n);}
  return {n:n,rev:rev,co:co,si:si};
 }
 function fftLine(re,im,offset,stride,p,inverse){
  const n=p.n;
  for(let i=0;i<n;i++){const j=p.rev[i];if(j>i){const a=offset+i*stride,b=offset+j*stride,t=re[a],u=im[a];re[a]=re[b];im[a]=im[b];re[b]=t;im[b]=u;}}
  for(let len=2;len<=n;len*=2){const half=len/2,step=n/len;
   for(let a=0;a<n;a+=len)for(let j=0;j<half;j++){
    const k=j*step,c=p.co[k],s=inverse?p.si[k]:-p.si[k],u=offset+(a+j)*stride,v=u+half*stride;
    const vr=re[v]*c-im[v]*s,vi=re[v]*s+im[v]*c,ur=re[u],ui=im[u];
    re[u]=ur+vr;im[u]=ui+vi;re[v]=ur-vr;im[v]=ui-vi;
   }
  }
  if(inverse)for(let i=0;i<n;i++){const j=offset+i*stride;re[j]/=n;im[j]/=n;}
 }
 function* fft2Steps(re,im,W,H,px,py,inverse){
  for(let y=0;y<H;y++){fftLine(re,im,y*W,1,px,inverse);if(y%4===3)yield;}
  for(let x=0;x<W;x++){fftLine(re,im,x,W,py,inverse);if(x%4===3)yield;}
 }
 function fft2(re,im,W,H,px,py,inverse,opts){return filmifyRunSteps(fft2Steps(re,im,W,H,px,py,inverse),opts.cancelled);}

 function mirrorWhole(i,n){if(n<=1)return 0;const period=2*n-2,k=((i%period)+period)%period;return Math.min(k,period-k);}
 function diffusionStrength(strength){
  if(!(strength>0))return 0;
  const stops=[.125,.25,.5,1,2],amount=[.10,.20,.35,.55,.75];
  if(strength<=stops[0])return amount[0];
  for(let i=1;i<5;i++)if(strength<=stops[i])return amount[i-1]+(amount[i]-amount[i-1])*Math.log2(strength/stops[i-1]);
  return amount[4];
 }
 function* diffusionPSFSteps(w,h,um,ch){
  const r=Math.min(Math.ceil(Math.max(8*2500/um,5)),Math.max(Math.floor(Math.min(w,h)/2)-1,1));
  const side=2*r+1,k=new Float32Array(side*side),parts=[];
  const warm=[1.30,.15,-1.45][ch]*.85;
  const hw=[Math.max(0,1-warm),1,Math.max(0,1+warm)],hs=hw[0]+hw[1]+hw[2];
  for(let j=0;j<2;j++)parts.push([20*(j===0?1/1.5:1.5)/um,.22/2]);
  for(let j=0;j<3;j++)parts.push([100*Math.pow(2,j)/um,.30*hw[j]/hs]);
  let total=0;const blooms=[];
  for(let j=0;j<4;j++){const l=400*Math.pow(6.25,j/3),v=Math.pow(l,-.5);blooms.push([l/um,v]);total+=v;}
  for(const b of blooms)parts.push([b[0],.48*b[1]/total]);
  let sum=0;
  for(let y=-r;y<=r;y++){for(let x=-r;x<=r;x++){
   const d=Math.sqrt(x*x+y*y);let v=0;
   for(const part of parts)v+=part[1]*Math.exp(-d/part[0])/(2*Math.PI*part[0]*part[0]);
   k[(y+r)*side+x+r]=v;sum+=v;
  }if((y+r)%4===3)yield;}
  for(let i=0;i<k.length;i++)k[i]/=sum;
  return {data:k,radius:r};
 }
 function diffusionPSF(w,h,um,ch){let step;const steps=diffusionPSFSteps(w,h,um,ch);do{step=steps.next();}while(!step.done);return step.value;}
 async function diffusePlane(src,w,h,um,ch,opts,workspace){
  if(opts.cancelled&&opts.cancelled())throw new Error('已取消');
  const strength=opts.diffusion||0,p=diffusionStrength(strength);if(!p)return 1;
  const kernel=await filmifyRunSteps(diffusionPSFSteps(w,h,um,ch),opts.cancelled),r=kernel.radius;
  let W=1,H=1;while(W<w+2*r)W*=2;while(H<h+2*r)H*=2;
  const ws=workspace||{};
  if(ws.W!==W||ws.H!==H){ws.W=W;ws.H=H;ws.re=new Float32Array(W*H);ws.im=new Float32Array(W*H);ws.kr=new Float32Array(W*H);ws.ki=new Float32Array(W*H);ws.px=fftPlan(W);ws.py=fftPlan(H);}
  const re=ws.re,im=ws.im,kr=ws.kr,ki=ws.ki,px=ws.px,py=ws.py;
  re.fill(0);im.fill(0);kr.fill(0);ki.fill(0);
  for(let y=0;y<h+2*r;y++)for(let x=0;x<w+2*r;x++)re[y*W+x]=src[mirrorWhole(y-r,h)*w+mirrorWhole(x-r,w)];
  for(let y=-r;y<=r;y++)for(let x=-r;x<=r;x++)kr[((y+H)%H)*W+(x+W)%W]=kernel.data[(y+r)*(2*r+1)+x+r];
  await fft2(re,im,W,H,px,py,false,opts);await fft2(kr,ki,W,H,px,py,false,opts);
  for(let i=0;i<re.length;i++){const a=re[i]*kr[i]-im[i]*ki[i];im[i]=re[i]*ki[i]+im[i]*kr[i];re[i]=a;}
  await fft2(re,im,W,H,px,py,true,opts);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;src[i]=src[i]*(1-p)+p*re[(y+r)*W+x+r];}
  return 1-p+p*kernel.data[r*(2*r+1)+r];
 }
 // Build the optical delta field for one image+stock. Returns
 // {data:Uint16Array(RGBA16F), w, h} or null when no optics apply.
 async function buildField(source,style,field,opts){
  opts=opts||{};
  const fp=style.film,hal=fp.halation;
  if((!hal||!hal.active)&&!(opts.diffusion>0))return null;
  const channels=fp.channels,w=source.naturalWidth||source.width,h=source.naturalHeight||source.height;
  const longEdge=Math.max(w,h);
  const scale=field/longEdge;
  const fw=Math.max(2,Math.round(w*scale)),fh=Math.max(2,Math.round(h*scale));
  const N=fw*fh;
  const t0=opts.debug?performance.now():0;
  const c=document.createElement('canvas');c.width=fw;c.height=fh;
  const ctx=c.getContext('2d',{colorSpace:'srgb'});
  ctx.drawImage(source,0,0,fw,fh);
  const rgb=ctx.getImageData(0,0,fw,fh).data;
  c.width=c.height=1;
  const t1=opts.debug?performance.now():0;
  const table=style.mobileRawValues,size=style.rawSize,rawScale=style.rawScale;
  const planes=[];
  for(let ch=0;ch<channels;ch++)planes.push(new Float32Array(N));
  function* sampleRows(){for(let y=0;y<fh;y++){
   const base=y*fw;
   for(let x=0;x<fw;x++){
    const i=base+x;
    const r=rgb[i*4]/255,g=rgb[i*4+1]/255,b=rgb[i*4+2]/255;
    const raw=sampleTable(table,size,r,g,b);
    for(let ch=0;ch<channels;ch++)planes[ch][i]=raw[ch]*rawScale[ch];
   }
   if(y%4===3)yield;
  }}
  await filmifyRunSteps(sampleRows(),opts.cancelled);
  const t2=opts.debug?performance.now():0;
  // Physical scale: field pixels are (longEdge/field) x larger than source pixels.
  const um=(opts.filmFormatMm||fp.cameraFilmFormatMm||35)*1000/longEdge;
  const fieldUm=um*longEdge/field;
  const work=[new Float32Array(N),new Float32Array(N),new Float32Array(N)];
  const delta=new Float32Array(N*3),transmission=[1,1,1],diffusionWork={};
  for(let ch=0;ch<channels;ch++){
   const orig=planes[ch].slice();
   // Halation-only field: scatter_amount zeroed (small-scale scatter runs at
   // full resolution inside the tiles; see header comment).
   if(opts.diffusion>0)transmission[ch]=await diffusePlane(planes[ch],fw,fh,fieldUm,ch,opts,diffusionWork);
   const hal0=hal&&hal.scatter_amount>0?Object.assign({},hal,{scatter_amount:0}):hal;
   if(hal0&&hal0.active&&opts.halation!==false)await FilmifyNativeFilm.opticsAsync(planes[ch],fw,fh,fieldUm,hal0,ch,work,opts.cancelled);
   for(let y=0;y<fh;y++){
    const base=y*fw;
    for(let x=0;x<fw;x++){
     const i=base+x;
     /* 线性加性辉光(2026-09-22 根治暗部火星):存 after-before 的线性差,tile
        shader 在取 log 前加回(与 native 线性域加辉光语义一致)。原先存 log10
        增量,orig≈0 的暗像素收到微弱辉光会产生 +6~8 log10 单位的爆炸增量,
        全尺寸深色纹理(毛发/雪地交界)被打爆成橙色斑点(R/G 通道爆炸、B 不动)。 */
     delta[i*3+ch]=planes[ch][i]-transmission[ch]*orig[i];
    }
    if(y%128===127)await breather();
   }
   await breather();
  }
  const t3=opts.debug?performance.now():0;
  const half=new Uint16Array(N*4);
  for(let y=0;y<fh;y++){
   const base=y*fw;
   for(let x=0;x<fw;x++){
    const i=base+x;
    half[i*4]=floatToHalf(delta[i*3]);
    half[i*4+1]=floatToHalf(delta[i*3+1]);
    half[i*4+2]=floatToHalf(delta[i*3+2]);
    half[i*4+3]=0;
   }
   if(y%128===127)await breather();
  }
  if(opts.debug)console.log('buildField ms','draw',Math.round(t1-t0),'raw',Math.round(t2-t1),'optics',Math.round(t3-t2),'half',Math.round(performance.now()-t3),'total',Math.round(performance.now()-t0));
  if(opts.keepFloat)return {data:half,w:fw,h:fh,floatDelta:delta,transmission:transmission};
  return {data:half,w:fw,h:fh,transmission:transmission};
 }
 return {buildField:buildField,sampleTable:sampleTable,diffusionStrength:diffusionStrength,diffusionPSFAsync:(w,h,um,ch,cancelled)=>filmifyRunSteps(diffusionPSFSteps(w,h,um,ch),cancelled),diffusionPSF:diffusionPSF,diffusePlane:diffusePlane};
})();
