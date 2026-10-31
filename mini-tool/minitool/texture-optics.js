/* Finished-photo optical convolution. GPL-3.0-only.
 * Diffusion profiles adapted from Fotufilm, Apache-2.0, copyright MUAStudio Inc.
 * Pinned source: DhaliwalX/fotufilm-engine 73dff127f68e8ae21ce1626cd654d79138c37e1f,
 * Sources/FotufilmCore/DiffusionFilter.swift. Its log-normal particle Airy
 * integral is fitted by three Gaussian scales (CDF quantiles .10 and .96).
 * The frozen fit below was evaluated with that actual Swift implementation,
 * Portra 400 record sensitivity under D65, f=43.266615 mm, pixel pitch .001 mm.
 * This completed-photo adaptation retains the selected LUT color; it does not
 * claim to reproduce a RAW spectral capture. Pixel-area Gaussian integration,
 * a shared Portra reference and a split-resolution convolution are adaptations.
 * Black Pro-Mist, Pro-Mist and Glimmerglass use upstream particle parameters.
 * CineBloom is a Filmify creative preset of the same scattering model, not an
 * upstream family or measured commercial filter. Mirror-whole boundaries.
 */
'use strict';
const FilmifyTextureOptics=(()=>{
 const kernelCache=new Map();
 const wakeups=new Set();
 const yieldNow=()=>new Promise(resolve=>{let cancelTask=null,done=false;const finish=()=>{if(done)return;done=true;if(cancelTask)cancelTask();wakeups.delete(finish);resolve();};wakeups.add(finish);if(typeof filmifyScheduleTask==='function')cancelTask=filmifyScheduleTask(finish);else{const timer=setTimeout(finish,0);cancelTask=()=>clearTimeout(timer);}});
 function wake(){for(const finish of Array.from(wakeups))finish();}
 const check=cancelled=>{if(cancelled&&cancelled())throw new Error('已取消');};
 function mirror(i,n){if(n<=1)return 0;const period=2*n-2,k=((i%period)+period)%period;return Math.min(k,period-k);}
 const REFERENCE_FOCAL_MM=43.266615,REFERENCE_WAVELENGTHS_NM=[628.13556,530.82385,440.1341];
 const mistFit={sigmasMM:[.3649467,.887375,2.1576698],weights:[[.63833976,.2586419,.103018284],[.7857112,.085255876,.12903291],[.90660024,0,.09339979]],truncatedShare:.03464085};
 const glimmerFit={sigmasMM:[.12512457,.30424285,.7397725],weights:[[.63833976,.2586419,.103018284],[.7856315,.085545644,.1288229],[.9065717,0,.09342833]],truncatedShare:.034656107};
 function normalized(row){const total=row.reduce((a,b)=>a+b,0);return row.map(v=>v/total);}
 // The slight Float32 rounding of the upstream fit is removed only from the
 // row sums, so the reassembled scattered field carries exactly unit energy.
 mistFit.weights=mistFit.weights.map(normalized);glimmerFit.weights=glimmerFit.weights.map(normalized);
 const families={
  black_pro_mist:{particleRadiusUM:12,albedo:.30,sizeSpread:.45,fit:mistFit,source:'fotufilm'},
  pro_mist:{particleRadiusUM:12,albedo:.95,sizeSpread:.45,fit:mistFit,source:'fotufilm'},
  glimmerglass:{particleRadiusUM:35,albedo:.92,sizeSpread:.45,fit:glimmerFit,source:'fotufilm'},
  cinebloom:{particleRadiusUM:8,albedo:.95,sizeSpread:.45,fit:mistFit,source:'filmify-creative-adaptation'}
 };
 // Legacy scalar energy is retained for integrations that have not yet moved
 // to nearEnergyRGB. The engine uses per-channel shares returned by kernel().
 for(const id of Object.keys(families)){const f=families[id],near=f.fit.weights.reduce((s,row)=>s+row[0],0)/3;f.weights=[near,1-near,0];}
 function family(id){return families[id]||families.black_pro_mist;}
 function transport(level,id,strength){
  const f=family(id),value=strength===undefined?[0,.25,.5,1][level]:strength;
  if(!level||!(value>0))return {interactedFraction:0,directShare:1,scatteredShare:0,absorbedShare:0,totalTransmission:1};
  let interacted;
  // Existing CineBloom 5/10/20% menu entries carry .25/.5/1 in recipes.
  // Interpret those as 5/10/20% beam interaction, without claiming measured glass.
  if(id==='cinebloom')interacted=Math.min(.5,.2*value);
  else{const stops=[.125,.25,.5,1,2],loads=[.05,.10,.19,.32,.50];interacted=loads[4];
   if(value<=stops[0])interacted=loads[0];else for(let i=1;i<stops.length;i++)if(value<=stops[i]){interacted=loads[i-1]+(loads[i]-loads[i-1])*Math.log2(value/stops[i-1]);break;}
  }
  interacted=Math.max(0,Math.min(1,interacted));const directShare=1-interacted,scatteredShare=interacted*f.albedo,absorbedShare=interacted*(1-f.albedo);
  return {interactedFraction:interacted,directShare,scatteredShare,absorbedShare,totalTransmission:directShare+scatteredShare};
 }
 function scatterAmount(level,id,strength){const t=transport(level,id,strength);return t.scatteredShare/t.totalTransmission;}
 function profile(id,neutral,focalLengthMM){
  const f=family(id),fit=f.fit,focal=focalLengthMM===undefined?REFERENCE_FOCAL_MM:focalLengthMM;
  if(!(focal>0)||!Number.isFinite(focal))throw new Error('柔光焦距无效');
  const scale=focal/REFERENCE_FOCAL_MM*(id==='cinebloom'?12/f.particleRadiusUM:1),weights=fit.weights.map(row=>row.slice());
  if(neutral){const mean=[0,1,2].map(i=>weights.reduce((sum,row)=>sum+row[i],0)/3);for(let ch=0;ch<3;ch++)weights[ch]=mean.slice();}
  return {sigmasMM:fit.sigmasMM.map(v=>v*scale),weights,nearEnergyRGB:weights.map(row=>row[0]),focalLengthMM:focal,particleRadiusUM:f.particleRadiusUM,recordWavelengthsNM:REFERENCE_WAVELENGTHS_NM.slice(),truncatedShare:fit.truncatedShare,source:f.source};
 }
 function components(um,group,channel,id,neutral,focalLengthMM){
  if(!(um>0)||!Number.isFinite(um))throw new Error('柔光采样间距无效');
  const p=profile(id,neutral,focalLengthMM),row=Number.isInteger(channel)&&channel>=0&&channel<3?p.weights[channel]:[0,1,2].map(i=>p.weights.reduce((s,w)=>s+w[i],0)/3),indices=group==='near'?[0]:group==='far'?[1,2]:[0,1,2];
  return indices.map(i=>[p.sigmasMM[i]*1000/um,row[i]]);
 }
 // Pixel-area Gaussian mass. The approximation to erf is the standard
 // Abramowitz-Stegun 7.1.26 bound (<1.5e-7 absolute); no center point spike.
 function erf(x){const sign=x<0?-1:1,a=Math.abs(x),t=1/(1+.3275911*a);return sign*(1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-a*a));}
 function gaussianCell(x,sigma){if(sigma<.025)return x===0?1:0;const divisor=Math.SQRT2*sigma;return Math.max(0,.5*(erf((x+.5)/divisor)-erf((x-.5)/divisor)));}
 function areaBasis(x,y,sigma){return gaussianCell(x,sigma)*gaussianCell(y,sigma);}
 async function kernel(w,h,um,group,cancelled,id,neutral,focalLengthMM){
  check(cancelled);if(group!=='near'&&group!=='far'&&group!=='all')throw new Error('柔光核分组无效');
  const familyId=families[id]?id:'black_pro_mist',p=profile(familyId,neutral,focalLengthMM),key=['fotufilm-airy3-73dff127',familyId,w,h,Number(um).toPrecision(10),p.focalLengthMM.toPrecision(10),group,neutral?'neutral':'rgb'].join(':');
  if(kernelCache.has(key)){const found=kernelCache.get(key);kernelCache.delete(key);kernelCache.set(key,found);return found;}
  const parts=components(um,group,undefined,familyId,neutral,p.focalLengthMM),rgbParts=[0,1,2].map(ch=>components(um,group,ch,familyId,neutral,p.focalLengthMM)),energyRGB=rgbParts.map(row=>row.reduce((sum,v)=>sum+v[1],0)),energy=energyRGB.reduce((a,b)=>a+b,0)/3;
  // Exact 3-sigma support is retained; its finite Gaussian tail is normalized
  // within each component before mixing. No old 128-pixel near-core clipping.
  const radius=Math.max(0,Math.ceil(3*Math.max(...parts.map(part=>part[0])))),side=radius*2+1;
  const color=group!=='near'&&!neutral,planes=Array.from({length:color?3:1},()=>new Float32Array(side*side));
  for(let part=0;part<parts.length;part++){
   check(cancelled);const sigma=parts[part][0],axis=new Float64Array(side);let total=0;
   const componentRadius=Math.ceil(3*sigma);
   for(let x=-radius;x<=radius;x++){const v=Math.abs(x)<=componentRadius?gaussianCell(x,sigma):0;axis[x+radius]=v;total+=v;}
   for(let x=0;x<side;x++)axis[x]/=total;
   const weights=planes.map((_,ch)=>{const index=color?ch:0;return rgbParts[index][part][1]/energyRGB[index];});
   for(let y=0;y<side;y++){
    const ay=axis[y];for(let x=0;x<side;x++){const value=ay*axis[x],index=y*side+x;for(let ch=0;ch<planes.length;ch++)planes[ch][index]+=value*weights[ch];}
    if(y%16===15){await yieldNow();check(cancelled);}
   }
  }
  check(cancelled);const result={data:planes[color?1:0],channels:color?planes:null,planes,radius,energy,energyRGB,nearEnergyRGB:p.nearEnergyRGB,key,bytes:planes.reduce((n,plane)=>n+plane.byteLength,0),sigmasPixels:parts.map(part=>part[0]),focalLengthMM:p.focalLengthMM,source:p.source,fitTruncatedShare:p.truncatedShare};
  // At most 4 MiB retained. An individually larger full-resolution kernel is
  // usable by its caller but is not retained globally after that render.
  if(result.bytes<=4*1024*1024){let bytes=result.bytes;for(const value of kernelCache.values())bytes+=value.bytes;while(kernelCache.size&&(kernelCache.size>=6||bytes>4*1024*1024)){const first=kernelCache.keys().next().value;bytes-=kernelCache.get(first).bytes;kernelCache.delete(first);}kernelCache.set(key,result);}
  return result;
 }
 // One-dimensional form of the same pixel-area near Gaussian. Keeping this
 // plan separate avoids materializing a large square PSF for a separable pass.
 function gaussianAxis(sigma){
  if(!(sigma>0)||!Number.isFinite(sigma))throw new Error('柔光Gaussian尺度无效');
  const radius=Math.max(0,Math.ceil(3*sigma)),data=new Float32Array(2*radius+1),precise=new Float64Array(data.length);let sum=0;
  for(let i=-radius;i<=radius;i++){const value=gaussianCell(i,sigma);precise[i+radius]=value;sum+=value;}
  for(let i=0;i<data.length;i++)data[i]=precise[i]/sum;
  return {data,radius,sigma,key:'area-gaussian:'+sigma.toPrecision(12)};
 }
 function nearAxes(k){return k&&k.x&&k.y?{x:nearAxis(k.x),y:nearAxis(k.y),halfMirror:!!k.halfMirror}:{x:nearAxis(k),y:nearAxis(k),halfMirror:!!(k&&k.halfMirror)};}
 function gaussianMirror(i,n,half){if(!half)return mirror(i,n);if(n<=1)return 0;const period=2*n,q=((i%period)+period)%period;return Math.min(q,period-1-q);}
 function nearAxis(k){
  if(k&&Number.isFinite(k.sigma)&&k.data&&k.data.length===2*k.radius+1)return k;
  if(k&&!k.channels&&k.sigmasPixels&&k.sigmasPixels.length===1)return gaussianAxis(k.sigmasPixels[0]);
  throw new Error('柔光Gaussian计划无效');
 }
 async function gaussianRGBCPU(src,w,h,plan,cancelled){
  check(cancelled);const axes=nearAxes(plan),kx=axes.x,ky=axes.y,channels=src.channels===4?4:3,mid=new Float32Array(w*h*3),out=new Float32Array(w*h*3);let deadline=performance.now()+6;
  if(src.length!==w*h*channels)throw new Error('柔光RGB输入尺寸无效');
  for(let y=0;y<h;y++){
   for(let x=0;x<w;x++){let r=0,g=0,b=0;
    for(let j=-kx.radius;j<=kx.radius;j++){const index=(y*w+gaussianMirror(x+j,w,axes.halfMirror))*channels,weight=kx.data[j+kx.radius];r+=src[index]*weight;g+=src[index+1]*weight;b+=src[index+2]*weight;}
    const index=(y*w+x)*3;mid[index]=r;mid[index+1]=g;mid[index+2]=b;
   }
   if(performance.now()>=deadline){await yieldNow();check(cancelled);deadline=performance.now()+6;}
  }
  for(let y=0;y<h;y++){
   for(let x=0;x<w;x++){let r=0,g=0,b=0;
    for(let j=-ky.radius;j<=ky.radius;j++){const index=(gaussianMirror(y+j,h,axes.halfMirror)*w+x)*3,weight=ky.data[j+ky.radius];r+=mid[index]*weight;g+=mid[index+1]*weight;b+=mid[index+2]*weight;}
    const index=(y*w+x)*3;out[index]=r;out[index+1]=g;out[index+2]=b;
   }
   if(performance.now()>=deadline){await yieldNow();check(cancelled);deadline=performance.now()+6;}
  }
  check(cancelled);return out;
 }
 async function verifyGaussianRGB(src,actual,w,h,axes,cancelled){
  const kx=axes.x,ky=axes.y,sc=src.channels===4?4:3,dc=actual.channels===4?4:3,points=new Set([0,w-1,(h-1)*w,w*h-1,Math.floor(h/2)*w+Math.floor(w/2)]);let low=0,high=0,lowest=Infinity,highest=-Infinity;
  for(let i=0;i<w*h;i++)for(let ch=0;ch<3;ch++){
   const value=src[i*sc+ch];if(!Number.isFinite(value)||!Number.isFinite(actual[i*dc+ch]))throw new Error('柔光Gaussian GPU数值校验未通过');
   if(value<lowest){lowest=value;low=i;}if(value>highest){highest=value;high=i;}
  }
  points.add(low);points.add(high);let deadline=performance.now()+6;
  for(const index of points){const x=index%w,y=Math.floor(index/w),expected=[0,0,0];
   for(let yy=-ky.radius;yy<=ky.radius;yy++){
    const row=gaussianMirror(y+yy,h,axes.halfMirror)*w,horizontal=[0,0,0];
    for(let xx=-kx.radius;xx<=kx.radius;xx++){const source=(row+gaussianMirror(x+xx,w,axes.halfMirror))*sc,weight=kx.data[xx+kx.radius];for(let ch=0;ch<3;ch++)horizontal[ch]+=src[source+ch]*weight;}
    for(let ch=0;ch<3;ch++)expected[ch]+=Math.fround(horizontal[ch])*ky.data[yy+ky.radius];
    if(performance.now()>=deadline){await yieldNow();check(cancelled);deadline=performance.now()+6;}
   }
   for(let ch=0;ch<3;ch++){const value=Math.fround(expected[ch]);if(Math.abs(actual[index*dc+ch]-value)>3e-6*Math.max(1,Math.abs(value)))throw new Error('柔光Gaussian GPU数值校验未通过');}
  }
  check(cancelled);
 }
 // Area reduction treats border pixels as complete cells, whereas the
 // retained whole-sample mirror reference places its endpoints on the mirror
 // axes. Half-weight those source endpoints before reduction, then divide by
 // the same blurred quadrature weights. This conserves flat fields and avoids
 // doubling a one-pixel lamp exactly on a reduced field's image boundary.
 // The reduced Gaussian is still a measured approximation to the full grid.
 function endpointNormalization(w,h,sw,sh,plan){
  const axes=nearAxes(plan);
  function axis(size,sourceSize,k){
   const mask=new Float64Array(size).fill(1),out=new Float32Array(size);mask[0]-=.5*size/sourceSize;if(sourceSize>1)mask[size-1]-=.5*size/sourceSize;
   for(let x=0;x<size;x++){let sum=0;for(let j=-k.radius;j<=k.radius;j++)sum+=mask[gaussianMirror(x+j,size,axes.halfMirror)]*k.data[j+k.radius];out[x]=sum;}
   return out;
  }
  return {x:axis(w,sw,axes.x),y:axis(h,sh,axes.y)};
 }
 async function normalizeNearField(result,w,h,sw,sh,plan,cancelled){
  check(cancelled);const channels=result.channels===4?4:3;if(result.length!==w*h*channels)throw new Error('柔光边界归一化尺寸无效');
  const weights=endpointNormalization(w,h,sw,sh,plan);let deadline=performance.now()+6;
  for(let y=0;y<h;y++){
   for(let x=0;x<w;x++){
    const denominator=weights.x[x]*weights.y[y],index=(y*w+x)*channels;if(!(denominator>0)||!Number.isFinite(denominator))throw new Error('柔光边界权重无效');
    result[index]/=denominator;result[index+1]/=denominator;result[index+2]/=denominator;
   }
   if(performance.now()>=deadline){await yieldNow();check(cancelled);deadline=performance.now()+6;}
  }
  check(cancelled);return result;
 }
 function gaussianKernel(sigma){
  const radius=Math.max(1,Math.ceil(3*sigma)),data=new Float32Array(2*radius+1);let sum=0;
  for(let i=-radius;i<=radius;i++){const v=Math.exp(-.5*i*i/(sigma*sigma));data[i+radius]=v;sum+=v;}for(let i=0;i<data.length;i++)data[i]/=sum;return {data,radius};
 }
 async function gaussian(src,w,h,sigma,cancelled){
  const k=gaussianKernel(Math.max(.35,sigma)),mid=new Float32Array(w*h),out=new Float32Array(w*h);
  for(let y=0;y<h;y++){
   for(let x=0;x<w;x++){let v=0;for(let j=-k.radius;j<=k.radius;j++)v+=src[y*w+mirror(x+j,w)]*k.data[j+k.radius];mid[y*w+x]=v;}
   if(y%16===15){await yieldNow();check(cancelled);}
  }
  for(let y=0;y<h;y++){
   for(let x=0;x<w;x++){let v=0;for(let j=-k.radius;j<=k.radius;j++)v+=mid[mirror(y+j,h)*w+x]*k.data[j+k.radius];out[y*w+x]=v;}
   if(y%16===15){await yieldNow();check(cancelled);}
  }check(cancelled);return out;
 }
 async function verifyGaussianSamples(src,values,w,h,k,cancelled){
  // Check the actual result on every call, including a lamp away from the
  // fixed coordinates. Only sampled horizontal rows are computed on CPU;
  // Float32 rounding matches the original two-pass intermediate and output.
  let hi=0,lo=0;for(let i=0;i<values.length;i++){if(!Number.isFinite(src[i])||!Number.isFinite(values[i]))throw new Error('红晕 GPU 数值校验未通过');if(src[i]>src[hi])hi=i;if(src[i]<src[lo])lo=i;}
  const points=new Set([0,w-1,(h-1)*w,w*h-1,Math.floor(h/2)*w+Math.floor(w/2),Math.floor(2*h/3)*w+Math.floor(w/3),Math.floor(h/3)*w+Math.floor(2*w/3),Math.min(2,h-1)*w+Math.min(1,w-1),Math.max(0,h-3)*w+Math.max(0,w-2),hi,lo]);let deadline=performance.now()+6;
  for(const index of points){check(cancelled);const x=index%w,y=Math.floor(index/w);let value=0;
   for(let j=-k.radius;j<=k.radius;j++){const row=mirror(y+j,h)*w;let horizontal=0;
    for(let i=-k.radius;i<=k.radius;i++)horizontal+=src[row+mirror(x+i,w)]*k.data[i+k.radius];value+=Math.fround(horizontal)*k.data[j+k.radius];
    if((j+k.radius)%16===15&&performance.now()>=deadline){await yieldNow();check(cancelled);deadline=performance.now()+6;}
   }
   const expected=Math.fround(value);if(!Number.isFinite(expected)||Math.abs(values[index]-expected)>2e-6*Math.max(1,Math.abs(expected)))throw new Error('红晕 GPU 数值校验未通过');
  }check(cancelled);
 }
 function fftPlan(n){
  const rev=new Uint32Array(n),co=new Float32Array(n/2),si=new Float32Array(n/2);
  for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;rev[i]=j;}
  for(let i=0;i<n/2;i++){co[i]=Math.cos(2*Math.PI*i/n);si[i]=Math.sin(2*Math.PI*i/n);}return {n,rev,co,si};
 }
 function fftLine(re,im,offset,stride,p,inverse){
  for(let i=0;i<p.n;i++){const j=p.rev[i];if(j>i){const a=offset+i*stride,b=offset+j*stride,t=re[a],u=im[a];re[a]=re[b];im[a]=im[b];re[b]=t;im[b]=u;}}
  for(let len=2;len<=p.n;len*=2){const half=len/2,step=p.n/len;
   for(let a=0;a<p.n;a+=len)for(let j=0;j<half;j++){const k=j*step,c=p.co[k],s=inverse?p.si[k]:-p.si[k],u=offset+(a+j)*stride,v=u+half*stride,vr=re[v]*c-im[v]*s,vi=re[v]*s+im[v]*c,ur=re[u],ui=im[u];re[u]=ur+vr;im[u]=ui+vi;re[v]=ur-vr;im[v]=ui-vi;}
  }
  if(inverse)for(let i=0;i<p.n;i++){const j=offset+i*stride;re[j]/=p.n;im[j]/=p.n;}
 }
 async function fft2(re,im,w,h,px,py,inverse,cancelled){
  for(let y=0;y<h;y++){fftLine(re,im,y*w,1,px,inverse);if(y%16===15){await yieldNow();check(cancelled);}}
  for(let x=0;x<w;x++){fftLine(re,im,x,w,py,inverse);if(x%16===15){await yieldNow();check(cancelled);}}
 }
 async function convolveCPU(src,w,h,k,cancelled){
  const r=k.radius;let W=1,H=1;while(W<w+2*r)W*=2;while(H<h+2*r)H*=2;
  const re=new Float32Array(W*H),im=new Float32Array(W*H),kr=new Float32Array(W*H),ki=new Float32Array(W*H),px=fftPlan(W),py=fftPlan(H);
  for(let y=0;y<h+2*r;y++)for(let x=0;x<w+2*r;x++)re[y*W+x]=src[mirror(y-r,h)*w+mirror(x-r,w)];
  for(let y=-r;y<=r;y++)for(let x=-r;x<=r;x++)kr[((y+H)%H)*W+(x+W)%W]=k.data[(y+r)*(2*r+1)+x+r];
  await fft2(re,im,W,H,px,py,false,cancelled);await fft2(kr,ki,W,H,px,py,false,cancelled);
  for(let i=0;i<re.length;i++){const a=re[i]*kr[i]-im[i]*ki[i];im[i]=re[i]*ki[i]+im[i]*kr[i];re[i]=a;}
  await fft2(re,im,W,H,px,py,true,cancelled);const out=new Float32Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)out[y*w+x]=re[(y+r)*W+x+r];check(cancelled);return out;
 }
 // Float32 Stockham/DIT backend extracted from mobile-film.js. Two packed
 // complex transforms (photo channel and PSF) share RG/BA. 1024-square limit.
 const VERT='#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
 const INIT=`#version 300 es
 precision highp float;precision highp int;precision highp sampler2D;
 out vec4 frag;uniform sampler2D src;uniform sampler2D kernel;uniform ivec2 size;uniform ivec2 fftSize;uniform int radius;uniform int multiply;
 int reverseIndex(int v,int n){int r=0;for(int k=1;k<n;k*=2){r=r*2+(v&1);v>>=1;}return r;}
 int mirror(int i,int n){if(n<=1)return 0;int period=2*n-2,k=((i%period)+period)%period;return min(k,period-k);}
 void main(){ivec2 q=ivec2(gl_FragCoord.xy);q=ivec2(reverseIndex(q.x,fftSize.x),reverseIndex(q.y,fftSize.y));
 if(multiply==1){vec4 v=texelFetch(src,q,0);frag=vec4(v.x*v.z-v.y*v.w,v.x*v.w+v.y*v.z,0,0);return;}
 float a=0.,b=0.;if(all(lessThan(q,size+2*radius))){ivec2 v=ivec2(mirror(q.x-radius,size.x),mirror(q.y-radius,size.y));a=texelFetch(src,v,0).r;}
 ivec2 k=ivec2(q.x>fftSize.x/2?q.x-fftSize.x:q.x,q.y>fftSize.y/2?q.y-fftSize.y:q.y);if(all(lessThanEqual(abs(k),ivec2(radius))))b=texelFetch(kernel,k+radius,0).r;frag=vec4(a,0,b,0);}`;
 const FFT=`#version 300 es
 precision highp float;precision highp int;precision highp sampler2D;
 out vec4 frag;uniform sampler2D src;uniform int axis;uniform int span;uniform int inverse;
 vec2 mul(vec2 a,vec2 b){return vec2(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
 void main(){ivec2 q=ivec2(gl_FragCoord.xy);int v=axis==0?q.x:q.y,halfSpan=span/2,j=v%halfSpan,base=(v/span)*span+j;ivec2 a=q,b=q;if(axis==0){a.x=base;b.x=base+halfSpan;}else{a.y=base;b.y=base+halfSpan;}
 float angle=6.283185307179586*float(j)/float(span)*(inverse==1?1.:-1.);vec2 z=vec2(cos(angle),sin(angle));vec4 av=texelFetch(src,a,0),bv=texelFetch(src,b,0),t=vec4(mul(bv.xy,z),mul(bv.zw,z));frag=(av+(v%span<halfSpan?t:-t))*(inverse==1?.5:1.);}`;
 const OUTPUT=`#version 300 es\nprecision highp float;precision highp int;precision highp sampler2D;out vec4 frag;uniform sampler2D src;uniform int radius;void main(){float v=texelFetch(src,ivec2(gl_FragCoord.xy)+radius,0).r;frag=vec4(v,0,0,1);}`;
 const INIT_RGB=`#version 300 es
 precision highp float;precision highp int;precision highp sampler2D;
 out vec4 frag;uniform sampler2D src;uniform sampler2D kernel;uniform sampler2D spectrum;uniform ivec2 size;uniform ivec2 fftSize;uniform int radius;uniform int mode;uniform int kernelRGB;
 int reverseIndex(int v,int n){int r=0;for(int k=1;k<n;k*=2){r=r*2+(v&1);v>>=1;}return r;}
 int mirror(int i,int n){if(n<=1)return 0;int period=2*n-2,k=((i%period)+period)%period;return min(k,period-k);}
 vec2 mul(vec2 a,vec2 b){return vec2(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
 vec2 conjugate(vec2 a){return vec2(a.x,-a.y);}
 void main(){ivec2 q=ivec2(gl_FragCoord.xy);q=ivec2(reverseIndex(q.x,fftSize.x),reverseIndex(q.y,fftSize.y));
 if(mode==2){vec4 a=texelFetch(src,q,0),k=texelFetch(spectrum,q,0);if(kernelRGB==0){frag=vec4(mul(a.rg,k.rg),mul(a.ba,k.ba));return;}
  // Two real planes share each complex transform. Separate R/G using the
  // conjugate opposite-frequency sample, multiply by their independent
  // spectra, then pack the two real convolutions back into one complex pair.
  ivec2 opposite=ivec2((fftSize.x-q.x)%fftSize.x,(fftSize.y-q.y)%fftSize.y);
  vec2 ac=conjugate(texelFetch(src,opposite,0).rg),kc=conjugate(texelFetch(spectrum,opposite,0).rg),ad=a.rg-ac,kd=k.rg-kc;
  vec2 ar=.5*(a.rg+ac),ag=.5*vec2(ad.y,-ad.x),kr=.5*(k.rg+kc),kg=.5*vec2(kd.y,-kd.x),rr=mul(ar,kr),gg=mul(ag,kg);
  frag=vec4(rr+vec2(-gg.y,gg.x),mul(a.ba,k.ba));return;}
 if(mode==1){ivec2 k=ivec2(q.x>fftSize.x/2?q.x-fftSize.x:q.x,q.y>fftSize.y/2?q.y-fftSize.y:q.y);vec3 v=vec3(0);if(all(lessThanEqual(abs(k),ivec2(radius)))){vec4 value=texelFetch(kernel,k+radius,0);v=kernelRGB==1?value.rgb:vec3(value.r);}frag=kernelRGB==1?vec4(v,0):vec4(v.r,0,v.r,0);return;}
 vec3 a=vec3(0);if(all(lessThan(q,size+2*radius))){ivec2 v=ivec2(mirror(q.x-radius,size.x),mirror(q.y-radius,size.y));a=texelFetch(src,v,0).rgb;}frag=vec4(a,0);}`;
 const OUTPUT_RGB=`#version 300 es\nprecision highp float;precision highp int;precision highp sampler2D;out vec4 frag;uniform sampler2D src;uniform int radius;void main(){frag=vec4(texelFetch(src,ivec2(gl_FragCoord.xy)+radius,0).rgb,1);}`;
 const GAUSSIAN=`#version 300 es
 precision highp float;precision highp int;precision highp sampler2D;
 out vec4 frag;uniform sampler2D src;uniform sampler2D weights;uniform ivec2 size;uniform int axis;uniform int radius;
 int mirror(int i,int n){if(n<=1)return 0;int period=2*n-2,k=((i%period)+period)%period;return min(k,period-k);}
 void main(){ivec2 q=ivec2(gl_FragCoord.xy);float v=0.;for(int j=-radius;j<=radius;j++){ivec2 p=q;if(axis==0)p.x=mirror(p.x+j,size.x);else p.y=mirror(p.y+j,size.y);v+=texelFetch(src,p,0).r*texelFetch(weights,ivec2(j+radius,0),0).r;}frag=vec4(v,0,0,1);}`;
 const GAUSSIAN_RGB=`#version 300 es
 precision highp float;precision highp int;precision highp sampler2D;
 out vec4 frag;uniform sampler2D src;uniform sampler2D weights;uniform ivec2 size;uniform int axis;uniform int radius;uniform int halfMirror;
 int mirror(int i,int n){if(n<=1)return 0;int period=halfMirror==1?2*n:2*n-2,k=((i%period)+period)%period;return min(k,period-k-(halfMirror==1?1:0));}
 void main(){ivec2 q=ivec2(gl_FragCoord.xy);vec3 v=vec3(0.);for(int j=-radius;j<=radius;j++){ivec2 p=q;if(axis==0)p.x=mirror(p.x+j,size.x);else p.y=mirror(p.y+j,size.y);v+=texelFetch(src,p,0).rgb*texelFetch(weights,ivec2(j+radius,0),0).r;}frag=vec4(v,1.);}`;
 function createGPU(){
  const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
  if(!gl||!gl.getExtension('EXT_color_buffer_float')){if(gl){const e=gl.getExtension('WEBGL_lose_context');if(e)e.loseContext();}return null;}
  const vao=gl.createVertexArray(),programs=[],textures=[],fbos=[],spectra=new Map(),uniformLocations=new Map();let disposed=false,peakBytes=0;
  function program(frag){const p=gl.createProgram(),v=gl.createShader(gl.VERTEX_SHADER),f=gl.createShader(gl.FRAGMENT_SHADER);gl.shaderSource(v,VERT);gl.compileShader(v);gl.shaderSource(f,frag);gl.compileShader(f);if(!gl.getShaderParameter(f,gl.COMPILE_STATUS)){const err=gl.getShaderInfoLog(f);gl.deleteShader(v);gl.deleteShader(f);gl.deleteProgram(p);throw new Error(err);}gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);gl.deleteShader(v);gl.deleteShader(f);if(!gl.getProgramParameter(p,gl.LINK_STATUS)){const message=gl.getProgramInfoLog(p);gl.deleteProgram(p);throw new Error(message);}programs.push(p);return p;}
  let init,fft,out,initRGB,outRGB,gauss=null,gaussianFallback='',gaussianVerified=false,gaussRGB=null,gaussianRGBFallback='';try{init=program(INIT);fft=program(FFT);out=program(OUTPUT);initRGB=program(INIT_RGB);outRGB=program(OUTPUT_RGB);}catch(error){dispose();return null;}
  // Gaussian is optional: a driver rejecting its dynamic loop must not
  // disable an otherwise valid FFT/softness GPU backend.
  try{gauss=program(GAUSSIAN);}catch(error){gaussianFallback=error.message;}
  try{gaussRGB=program(GAUSSIAN_RGB);}catch(error){gaussianRGBFallback=error.message;}
  function texture(w,h,format,data){const t=gl.createTexture();textures.push(t);gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,format,w,h,0,format===gl.R32F?gl.RED:gl.RGBA,gl.FLOAT,data);return t;}
  function location(p,name){let locations=uniformLocations.get(p);if(!locations){locations=new Map();uniformLocations.set(p,locations);}if(!locations.has(name))locations.set(name,gl.getUniformLocation(p,name));return locations.get(name);}
  function bind(p,name,unit,t){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);gl.uniform1i(location(p,name),unit);}
  async function convolve(src,w,h,k,cancelled){
   if(disposed||gl.isContextLost())throw new Error('光学GPU已释放');check(cancelled);const r=k.radius;let W=1,H=1;while(W<w+2*r)W*=2;while(H<h+2*r)H*=2;if(W>1024||H>1024)throw new Error('光学FFT缓冲超出预算');
   const start=textures.length,fbo=gl.createFramebuffer(),checked=new Set();fbos.push(fbo);let sync=null;
   try{
    const input=texture(w,h,gl.R32F,src),kt=texture(2*r+1,2*r+1,gl.R32F,k.data);let a=texture(W,H,gl.RGBA32F,null),b=texture(W,H,gl.RGBA32F,null);const result=texture(w,h,gl.RGBA32F,null);
    peakBytes=Math.max(peakBytes,2*W*H*16+w*h*20+k.data.byteLength);
    function draw(p,t,ww,hh){check(cancelled);if(disposed||gl.isContextLost())throw new Error('光学GPU已释放');gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);if(!checked.has(t)){if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('光学浮点缓冲不可用');checked.add(t);}gl.useProgram(p);gl.bindVertexArray(vao);gl.viewport(0,0,ww,hh);gl.drawArrays(gl.TRIANGLES,0,3);}
    function initialize(t,target,multiply){gl.useProgram(init);bind(init,'src',0,t);bind(init,'kernel',1,kt);gl.uniform2i(location(init,'size'),w,h);gl.uniform2i(location(init,'fftSize'),W,H);gl.uniform1i(location(init,'radius'),r);gl.uniform1i(location(init,'multiply'),multiply);draw(init,target,W,H);}
    async function transform(inverse){let deadline=performance.now()+6;for(let axis=0;axis<2;axis++)for(let span=2;span<=(axis===0?W:H);span*=2){gl.useProgram(fft);bind(fft,'src',0,a);gl.uniform1i(location(fft,'axis'),axis);gl.uniform1i(location(fft,'span'),span);gl.uniform1i(location(fft,'inverse'),inverse);draw(fft,b,W,H);const t=a;a=b;b=t;if(performance.now()>=deadline){gl.flush();await yieldNow();check(cancelled);deadline=performance.now()+6;}}}
    initialize(input,a,0);await transform(0);initialize(a,b,1);{const t=a;a=b;b=t;}await transform(1);gl.useProgram(out);bind(out,'src',0,a);gl.uniform1i(location(out,'radius'),r);draw(out,result,w,h);
    sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();if(!sync)throw new Error('光学GPU同步失败');const deadline=performance.now()+30000;
    for(;;){check(cancelled);const status=gl.clientWaitSync(sync,0,0);if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)break;if(status===gl.WAIT_FAILED||performance.now()>deadline)throw new Error('光学GPU等待失败');await yieldNow();}
    const rgba=new Float32Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.FLOAT,rgba);if(gl.getError()!==gl.NO_ERROR)throw new Error('光学GPU读取失败');const values=new Float32Array(w*h);for(let i=0;i<values.length;i++)values[i]=rgba[i*4];return values;
   }finally{if(sync)gl.deleteSync(sync);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);fbos.splice(fbos.indexOf(fbo),1);while(textures.length>start)gl.deleteTexture(textures.pop());}
  }
  async function convolveRGB(src,w,h,k,cancelled,pixelOps){
   if(disposed||gl.isContextLost())throw new Error('光学GPU已释放');check(cancelled);const r=k.radius;let W=1,H=1;while(W<w+2*r)W*=2;while(H<h+2*r)H*=2;if(W>1024||H>1024)throw new Error('光学FFT缓冲超出预算');
   const start=textures.length,fbo=gl.createFramebuffer(),checked=new Set();fbos.push(fbo);let sync=null;
   try{
    let rgba;const sourceChannels=src.channels===4?4:3,rgbaOutput=!!(pixelOps&&pixelOps.preferRGBA);
    if(sourceChannels===4){if(src.length!==w*h*4)throw new Error('光学RGBA输入尺寸无效');rgba=src;}
    else if(pixelOps){check(cancelled);rgba=pixelOps.pack(src,w,h,3,w*3,0,0,w,h,false);check(cancelled);}
    else{rgba=new Float32Array(w*h*4);for(let i=0;i<w*h;i++){rgba[i*4]=src[i*3];rgba[i*4+1]=src[i*3+1];rgba[i*4+2]=src[i*3+2];}}
    const input=texture(w,h,gl.RGBA32F,rgba),result=texture(w,h,gl.RGBA32F,null);let a=texture(W,H,gl.RGBA32F,null),b=texture(W,H,gl.RGBA32F,null);
    function draw(p,t,ww,hh){check(cancelled);if(disposed||gl.isContextLost())throw new Error('光学GPU已释放');gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);if(!checked.has(t)){if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('光学浮点缓冲不可用');checked.add(t);}gl.useProgram(p);gl.bindVertexArray(vao);gl.viewport(0,0,ww,hh);gl.drawArrays(gl.TRIANGLES,0,3);}
    function initialize(source,target,mode,kt,spectrum){gl.useProgram(initRGB);bind(initRGB,'src',0,source);bind(initRGB,'kernel',1,kt||input);bind(initRGB,'spectrum',2,spectrum||input);gl.uniform2i(location(initRGB,'size'),w,h);gl.uniform2i(location(initRGB,'fftSize'),W,H);gl.uniform1i(location(initRGB,'radius'),r);gl.uniform1i(location(initRGB,'mode'),mode);gl.uniform1i(location(initRGB,'kernelRGB'),k.channels?1:0);draw(initRGB,target,W,H);}
    async function transform(first,second,inverse){let aa=first,bb=second,deadline=performance.now()+6;for(let axis=0;axis<2;axis++)for(let span=2;span<=(axis===0?W:H);span*=2){gl.useProgram(fft);bind(fft,'src',0,aa);gl.uniform1i(location(fft,'axis'),axis);gl.uniform1i(location(fft,'span'),span);gl.uniform1i(location(fft,'inverse'),inverse);draw(fft,bb,W,H);const t=aa;aa=bb;bb=t;if(performance.now()>=deadline){gl.flush();await yieldNow();check(cancelled);deadline=performance.now()+6;}}return [aa,bb];}
    const skey=k.key+':'+(k.channels?'rgb':'scalar')+':'+W+':'+H;let spectrum=spectra.get(skey),kernelUploadBytes=0;
    if(spectrum){spectra.delete(skey);spectra.set(skey,spectrum);}
    if(!spectrum){
     let kernelData=k.data,kernelFormat=gl.R32F;
     if(k.channels){kernelData=new Float32Array(k.data.length*4);for(let i=0;i<k.data.length;i++){kernelData[i*4]=k.channels[0][i];kernelData[i*4+1]=k.channels[1][i];kernelData[i*4+2]=k.channels[2][i];}kernelFormat=gl.RGBA32F;}
     kernelUploadBytes=kernelData.byteLength;const kt=texture(2*r+1,2*r+1,kernelFormat,kernelData);initialize(input,a,1,kt,null);[a,b]=await transform(a,b,0);
     // Promote completed spectrum to its own bounded cache; canceled kernels
     // never commit. The two photo buffers stay independent of the spectrum.
     check(cancelled);spectrum={texture:a,bytes:W*H*16};textures.splice(textures.indexOf(a),1);
     let bytes=spectrum.bytes;for(const v of spectra.values())bytes+=v.bytes;
     while(spectra.size&&(spectra.size>=3||bytes>16*1024*1024)){const key=spectra.keys().next().value,old=spectra.get(key);bytes-=old.bytes;gl.deleteTexture(old.texture);spectra.delete(key);}
     spectra.set(skey,spectrum);a=texture(W,H,gl.RGBA32F,null);
    }
    initialize(input,a,0,null,null);[a,b]=await transform(a,b,0);initialize(a,b,2,null,spectrum.texture);{const t=a;a=b;b=t;}[a,b]=await transform(a,b,1);
    gl.useProgram(outRGB);bind(outRGB,'src',0,a);gl.uniform1i(location(outRGB,'radius'),r);draw(outRGB,result,w,h);sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();if(!sync)throw new Error('光学GPU同步失败');const deadline=performance.now()+30000;
    for(;;){check(cancelled);const status=gl.clientWaitSync(sync,0,0);if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)break;if(status===gl.WAIT_FAILED||performance.now()>deadline)throw new Error('光学GPU等待失败');await yieldNow();}
    // A direct RGBA source is also needed by the following mix. Readback must
    // use its own storage rather than overwriting the uploaded source tile.
    if(sourceChannels===4)rgba=new Float32Array(w*h*4);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.FLOAT,rgba);if(gl.getError()!==gl.NO_ERROR)throw new Error('光学GPU读取失败');check(cancelled);
    if(rgbaOutput){rgba.channels=4;let retained=0;for(const v of spectra.values())retained+=v.bytes;peakBytes=Math.max(peakBytes,retained+2*W*H*16+w*h*32+kernelUploadBytes);return rgba;}
    const values=new Float32Array(w*h*3);
    if(pixelOps){check(cancelled);pixelOps.unpack(rgba,w,h,values,w,0,0,false);check(cancelled);}
    else for(let i=0;i<w*h;i++){values[i*3]=rgba[i*4];values[i*3+1]=rgba[i*4+1];values[i*3+2]=rgba[i*4+2];}
    let retained=0;for(const v of spectra.values())retained+=v.bytes;peakBytes=Math.max(peakBytes,retained+2*W*H*16+w*h*32+kernelUploadBytes);return values;
   }finally{if(sync)gl.deleteSync(sync);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);fbos.splice(fbos.indexOf(fbo),1);while(textures.length>start)gl.deleteTexture(textures.pop());}
  }
  async function gaussianRGB(src,w,h,plan,cancelled,pixelOps){
   if(disposed||gl.isContextLost())throw new Error('光学GPU已释放');check(cancelled);const axes=nearAxes(plan);
   if(!gaussRGB||gaussianRGBFallback)return gaussianRGBCPU(src,w,h,axes,cancelled);
   if(w>gl.getParameter(gl.MAX_TEXTURE_SIZE)||h>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw new Error('柔光Gaussian缓冲超出预算');
   const start=textures.length,fbo=gl.createFramebuffer();fbos.push(fbo);let sync=null;
   try{
    const sc=src.channels===4?4:3;if(src.length!==w*h*sc)throw new Error('柔光RGB输入尺寸无效');
    let rgba;if(sc===4)rgba=src;else{rgba=new Float32Array(w*h*4);for(let i=0;i<w*h;i++){rgba[i*4]=src[i*3];rgba[i*4+1]=src[i*3+1];rgba[i*4+2]=src[i*3+2];}}
    const input=texture(w,h,gl.RGBA32F,rgba),mid=texture(w,h,gl.RGBA32F,null),output=texture(w,h,gl.RGBA32F,null),weightsX=texture(axes.x.data.length,1,gl.R32F,axes.x.data),weightsY=axes.x===axes.y?weightsX:texture(axes.y.data.length,1,gl.R32F,axes.y.data);
    gl.useProgram(gaussRGB);gl.bindVertexArray(vao);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.uniform2i(location(gaussRGB,'size'),w,h);gl.uniform1i(location(gaussRGB,'halfMirror'),axes.halfMirror?1:0);gl.viewport(0,0,w,h);
    for(let axis=0;axis<2;axis++){check(cancelled);const k=axis===0?axes.x:axes.y;bind(gaussRGB,'weights',1,axis===0?weightsX:weightsY);gl.uniform1i(location(gaussRGB,'radius'),k.radius);bind(gaussRGB,'src',0,axis===0?input:mid);gl.uniform1i(location(gaussRGB,'axis'),axis);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,axis===0?mid:output,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('光学浮点缓冲不可用');gl.drawArrays(gl.TRIANGLES,0,3);}
    sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();if(!sync)throw new Error('光学GPU同步失败');const deadline=performance.now()+30000;
    for(;;){check(cancelled);if(disposed||gl.isContextLost())throw new Error('光学GPU已释放');const status=gl.clientWaitSync(sync,0,0);if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)break;if(status===gl.WAIT_FAILED||performance.now()>deadline)throw new Error('光学GPU等待失败');await yieldNow();}
    check(cancelled);const valuesRGBA=new Float32Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.FLOAT,valuesRGBA);if(gl.getError()!==gl.NO_ERROR)throw new Error('光学GPU读取失败');
    valuesRGBA.channels=4;await verifyGaussianRGB(src,valuesRGBA,w,h,axes,cancelled);let retained=0;for(const value of spectra.values())retained+=value.bytes;peakBytes=Math.max(peakBytes,retained+w*h*48+axes.x.data.byteLength+axes.y.data.byteLength);
    if(pixelOps&&pixelOps.preferRGBA)return valuesRGBA;
    const values=new Float32Array(w*h*3);for(let i=0;i<w*h;i++){values[i*3]=valuesRGBA[i*4];values[i*3+1]=valuesRGBA[i*4+1];values[i*3+2]=valuesRGBA[i*4+2];}check(cancelled);return values;
   }finally{if(sync)gl.deleteSync(sync);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);fbos.splice(fbos.indexOf(fbo),1);while(textures.length>start)gl.deleteTexture(textures.pop());}
  }
  async function drawGaussian(src,w,h,k,cancelled){
   if(disposed||gl.isContextLost())throw new Error('光学GPU已释放');check(cancelled);
   const start=textures.length,fbo=gl.createFramebuffer(),checked=new Set();fbos.push(fbo);let sync=null;
   try{const input=texture(w,h,gl.R32F,src),mid=texture(w,h,gl.RGBA32F,null),output=texture(w,h,gl.RGBA32F,null),weights=texture(k.data.length,1,gl.R32F,k.data);
    gl.useProgram(gauss);bind(gauss,'weights',1,weights);gl.bindVertexArray(vao);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.uniform2i(location(gauss,'size'),w,h);gl.uniform1i(location(gauss,'radius'),k.radius);gl.viewport(0,0,w,h);
    for(let axis=0;axis<2;axis++){check(cancelled);bind(gauss,'src',0,axis===0?input:mid);gl.uniform1i(location(gauss,'axis'),axis);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,axis===0?mid:output,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('光学浮点缓冲不可用');gl.drawArrays(gl.TRIANGLES,0,3);}
    sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();if(!sync)throw new Error('光学GPU同步失败');const deadline=performance.now()+30000;
    for(;;){check(cancelled);if(disposed||gl.isContextLost())throw new Error('光学GPU已释放');const status=gl.clientWaitSync(sync,0,0);if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)break;if(status===gl.WAIT_FAILED||performance.now()>deadline)throw new Error('光学GPU等待失败');await yieldNow();}
    check(cancelled);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,output,0);const rgba=new Float32Array(w*h*4),values=new Float32Array(w*h);gl.readPixels(0,0,w,h,gl.RGBA,gl.FLOAT,rgba);if(gl.getError()!==gl.NO_ERROR)throw new Error('光学GPU读取失败');for(let i=0;i<values.length;i++)values[i]=rgba[i*4];let retained=0;for(const value of spectra.values())retained+=value.bytes;peakBytes=Math.max(peakBytes,retained+w*h*36+k.data.byteLength);check(cancelled);return values;
   }finally{if(sync)gl.deleteSync(sync);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);fbos.splice(fbos.indexOf(fbo),1);while(textures.length>start)gl.deleteTexture(textures.pop());}
  }
  async function gaussianGPU(src,w,h,sigma,cancelled){
   if(disposed||gl.isContextLost())throw new Error('光学GPU已释放');check(cancelled);const k=gaussianKernel(Math.max(.35,sigma));if(!gauss||gaussianFallback||k.radius>64)return gaussian(src,w,h,sigma,cancelled);
   if(!gaussianVerified){
    // Qualify the real texture, both axes, reflected edges and Float32
    // readback. Compilation alone cannot detect a finite driver error.
    const probe=new Float32Array(35);for(let i=0;i<probe.length;i++)probe[i]=((i*19)%37)/11-.55;probe[0]=1.75;probe[17]=-1.25;probe[33]=.03125;
    const actual=await drawGaussian(probe,7,5,k,cancelled),expected=await gaussian(probe,7,5,sigma,cancelled);check(cancelled);
    for(let i=0;i<probe.length;i++)if(!Number.isFinite(actual[i])||Math.abs(actual[i]-expected[i])>2e-6*Math.max(1,Math.abs(expected[i])))throw new Error('红晕 GPU 数值校验未通过');
    check(cancelled);gaussianVerified=true;
   }
   const values=await drawGaussian(src,w,h,k,cancelled);await verifyGaussianSamples(src,values,w,h,k,cancelled);check(cancelled);return values;
  }
  function dispose(){if(disposed)return;disposed=true;for(const t of textures)gl.deleteTexture(t);for(const f of fbos)gl.deleteFramebuffer(f);for(const p of programs)gl.deleteProgram(p);gl.deleteVertexArray(vao);textures.length=fbos.length=0;uniformLocations.clear();for(const v of spectra.values())gl.deleteTexture(v.texture);spectra.clear();const e=gl.getExtension('WEBGL_lose_context');if(e)e.loseContext();canvas.width=canvas.height=1;}
  return {convolve,convolveRGB,gaussianRGB,gaussian:gaussianGPU,disableGaussian:message=>{gaussianFallback=message;},disableGaussianRGB:message=>{gaussianRGBFallback=message;},dispose,get nearGaussianPath(){return gaussRGB&&!gaussianRGBFallback?'webgl2':'cpu';},get nearGaussianFallback(){return gaussianRGBFallback;},get gaussianPath(){return gauss&&!gaussianFallback?'webgl2':'cpu';},get gaussianFallback(){return gaussianFallback;},get peakBytes(){return peakBytes;}};
 }
 function createBackend(forceCPU){let gpu=forceCPU?null:createGPU(),fallback='',released=false;const guard=cancelled=>()=>released||(cancelled&&cancelled());return {
  async convolve(src,w,h,k,cancelled){const stop=guard(cancelled);check(stop);if(gpu){try{return await gpu.convolve(src,w,h,k,stop);}catch(error){check(stop);fallback=error.message;gpu.dispose();gpu=null;}}return convolveCPU(src,w,h,k,stop);},
  async convolveRGB(src,w,h,k,cancelled,pixelOps){const stop=guard(cancelled);check(stop);if(gpu){try{return await gpu.convolveRGB(src,w,h,k,stop,pixelOps);}catch(error){check(stop);fallback=error.message;gpu.dispose();gpu=null;}}const result=new Float32Array(w*h*3);for(let ch=0;ch<3;ch++){check(stop);const plane=new Float32Array(w*h);for(let i=0;i<plane.length;i++)plane[i]=src[i*(src.channels===4?4:3)+ch];const channelKernel=k.channels?{radius:k.radius,data:k.channels[ch]}:k,convolved=await convolveCPU(plane,w,h,channelKernel,stop);for(let i=0;i<plane.length;i++)result[i*3+ch]=convolved[i];}return result;},
  async gaussianRGB(src,w,h,k,cancelled,pixelOps){const stop=guard(cancelled);check(stop);if(gpu){try{return await gpu.gaussianRGB(src,w,h,k,stop,pixelOps);}catch(error){check(stop);fallback=error.message;gpu.disableGaussianRGB(error.message);}}return gaussianRGBCPU(src,w,h,k,stop);},
  async gaussian(src,w,h,sigma,cancelled){const stop=guard(cancelled);check(stop);if(gpu){try{return await gpu.gaussian(src,w,h,sigma,stop);}catch(error){check(stop);gpu.disableGaussian(error.message);}}return gaussian(src,w,h,sigma,stop);},
  get path(){return gpu?'webgl2':'cpu';},get nearGaussianPath(){return gpu?gpu.nearGaussianPath:'cpu';},get nearGaussianFallback(){return gpu?gpu.nearGaussianFallback:'';},get gaussianPath(){return gpu?gpu.gaussianPath:'cpu';},get fallback(){return fallback;},get gaussianFallback(){return gpu?gpu.gaussianFallback:'';},get peakBytes(){return gpu?gpu.peakBytes:0;},release(){released=true;wake();if(gpu)gpu.dispose();gpu=null;}
 };}
 return {kernel,components,profile,transport,mirror,gaussian,convolveCPU,createBackend,areaBasis,family,scatterAmount,gaussianAxis,gaussianRGBCPU,endpointNormalization,normalizeNearField};
})();
if(typeof window!=='undefined')window.FilmifyTextureOptics=FilmifyTextureOptics;
if(typeof module!=='undefined'&&module.exports)module.exports=FilmifyTextureOptics;
