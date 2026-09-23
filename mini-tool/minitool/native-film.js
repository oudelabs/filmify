'use strict';
// spektrafilm 6cd00c8: raw scatter/halation, density DIR and multilayer grain.
// Andrea Volpato, GPL-3.0; see styles/SPEKTRAFILM_CODE_LICENSE.txt.
// Full-image planes preserve recursive-filter boundaries and global grain mass.
const FilmifyNativeFilm=(()=>{
 const EXP=[[.1633,.5360],[.6496,1.5236],[.1870,2.7684]];
 function reflect(i,n){i=((i%(2*n))+2*n)%(2*n);return Math.min(i,2*n-1-i);}
 function runSteps(steps){let step;do{step=steps.next();}while(!step.done);return step.value;}
 function gaussian(src,w,h,sigma,tmp,out){return runSteps(gaussianSteps(src,w,h,sigma,tmp,out));}
 function optics(src,w,h,um,p,ch,work){return runSteps(opticsSteps(src,w,h,um,p,ch,work));}
 function opticsAsync(src,w,h,um,p,ch,work,cancelled){return filmifyRunSteps(opticsSteps(src,w,h,um,p,ch,work),cancelled);}
 function* gaussianSteps(src,w,h,sigma,tmp,out){
  if(sigma<=0){out.set(src);return out;}
  // Native recursive filtering stays on CPU: measured faster than GPU readbacks.
  if(sigma<3&&tmp.gpu&&src.length>=65536)return tmp.gpu.gaussian(src,w,h,sigma,tmp,out);
  if(sigma<3){
   const radius=Math.floor(3*sigma+.5),weights=[];let total=0;
   for(let k=-radius;k<=radius;k++){const a=Math.exp(-.5*k*k/(sigma*sigma));weights.push(a);total+=a;}
   for(let k=0;k<weights.length;k++)weights[k]/=total;
   // Same FIR order as upstream: vertical then horizontal, half-sample reflect.
   for(let y=0;y<h;y++){for(let x=0;x<w;x++){
    let v=0;for(let k=-radius;k<=radius;k++)v+=src[(y+k>=0&&y+k<h?y+k:reflect(y+k,h))*w+x]*weights[k+radius];tmp[y*w+x]=v;
   }if(y%8===7)yield; }
   for(let y=0;y<h;y++){for(let x=0;x<w;x++){
    let v=0;for(let k=-radius;k<=radius;k++)v+=tmp[y*w+(x+k>=0&&x+k<w?x+k:reflect(x+k,w))]*weights[k+radius];out[y*w+x]=v;
   }if(y%8===7)yield; }
  }else{
   const q=sigma>=2.5?.98711*sigma-.96330:3.97156-4.14554*Math.sqrt(1-.26891*sigma),q2=q*q,q3=q2*q;
   const b0=1.57825+2.44413*q+1.4281*q2+.422205*q3;
   const b1=(2.44413*q+2.85619*q2+1.26661*q3)/b0,b2=-(1.4281*q2+1.26661*q3)/b0,b3=.422205*q3/b0,B=1-b1-b2-b3;
   function* horizontal(input,output,width,height){
    for(let y=0;y<height;y++){
     const offset=y*width;let a=input[offset],b=a,c=a;
     for(let x=0;x<width;x++){const v=B*input[offset+x]+b1*a+b2*b+b3*c;output[offset+x]=v;c=b;b=a;a=v;}
     a=output[offset+width-1];b=a;c=a;
     for(let x=width-1;x>=0;x--){const v=B*output[offset+x]+b1*a+b2*b+b3*c;output[offset+x]=v;c=b;b=a;a=v;}
     if(y%8===7)yield;
    }
   }
   function* transpose(input,output,width,height){
    for(let first=0;first<height;first+=32){for(let left=0;left<width;left+=32)
     for(let y=first;y<Math.min(first+32,height);y++)for(let x=left;x<Math.min(left+32,width);x++)output[x*height+y]=input[y*width+x];
    yield;}
   }
   yield* horizontal(src,tmp,w,h);yield* transpose(tmp,out,w,h);
   yield* horizontal(out,tmp,h,w);yield* transpose(tmp,out,h,w);
  }
  return out;
 }
 function accumulate(dst,src,gain){for(let i=0;i<dst.length;i++)dst[i]+=src[i]*gain;}
 function* opticsSteps(src,w,h,um,p,ch,work){
  if(!p.active)return src;
  const [tmp,out,sum]=work,N=src.length;
  if(p.scatter_amount>0){
   yield* gaussianSteps(src,w,h,Math.max(1e-6,p.scatter_core_um[ch]*p.scatter_spatial_scale/um),tmp,out);
   const s=p.scatter_amount,tail=p.scatter_tail_weight[ch];
   for(let i=0;i<N;i++)sum[i]=(1-s)*src[i]+s*(1-tail)*out[i];
   for(const [a,r] of EXP){yield* gaussianSteps(src,w,h,Math.max(1e-6,p.scatter_tail_um[ch]*p.scatter_spatial_scale/um)*r,tmp,out);accumulate(sum,out,s*tail*a);}
   src.set(sum);
  }
  const strength=p.halation_strength[ch]*p.halation_amount;
  if(strength>0){
   sum.fill(0);let total=0;for(let k=0;k<p.halation_n_bounces;k++)total+=Math.pow(p.halation_bounce_decay,k);
   for(let k=1;k<=p.halation_n_bounces;k++){
    yield* gaussianSteps(src,w,h,p.halation_first_sigma_um[ch]*p.halation_spatial_scale*Math.sqrt(k)/um,tmp,out);
    accumulate(sum,out,Math.pow(p.halation_bounce_decay,k-1)/total);
   }
   const norm=p.halation_renormalize?1+strength:1;
   for(let i=0;i<N;i++)src[i]=(src[i]+strength*sum[i])/norm;
  }
  return src;
 }
 function interp(x,axis,values){
  const last=axis.length-1;if(x<=axis[0])return values[0];if(x>=axis[last])return values[last];
  let lo=0,hi=last;while(hi-lo>1){const mid=(hi+lo)>>1;if(x>=axis[mid])lo=mid;else hi=mid;}
  return values[lo]+(values[hi]-values[lo])*(x-axis[lo])/(axis[hi]-axis[lo]);
 }
 function density(log,fp,ch,corrected){
  const axis=fp.logExposure,values=(corrected?fp.correctedCurves:fp.curves)[ch],last=axis.length-1;
  if(log<=axis[0])return values[0];if(log>=axis[last])return values[last];
  // Native exposure grids are uniform. Estimate the cell in O(1), then verify
  // against its actual endpoints so nonuniform future grids remain correct.
  let lo=Math.min(last-1,Math.floor((log-axis[0])/(axis[last]-axis[0])*last));
  while(lo>0&&log<axis[lo])lo--;while(lo<last-1&&log>=axis[lo+1])lo++;
  return values[lo]+(values[lo+1]-values[lo])*(log-axis[lo])/(axis[lo+1]-axis[lo]);
 }
 function donor(d,fp,ch){return fp.positive?fp.densityMax[ch]-d:d*(fp.donorK[ch]+fp.donorRef[ch])/(fp.donorK[ch]+d);}
 function dir(planes,w,h,um,fp,work,spatial){
  const count=w*h,n=fp.channels,donors=planes.map((p,ch)=>Float32Array.from(p,x=>donor(density(x,fp,ch,false),fp,ch)));
  const [tmp,out,sum]=work,arrived=new Float32Array(count),p=fp.dir;
  for(let ch=0;ch<n;ch++){
   arrived.fill(0);for(let k=0;k<n;k++)accumulate(arrived,donors[k],fp.matrix[k][ch]);
   if(spatial&&p.diffusion_size_um>0){
    gaussian(arrived,w,h,p.diffusion_size_um/um,tmp,out);sum.set(out);
    const a=p.diffusion_tail_weight;for(let i=0;i<count;i++)sum[i]*=1-a;
    for(const [weight,r] of EXP){gaussian(arrived,w,h,p.diffusion_tail_um/um*r,tmp,out);accumulate(sum,out,a*weight);}arrived.set(sum);
   }
   for(let i=0;i<count;i++){
    let correction=arrived[i];if(fp.positive)correction=correction*(fp.receiverK[ch]+fp.receiverRef[ch])/(fp.receiverK[ch]+correction);
    planes[ch][i]=density(planes[ch][i]-correction,fp,ch,true);
   }
  }
 }
 // Counter-seeded PRNG: each full-image pixel/channel/layer owns its stream.
 function random(seed){let state=seed>>>0;return ()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
 function logFactorial(k){
  if(k<2)return 0;
  // Stirling series is <1e-10 at k>=16; small counts use the exact product.
  if(k<16){let v=0;for(let j=2;j<=k;j++)v+=Math.log(j);return v;}
  const inv=1/k,inv2=inv*inv;
  return (k+.5)*Math.log(k)-k+.9189385332046727+inv*(1/12-inv2*(1/360-inv2/1260));
 }
 function poisson(lambda,rng){
  if(lambda<10){const limit=Math.exp(-lambda);let p=1,k=0;do{p*=rng();k++;}while(p>limit);return k-1;}
  // Hörmann PTRS transformed rejection, the same target Poisson law.
  const root=Math.sqrt(lambda),b=.931+2.53*root,a=-.059+.02483*b,inv=1.1239+1.1328/(b-3.4),vr=.9277-3.6224/(b-2);
  for(;;){const u=rng()-.5,v=rng(),us=.5-Math.abs(u);if(us<=0)continue;
   const k=Math.floor((2*a/us+b)*u+lambda+.43);
   if(us>=.07&&v<=vr)return k;
   if(k<0||(us<.013&&v>us))continue;
   if(Math.log(v*inv/(a/(us*us)+b))<=-lambda+k*Math.log(lambda)-logFactorial(k))return k;
  }
 }
 function grainPlane(src,w,h,um,fp,ch,work,seed,gpu){
  const [tmp,out,sum]=work,p=fp.grain,N=w*h;sum.fill(0);
  const axis=fp.positive?fp.curves[ch].map(x=>-x):fp.curves[ch];
  const particle=new Float32Array(N);
  for(let layer=0;layer<fp.layers[ch].length;layer++){
   const max=fp.layerMax[ch][layer],particles=fp.particleCountsAt1um[ch][layer]*um*um,od=max/particles;
   if(gpu)gpu.sample(src,particle,fp,ch,layer,um,seed);
   else for(let i=0;i<N;i++){
    const d=interp(fp.positive?-src[i]:src[i],axis,fp.layers[ch][layer])+fp.layerMin[ch][layer];
    const prob=Math.min(1-1e-6,Math.max(1e-6,d/max)),sat=1-prob*p.uniformity[ch]*(1-1e-6);
    // Exact Poisson thinning: Binomial(Poisson(N/s), p) = Poisson(N*p/s).
    // Float32 count matches the upstream grain work dtype; RNG samples differ.
    const rng=random((i^Math.imul(ch+1,0x9e3779b1)^Math.imul(layer+1,0x85ebca6b)^seed)>>>0);
    particle[i]=Math.fround(poisson(particles*prob/sat,rng))*od*sat;
   }
   const sigma=p.blur_dye_clouds_um*Math.sqrt(od);
   if(sigma>0){gaussian(particle,w,h,sigma,tmp,out);accumulate(sum,out,1);}else accumulate(sum,particle,1);
  }
  const microSigma=p.micro_structure[1]*.001/um,microBlur=p.micro_structure[0]/um;
  if(microSigma>.05){
   const variance=Math.log(1+microSigma*microSigma);
   for(let i=0;i<N;i++){const rng=random((i^Math.imul(ch+1,0x27d4eb2d)^seed)>>>0);particle[i]=Math.exp(-variance/2+Math.sqrt(variance)*Math.sqrt(-2*Math.log(Math.max(rng(),1e-12)))*Math.cos(2*Math.PI*rng()));}
   if(microBlur>.4){gaussian(particle,w,h,microBlur,tmp,out);particle.set(out);}
   for(let i=0;i<N;i++)sum[i]*=particle[i];
  }
  if(p.blur>0){gaussian(sum,w,h,p.blur,tmp,out);sum.set(out);}
  if(p.mult_usm_amount>0&&p.mult_usm_sigma>0){
   gaussian(sum,w,h,p.mult_usm_sigma,tmp,out);let before=0,after=0;
   for(let i=0;i<N;i++){const d=Math.max(sum[i],0);before+=d;const v=d<=0?0:Math.pow(Math.max(d,1e-6),1+p.mult_usm_amount)/Math.pow(Math.max(out[i],1e-6),p.mult_usm_amount);particle[i]=v;after+=v;}
   const gain=after>0?before/after:1;for(let i=0;i<N;i++)sum[i]=particle[i]*gain;
  }
  for(let i=0;i<N;i++)src[i]=sum[i]-fp.densityMin[ch];
 }
 // Print glare (scanning stage): iid lognormal(mean=percent,
 // std=roughness*percent) per pixel, Gaussian blur sigma=blur scan px, /100,
 // added to linear scan RGB. The D50/K75P viewing illuminant is the XYZ->sRGB
 // adaptation white, so the additive term is achromatic. Sampled per global
 // pixel index so tiles compose into one continuous seeded field; upstream
 // draws a fresh field per run instead.
 function glareSample(globalIndex,spec,seed){
  const m=spec.percent,s=spec.roughness*m,variance=Math.log(1+(s/m)*(s/m));
  const rng=random((globalIndex^Math.imul(0x85ebca77,0x9e3779b1)^seed)>>>0);
  return Math.exp(Math.log(m)-variance/2+Math.sqrt(variance)*Math.sqrt(-2*Math.log(Math.max(rng(),1e-12)))*Math.cos(2*Math.PI*rng()));
 }
 function sampleRaw(rgb,offset,style,ch){
  const n=style.rawSize,v=style.rawValues,r=rgb[offset]/255*(n-1),g=rgb[offset+1]/255*(n-1),b=rgb[offset+2]/255*(n-1);
  const r0=Math.min(n-2,Math.floor(r)),g0=Math.min(n-2,Math.floor(g)),b0=Math.min(n-2,Math.floor(b)),rf=r-r0,gf=g-g0,bf=b-b0;let value=0;
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++)value+=v[((b0+z)*n*n+(g0+y)*n+r0+x)*3+ch]*(x?rf:1-rf)*(y?gf:1-gf)*(z?bf:1-bf);
  return value*style.rawScale[ch];
 }
 async function prepare(image,style,options){
  options=options||{};const clock=typeof performance==='undefined'?Date:performance,times={};let tick=clock.now();const mark=name=>{times[name]=clock.now()-tick;tick=clock.now();};const w=image.naturalWidth,h=image.naturalHeight,N=w*h,fp=style.film;
  const um=(options.filmFormatMm||fp.cameraFilmFormatMm)*1000/Math.max(w,h),gain=Math.pow(2,options.exposureEV||0);
  const planes=Array.from({length:fp.channels},()=>new Float32Array(N)),work=Array.from({length:3},()=>new Float32Array(N));
  const gpu=options.gl&&options.gpu!==false?new FilmifySpatialGPU.Kernels(options.gl):null;work[0].gpu=gpu;
  try{
  const c=document.createElement('canvas');c.width=w;c.height=Math.min(32,h);const ctx=c.getContext('2d',{colorSpace:'srgb'});
  const yieldStep=async()=>{if(options.cancelled&&options.cancelled())throw new Error('已取消');await filmifyYield();};
  try{
   for(let y=0;y<h;y+=32){
    const rows=Math.min(32,h-y);ctx.drawImage(image,0,y,w,rows,0,0,w,rows);const rgb=ctx.getImageData(0,0,w,rows).data;
    for(let i=0;i<rows*w;i++)for(let ch=0;ch<fp.channels;ch++)planes[ch][y*w+i]=sampleRaw(rgb,i*4,style,ch)*gain;
    await yieldStep();
   }
  }finally{c.width=c.height=1;}
  mark('raw');
  for(let ch=0;ch<fp.channels;ch++){
   if(options.finish!==false&&options.optics!==false)optics(planes[ch],w,h,um,fp.halation,ch,work);
   for(let i=0;i<N;i++)planes[ch][i]=Math.log10(Math.max(0,planes[ch][i]*fp.bwCorrection)+1e-10);
   await yieldStep();
  }
  mark('optics');
  if(fp.dir.active)dir(planes,w,h,um,fp,work,options.finish!==false&&options.dir!==false);
  else for(let ch=0;ch<fp.channels;ch++)for(let i=0;i<N;i++)planes[ch][i]=density(planes[ch][i],fp,ch,false);
  await yieldStep();
  mark('DIR');
  if(options.finish!==false&&options.grain!==false&&fp.grain.active)for(let ch=0;ch<fp.channels;ch++){
   grainPlane(planes[ch],w,h,um,fp,ch,work,options.seed||0,gpu);await yieldStep();
  }
  for(let ch=0;ch<fp.channels;ch++)for(let i=0;i<N;i++){
   const v=planes[ch][i];if(!Number.isFinite(v)||v<style.densityLow[ch]-1e-5||v>style.densityLow[ch]+style.densitySpan[ch]+1e-5)throw new Error('胶片密度超出已验证范围，未截断颜色');
  }
  mark('grain');
  return {planes:planes,width:w,height:h,pixelSizeUm:um,timings:times,glare:style.glare||null,seed:options.seed||0};
  }finally{if(gpu)gpu.dispose();}
 }
 return {prepare:prepare,gaussian:gaussian,optics:optics,opticsAsync:opticsAsync,dir:dir,grainPlane:grainPlane,glareSample:glareSample,poisson:poisson,random:random};
})();
if(typeof module!=='undefined')module.exports=FilmifyNativeFilm;
