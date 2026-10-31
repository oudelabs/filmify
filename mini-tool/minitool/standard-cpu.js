/* Fotufilm Standard (.clumpField), fixed 54064ece.
 * Engine Apache-2.0, MUAStudio Inc.; profile parameters retain their notices.
 * Finished-photo texture adapter: true seeded Poisson/normal field, layer correlation,
 * source-frame Gaussian filtering and calibrated density modulation.
 * No Film tiles, quantile approximations, custom grain look or RGB overlay. */
'use strict';
const FilmifyStandardCPU=(function(){
 const f=Math.fround,phi=x=>Math.exp(-.5*x*x)/Math.sqrt(2*Math.PI);
 function polynomial(x,c){let y=c[0];for(let i=1;i<c.length;i++)y=y*x+c[i];return y;}
 function polynomialOne(x,c){let y=x+c[0];for(let i=1;i<c.length;i++)y=y*x+c[i];return y;}
 // Double-precision erf/erfc rational approximants (Cephes). Host covariance
 // remains Double until its native Float32 configuration boundary.
 function erf(x){
  const z=Math.abs(x);if(z>1)return x<0?erfc(z)-1:1-erfc(z);
  const t=[9.60497373987051638749,90.0260197203842689217,2232.00534594684319226,7003.32514112805075473,55592.3013010394962768];
  const u=[33.5617141647503099647,521.357949780152679795,4594.32382970980127987,22629.0000613890934246,49267.3942608635921086];
  return x*polynomial(x*x,t)/polynomialOne(x*x,u);
 }
 function erfc(x){
  if(x<1)return 1-erf(x);if(x>27)return 0;
  const p=x<8?[2.46196981473530512524e-10,.564189564831068821977,7.46321056442269912687,48.6371970985681366614,196.520832956077098242,526.445194995477358631,934.52852717195760754,1027.55188689515710272,557.535335369399327526]:[.564189583547755073984,1.27536670759978104416,5.01905042251180477414,6.16021097993053585195,7.4097426995044893916,2.9788666537210024067];
  const q=x<8?[13.2281951154744992508,86.7072140885989742329,354.937778887819891062,975.708501743205489753,1823.90916687909736289,2246.33760818710981792,1656.66309194161350182,557.535340817727675546]:[2.2605286322011727659,9.39603524938001434673,12.0489539808096656605,17.0814450747565897222,9.60896809063285878198,3.3690764510008151605];
  return Math.exp(-x*x)*polynomial(x,p)/polynomialOne(x,q);
 }
 function gaussianRadius(sigma){
  sigma=f(sigma);if(sigma<=f(.15))return 0;
  const variance=f(f(2*sigma)*sigma),limit=Math.ceil(f(4*sigma))+1,tail=new Float32Array(limit);let sum=f(0);
  for(let k=1;k<=limit;k++){tail[k-1]=f(Math.exp(f(-f(k*k)/variance)));sum=f(sum+tail[k-1]);}
  const total=f(1+f(2*sum));let dropped=f(0);
  for(let radius=limit;radius>=1;radius--){dropped=f(dropped+f(2*tail[radius-1]));if(dropped>f(f(.0027)*total))return radius;}
  return 1;
 }
 function sampledCorrelation(sigma){
  const radius=gaussianRadius(sigma);if(radius<=0||sigma<=0)return 0;
  const taps=[];for(let k=-radius;k<=radius;k++)taps.push(Math.exp(-(k*k)/(2*sigma*sigma)));
  let zero=0,one=0;for(let k=0;k<taps.length;k++)zero+=taps[k]*taps[k];for(let k=0;k<taps.length-1;k++)one+=taps[k]*taps[k+1];
  return zero>0?f(one/zero):0;
 }
 function covariance(position,sigma){
  const s=Math.sqrt(Math.max(2*sigma*sigma,1e-8)),z=x=>(x-position)/s,cdf=x=>.5*(1+erf(x/Math.sqrt(2)));
  return f((1+position)*(cdf(z(0))-cdf(z(-1)))+(1-position)*(cdf(z(1))-cdf(z(0)))+s*(phi(z(-1))-2*phi(z(0))+phi(z(1))));
 }
 function discreteSigma(clump,floor){
  // .texture grain-only has no enlarger residual: fold=0, keep=1. Mirror the
  // Float multiplication/sqrt the native read closure performs even here.
  const sigma=f(Math.sqrt(f(clump*clump))),r0=covariance(0,sigma),r1=covariance(1,sigma),target=r0>0?f(r1/r0):0;
  if(target<=0)return f(floor);let high=f(1),low=f(floor);
  while(sampledCorrelation(high)<target&&high<64)high=f(high*2);
  if(sampledCorrelation(low)>=target)return low;
  for(let i=0;i<40;i++){const middle=f(f(.5)*f(low+high));if(sampledCorrelation(middle)<target)low=middle;else high=middle;}
  return f(f(.5)*f(low+high));
 }
 function configuration(width,height,formatMm,meta,options){
  options=options||{};
  meta=meta||(typeof window!=='undefined'?window.FilmifyStandardData:null);if(!meta)throw new Error('Standard metadata尚未准备');
  const explicit=Number(options.frameHeightMm),frameHeightMM=Number.isFinite(explicit)&&explicit>0?explicit:formatMm===60?56:formatMm===120?95:24,pxPerMM=f(f(Math.min(width,height))/f(frameHeightMM));
  const clumps=meta.grainClumpsPerMM2,ratios=meta.grainLayerSizeRatio,aperture=meta.apertureResponse||meta.granularityApertureResponse;
  const sigmaLayer=[],grainStrength=[];
  for(let c=0;c<3;c++){
   const clumpMM=f(meta.grainClumpSigmaMM*ratios[c]);sigmaLayer.push(discreteSigma(f(clumpMM*pxPerMM),meta.sigmaFloorPixels||.151));
   const apertureBase=f(f(Math.sqrt(f(Math.PI)))*f(meta.granularityApertureRadiusMM)),apertureScale=f(f(apertureBase*pxPerMM)/aperture[c]);
   grainStrength.push(f(f(f(meta.grainStrength*f(meta.defaultGrainScale===undefined?1:meta.defaultGrainScale))*meta.grainLayerWeights[c])*apertureScale));
  }
  const amount=options.amount===undefined?1:options.amount;for(let c=0;c<3;c++)grainStrength[c]=f(grainStrength[c]*amount);
  return {sourceWidth:width,sourceHeight:height,formatMm,frameHeightMM,pxPerMM,grainMode:0,grainStrength,sigmaLayer,radius:gaussianRadius(Math.max.apply(null,sigmaLayer)),lambda:f(clumps/f(pxPerMM*pxPerMM)),correlation:f(1-(1-meta.grainLumaCorrelation)*Math.pow(options.chroma===undefined?1:options.chroma,2)),anchor:meta.grainAnchor.map(f),fog:[0,1,2].map(()=>f(meta.grainFogDensity)),grainLaw:meta.grainLaw,densityRecords:meta.grainDensityRecords.map(row=>row.map(f)),reversalProfile:meta.grainReversalProfile||[.7,1],dMin:meta.dMin,densityRange:meta.densityRange,monochrome:!!meta.monochrome,neutral:options.chroma===0,mottleShare:0,normalizedKernel:false};
 }
 function pcg(value){const state=(Math.imul(value,747796405)+2891336453)>>>0,word=Math.imul((state>>>((state>>>28)+4))^state,277803737)>>>0;return ((word>>>22)^word)>>>0;}
 function pixelHash(x,y,seed,layer){return pcg((x>>>0)^pcg((y>>>0)^pcg((seed>>>0)^Math.imul(layer,0x9e3779b9))));}
 function gaussianHash(hash){
  const u1=f(f((hash>>>8)*f(1/16777216))+f(1e-7)),u2=f((pcg(hash)>>>8)*f(1/16777216));
  return f(f(Math.sqrt(f(-2*f(Math.log(u1)))))*f(Math.cos(f(f(2*f(Math.PI))*u2))));
 }
 function poissonHash(initial,lambda,parameters){
  if(lambda>=16)return gaussianHash(initial);
  let hash=initial,product=f(1),trials=0;const limit=parameters?parameters.poissonLimit:f(Math.exp(f(-lambda)));
  // Once inactive, the native select keeps product/trials forever and every
  // subsequent hash is discarded. Skip only these unobservable calculations.
  for(let i=0;i<32;i++){if(product<=limit)break;hash=pcg(hash);const uniform=f((hash>>>8)*f(1/16777216));product=f(product*uniform);trials++;}
  return f(f(Math.max(trials-1,0)-lambda)/(parameters?parameters.poissonSD:f(Math.sqrt(Math.max(lambda,f(1e-4))))));
 }
 function variance(density,row,law,reversal){
  const d=f(density);
  if(law>2.5){const power=f(Math.pow(f(d/Math.max(f(reversal[1]),f(1e-4))),f(2*f(reversal[0]))));return f(power/f(1+power));}
  if(law>1.5)return d;
  if(law>.5)return f(d*f(Math.pow(f(10),f(f(f(.21004)*d)+f(f(f(.06114)*d)*d)))));
  const offset=f(f(d-row[4])/Math.max(row[5],f(1e-4)));
  const toe=f(1-f(Math.exp(f(-d/Math.max(row[1],f(1e-4))))));
  const bracket=f(f(1+f(row[0]*f(Math.exp(f(-d/Math.max(row[2],f(1e-4)))))))+f(row[3]*f(Math.exp(f(f(-.5*offset)*offset)))));
  return f(toe*bracket);
 }
 function densityModulation(config,c,density,anchorVariance){
  const range=config.densityRange[c],net=f(Math.max(0,Math.min(1,f(f(f(density)-config.dMin[c])/range)))*range),fog=config.fog[c];
  const anchor=Math.max(f(config.anchor[c]+fog),f(1e-4)),here=f(Math.max(net,0)+fog),row=config.densityRecords[c];
  const base=anchorVariance===undefined?variance(anchor,row,config.grainLaw,config.reversalProfile||[.7,1]):anchorVariance,v=variance(here,row,config.grainLaw,config.reversalProfile||[.7,1]);
  return f(Math.sqrt(Math.max(f(v/Math.max(base,f(config.grainLaw>2.5?1e-20:1e-6))),0)));
 }
 function kernels(config){
  const list=[];for(let c=0;c<3;c++){
   const sigma=f(config.sigmaLayer[c]),denominator=f(f(2*sigma)*sigma),values=new Float32Array(config.radius*2+1);let sum=f(0);
   for(let k=-config.radius;k<=config.radius;k++){const v=f(Math.exp(f(-f(k*k)/denominator)));values[k+config.radius]=v;sum=f(sum+v);}
   if(config.normalizedKernel)for(let i=0;i<values.length;i++)values[i]=f(values[i]/sum);list.push(values);
  }return list;
 }
 function noiseParameters(config){const rho=f(Math.max(0,Math.min(1,config.correlation)));return {lambda:f(config.lambda),poissonLimit:f(Math.exp(f(-config.lambda))),poissonSD:f(Math.sqrt(Math.max(config.lambda,f(1e-4)))),ownGain:f(Math.sqrt(f(1-rho))),sharedGain:f(Math.sqrt(rho))};}
 function anchorVariances(config){return [0,1,2].map(c=>variance(Math.max(f(config.anchor[c]+config.fog[c]),f(1e-4)),config.densityRecords[c],config.grainLaw,config.reversalProfile||[.7,1]));}
 function create(config,seed){
  const width=config.sourceWidth,height=config.sourceHeight,radius=config.radius,weights=kernels(config),parameters=noiseParameters(config),own=parameters.ownGain,shared=parameters.sharedGain,anchors=anchorVariances(config),draw=hash=>poissonHash(hash,config.lambda,parameters);
  let active=null,disposed=false,temporaryBytes=0,fieldKeys=new Uint32Array(4),rowKeys=new Uint32Array(4);
  for(let c=0;c<4;c++)fieldKeys[c]=pcg((seed>>>0)^Math.imul(c,0x9e3779b9));
  function noise(x,y,c,sharedValue){const common=sharedValue===undefined?(config.monochrome?gaussianHash(pixelHash(x,y,seed,3)):draw(pixelHash(x,y,seed,3))):sharedValue;if(config.monochrome)return common;return f(f(own*draw(pixelHash(x,y,seed,c)))+f(shared*common));}
  async function tile(x,y,w,h,control){
   if(disposed)throw new Error('已取消');control=control||{};const check=()=>{if(disposed)throw new Error('已取消');if(control.check)control.check();};check();
   if(active)active.dispose();const nx0=Math.max(0,x-radius),nx1=Math.min(width,x+w+radius),ny0=Math.max(0,y-radius),ny1=Math.min(height,y+h+radius),nw=nx1-nx0,nh=ny1-ny0;
   const raw=new Float32Array(nw*3),horizontal=new Float32Array(w*nh*3),fields=new Float32Array(w*h*3);temporaryBytes=raw.byteLength+horizontal.byteLength+fields.byteLength;
   const now=control.now||(()=>typeof performance!=='undefined'?performance.now():Date.now());let deadline=now()+6;
   async function checkpoint(){check();if(now()>=deadline){if(control.yield)await control.yield();else await new Promise(resolve=>setTimeout(resolve,0));check();deadline=now()+6;}}
   try{
    for(let gy=ny0;gy<ny1;gy++){
     for(let c=0;c<4;c++)rowKeys[c]=pcg((gy>>>0)^fieldKeys[c]);
     for(let gx=nx0;gx<nx1;gx++){
      const commonHash=pcg((gx>>>0)^rowKeys[3]),common=config.monochrome?gaussianHash(commonHash):draw(commonHash);
      for(let c=0;c<3;c++)raw[(gx-nx0)*3+c]=config.monochrome?common:f(f(own*draw(pcg((gx>>>0)^rowKeys[c])))+f(shared*common));
      if((gx-nx0)%32===31)await checkpoint();
     }
     for(let xx=0;xx<w;xx++)for(let c=0;c<3;c++){
      let sum=f(0),total=f(0);for(let k=-radius;k<=radius;k++){const gx=x+xx+k,weight=weights[c][k+radius];if(gx>=0&&gx<width){sum=f(sum+f(raw[(gx-nx0)*3+c]*weight));total=f(total+weight);}}
      horizontal[((gy-ny0)*w+xx)*3+c]=f(sum/Math.max(total,f(1e-12)));
      if(c===2&&xx%32===31&&xx!==w-1)await checkpoint();
     }await checkpoint();
    }
    for(let yy=0;yy<h;yy++){
     for(let xx=0;xx<w;xx++)for(let c=0;c<3;c++){
      let sum=f(0),total=f(0);for(let k=-radius;k<=radius;k++){const gy=y+yy+k,weight=weights[c][k+radius];if(gy>=0&&gy<height){sum=f(sum+f(horizontal[((gy-ny0)*w+xx)*3+c]*weight));total=f(total+weight);}}
      fields[(yy*w+xx)*3+c]=f(sum/Math.max(total,f(1e-12)));
      if(c===2&&xx%32===31&&xx!==w-1)await checkpoint();
     }await checkpoint();
    }
    check();let live=true;const result={x,y,width:w,height:h,fields,dispose(){if(!live)return;live=false;result.fields=null;if(active===result)active=null;temporaryBytes=0;}};active=result;temporaryBytes=fields.byteLength;return active;
   }catch(error){temporaryBytes=0;throw error;}
  }
  function sample(x,y,density,out){
   if(disposed||!active)throw new Error('Standard field尚未准备');const xx=x-active.x,yy=y-active.y;if(xx<0||yy<0||xx>=active.width||yy>=active.height||xx%1||yy%1)throw new Error('Standard field坐标不符');
   for(let c=0;c<3;c++){
    const base=f(density[c]),clump=f(f(config.grainStrength[c]*densityModulation(config,c,base,anchors[c]))*active.fields[(yy*active.width+xx)*3+c]);
    // texture_carry receives developed - flat, with the native Float32
    // addition to developed density before the subtraction, not raw clump.
    out[c]=f(f(base+clump)-base);
   }if(config.neutral)out[0]=out[2]=out[1];return out;
  }
  function dispose(){disposed=true;if(active)active.dispose();active=null;temporaryBytes=0;weights.length=0;fieldKeys=rowKeys=null;}
  function workingBytes(){return temporaryBytes+(!disposed?weights.reduce((total,array)=>total+array.byteLength,0)+fieldKeys.byteLength+rowKeys.byteLength:0);}
  return {tile,sample,noise,dispose,workingBytes,config};
 }
 return {configuration,create,densityModulation,pcg,pixelHash,gaussianHash,poissonHash,gaussianRadius,discreteSigma,kernels,noiseParameters,anchorVariances,erf};
})();
if(typeof window!=='undefined')window.FilmifyStandardCPU=FilmifyStandardCPU;
if(typeof module!=='undefined')module.exports=FilmifyStandardCPU;
