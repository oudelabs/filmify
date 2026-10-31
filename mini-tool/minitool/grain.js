/* Filmify finished-photo Standard grain. Engine Apache-2.0, MUAStudio Inc.
 * Standard clump field is checked against Fotufilm 73dff127f68e (Grain.h and
 * Random.h unchanged from 54064ece). The Portra material stays 54064ece,
 * CC BY-SA 4.0. Texture carry preserves the selected finished-photo LUT.
 * No Film atlas, quantile table, half storage, Worker, WASM or runtime fetch. */
'use strict';
window.FilmifyGrain=(function(){
 const VERSION='fotufilm-standard-linear-1';
 let queue=Promise.resolve(),epoch=0,renderer=null,rendererKey='',lastRendererError='';
 const activeSamplers=new Set(),activeSharedRenderers=new Set(),grainYieldWakes=new Set();
 function normalize(value){
  value=value||{};const number=(v,d,a,b)=>Number.isFinite(Number(v))?Math.max(a,Math.min(b,Number(v))):d;
  // size and scan softness belong to upstream Film mode. Accept their old
  // API fields, but Standard retains its calibrated clump size and aperture.
  return {amount:number(value.amount,100,0,100),size:1,chroma:number(value.chroma,100,0,100),softness:1};
 }
 function cancellation(generation,cancelled){return ()=>{if(generation!==epoch||cancelled&&cancelled())throw new Error('已取消');};}
 function grainYield(){
  return new Promise((resolve,reject)=>{
   let done=false;const finish=error=>{if(done)return;done=true;grainYieldWakes.delete(wake);document.removeEventListener('visibilitychange',resume);if(error)reject(error);else resolve();};
   const wake=()=>finish(),resume=()=>{if(!document.hidden)finish();};grainYieldWakes.add(wake);
   if(document.hidden)document.addEventListener('visibilitychange',resume);
   else{try{const work=typeof filmifyYield==='function'?filmifyYield():new Promise(r=>setTimeout(r,0));Promise.resolve(work).then(()=>finish(),finish);}catch(error){finish(error);}}
  });
 }
 function awaitCurrent(promise,check){
  check();return new Promise((resolve,reject)=>{
   let done=false;const finish=(error,value)=>{if(done)return;done=true;clearInterval(timer);if(error)reject(error);else resolve(value);};
   const timer=setInterval(()=>{try{check();}catch(error){finish(error);}},32);
   Promise.resolve(promise).then(value=>{try{check();finish(null,value);}catch(error){finish(error);}},error=>finish(error));
  });
 }
 function modules(){if(!window.FilmifyStandardCPU||!window.FilmifyStandardData||!window.FilmifyGrainMaterial)throw new Error('Standard 颗粒模块未准备');}
 function configuration(width,height,opts,p){
  modules();return window.FilmifyStandardCPU.configuration(width,height,opts.grainFormatMm,window.FilmifyStandardData,{frameHeightMm:opts.grainFrameHeightMm,amount:p.amount/100,chroma:p.chroma/100});
 }
 async function prepareLinear(opts){
  opts=opts||{};const width=Number(opts.sourceWidth),height=Number(opts.sourceHeight),p=normalize(opts.params),check=cancellation(epoch,opts.cancelled);check();
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw new Error('颗粒完整源尺寸无效');
  if(p.amount){modules();await awaitCurrent(window.FilmifyGrainMaterial.prepare(),check);configuration(width,height,opts,p);}
  check();return {sourceWidth:width,sourceHeight:height,prepared:!!p.amount,model:'Standard'};
 }
 function linearLayout(input){
  if(!input||!(input.data instanceof Float32Array))throw new Error('颗粒输入需要 Float32 线性 Rec.2020');
  const w=Number(input.width),h=Number(input.height),channels=input.channels===undefined?3:Number(input.channels),stride=input.stride===undefined?w*channels:Number(input.stride);
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||(channels!==3&&channels!==4)||!Number.isInteger(stride)||stride<w*channels||input.data.length<(h-1)*stride+w*channels)throw new Error('颗粒输入尺寸不符');
  const sourceWidth=input.sourceWidth===undefined?w:Number(input.sourceWidth),sourceHeight=input.sourceHeight===undefined?h:Number(input.sourceHeight),x=input.sourceOriginX===undefined?0:Number(input.sourceOriginX),y=input.sourceOriginY===undefined?0:Number(input.sourceOriginY),sx=input.sourceStepX===undefined?sourceWidth/w:Number(input.sourceStepX),sy=input.sourceStepY===undefined?sourceHeight/h:Number(input.sourceStepY);
  if(![sourceWidth,sourceHeight,x,y,sx,sy].every(Number.isFinite)||sourceWidth<=0||sourceHeight<=0||x<0||y<0||sx<=0||sy<=0||x+w*sx>sourceWidth+1e-6||y+h*sy>sourceHeight+1e-6)throw new Error('颗粒完整源坐标不符');
  // Standard is tied to the output lattice. Production always passes step=1;
  // a caller supplying a sampled rendition defines a correspondingly sampled
  // complete lattice, rather than treating each tile as an independent frame.
  const fw=Math.round(sourceWidth/sx),fh=Math.round(sourceHeight/sy),gx=Math.round(x/sx),gy=Math.round(y/sy);
  if(fw<1||fh<1||Math.abs(x/sx-gx)>1e-5||Math.abs(y/sy-gy)>1e-5||gx+w>fw||gy+h>fh)throw new Error('Standard 颗粒需要对齐的完整源坐标');
  return {w,h,channels,stride,sourceWidth,sourceHeight,x,y,sx,sy,fw,fh,gx,gy};
 }
 function retireRenderer(){if(renderer)renderer.dispose();renderer=null;rendererKey='';}
 async function verifyRenderer(gpu,config,seed,check){
  const w=Math.min(5,config.sourceWidth),h=Math.min(3,config.sourceHeight),x=Math.min(131,config.sourceWidth-w),y=Math.min(79,config.sourceHeight-h),data=new Float32Array(w*h*4);
  for(let i=0;i<w*h;i++)data.set([i===0?-.02:(i*17%101)/100,(i*37%99)/100,i===0?1.2:(i*71%111)/100,1],i*4);
  const actual=gpu.draw(data,w,h,x,y),sampler=window.FilmifyStandardCPU.create(config,seed);activeSamplers.add(sampler);
  try{
   await sampler.tile(x,y,w,h,{check,yield:grainYield});check();const density=[0,0,0],delta=[0,0,0],source=[0,0,0],expected=[0,0,0];
   for(let i=0;i<w*h;i++){
    for(let c=0;c<3;c++)source[c]=data[i*4+c];window.FilmifyGrainMaterial.densityLinear2020(source[0],source[1],source[2],density);sampler.sample(x+i%w,y+Math.floor(i/w),density,delta);window.FilmifyGrainMaterial.carryLinear2020(source,delta,expected);
    for(let c=0;c<3;c++)if(!Number.isFinite(actual[i*4+c])||Math.abs(actual[i*4+c]-expected[c])>Math.max(5e-5,Math.abs(expected[c])*5e-4))throw new Error('Standard 颗粒线性 GPU 校验未通过');
    if(actual[i*4+3]!==1)throw new Error('Standard 颗粒线性 GPU 校验未通过');
   }
  }finally{sampler.dispose();activeSamplers.delete(sampler);}
 }
 async function createSharedRenderer(opts){
  opts=opts||{};const width=Number(opts.sourceWidth),height=Number(opts.sourceHeight),p=normalize(opts.params),seed=(opts.seed===undefined?1:opts.seed)>>>0,check=cancellation(epoch,opts.cancelled);check();
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw new Error('颗粒完整源尺寸无效');
  if(!opts.gl)throw new Error('Standard GPU共享上下文未准备');
  let shared=null;
  try{
   modules();await awaitCurrent(window.FilmifyGrainMaterial.prepare(),check);check();const config=configuration(width,height,opts,p);
   shared=window.FilmifyStandardRenderer.create(config,seed,window.FilmifyGrainMaterial,{linear:true,gl:opts.gl});
   const dispose=shared.dispose;shared.dispose=()=>{activeSharedRenderers.delete(shared);dispose();};activeSharedRenderers.add(shared);
   check();await verifyRenderer(shared,config,seed,check);check();return shared;
  }catch(error){if(shared)shared.dispose();throw error;}
 }
 async function renderLinearNow(input,opts){
  opts=opts||{};const layout=linearLayout(input),{w,h,channels,stride,fw,fh,gx,gy}=layout,p=normalize(opts.params),generation=epoch,seed=(opts.seed===undefined?1:opts.seed)>>>0,check=cancellation(generation,opts.cancelled);check();
  let config=null,gpu=null,sampler=null;
  try{
   if(p.amount){
    modules();await awaitCurrent(window.FilmifyGrainMaterial.prepare(),check);config=configuration(fw,fh,opts,p);
    if(!opts.forceCPU){
     const key=JSON.stringify([fw,fh,config.frameHeightMM,p.amount,p.chroma,seed]);
     try{if(!renderer||key!==rendererKey){retireRenderer();renderer=window.FilmifyStandardRenderer.create(config,seed,window.FilmifyGrainMaterial,{linear:true});rendererKey=key;await verifyRenderer(renderer,config,seed,check);}gpu=renderer;lastRendererError='';}
     catch(error){retireRenderer();check();lastRendererError=error.message;}
    }
    if(!gpu){sampler=window.FilmifyStandardCPU.create(config,seed);activeSamplers.add(sampler);}
   }
   const outChannels=gpu&&opts.pixelOps&&opts.pixelOps.preferRGBA?4:3,out=new Float32Array(w*h*outChannels),edge=Math.floor(Math.max(32,Math.min(768,Number(opts.tileEdge)||(gpu?384:128)))),total=Math.ceil(w/edge)*Math.ceil(h/edge),density=[0,0,0],delta=[0,0,0],source=[0,0,0],carried=[0,0,0];let count=0,deadline=performance.now()+6,lastR=NaN,lastG=NaN,lastB=NaN;
   for(let oy=0;oy<h;oy+=edge)for(let ox=0;ox<w;ox+=edge){
    check();const tw=Math.min(edge,w-ox),th=Math.min(edge,h-oy);
    // The production tile is already tightly packed RGBA Float32. Upload
    // that immutable input directly; GPU readback still belongs to the
    // renderer and is copied into this call's independently owned output.
    const direct=!!gpu&&channels===4&&stride===w*4&&ox===0&&oy===0&&tw===w&&th===h;
    const packed=gpu?(direct?input.data.subarray(0,w*h*4):new Float32Array(tw*th*4)):null;
    if(sampler){await sampler.tile(gx+ox,gy+oy,tw,th,{check,yield:grainYield});check();}
    for(let yy=0;yy<th;yy++)for(let xx=0;xx<tw;xx++){
     const i=(oy+yy)*stride+(ox+xx)*channels,k=((oy+yy)*w+ox+xx)*outChannels,r=input.data[i],g=input.data[i+1],b=input.data[i+2];
     if(!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b)||(channels===4&&input.data[i+3]!==1))throw new Error('颗粒线性输入无效');
     if(gpu){if(!direct){const q=(yy*tw+xx)*4;packed[q]=r;packed[q+1]=g;packed[q+2]=b;packed[q+3]=1;}}
     else if(!p.amount){out[k]=r;out[k+1]=g;out[k+2]=b;}
     else{
      if(r!==lastR||g!==lastG||b!==lastB){window.FilmifyGrainMaterial.densityLinear2020(r,g,b,density);lastR=r;lastG=g;lastB=b;}
      source[0]=r;source[1]=g;source[2]=b;sampler.sample(gx+ox+xx,gy+oy+yy,density,delta);window.FilmifyGrainMaterial.carryLinear2020(source,delta,carried);
      for(let c=0;c<3;c++){if(!Number.isFinite(carried[c]))throw new Error('颗粒线性结果超出范围');out[k+c]=carried[c];}
     }
     if(((!gpu&&xx%32===31)||xx===tw-1)&&performance.now()>=deadline){await grainYield();check();deadline=performance.now()+6;}
    }
    if(gpu){
     let result;try{result=gpu.draw(packed,tw,th,gx+ox,gy+oy);}catch(error){check();lastRendererError=error.message;retireRenderer();return await renderLinearNow(input,Object.assign({},opts,{forceCPU:true}));}check();
     for(let yy=0;yy<th;yy++){
      const row=yy*tw*4;
      for(let xx=0;xx<tw;xx++)for(let c=0;c<outChannels;c++)if(!Number.isFinite(result[row+xx*4+c]))throw new Error('颗粒线性结果超出范围');
      if(outChannels===4)out.set(result.subarray(row,row+tw*4),((oy+yy)*w+ox)*4);
      else for(let xx=0;xx<tw;xx++){const k=((oy+yy)*w+ox+xx)*3,q=row+xx*4;out[k]=result[q];out[k+1]=result[q+1];out[k+2]=result[q+2];}
     }
    }
    if(opts.onProgress)opts.onProgress(++count/total*100);await grainYield();check();deadline=performance.now()+6;
   }
   if(outChannels===4)out.channels=4;
   return {width:w,height:h,data:out,channels:outChannels,stride:w*outChannels,path:gpu?'webgl2':'cpu',model:'Standard',configuration:config,gpuFallback:lastRendererError,sampledLattice:layout.sx!==1||layout.sy!==1};
  }finally{if(sampler){sampler.dispose();activeSamplers.delete(sampler);}}
 }
 function enqueue(work){const generation=epoch,result=queue.catch(()=>{}).then(()=>{if(generation!==epoch)throw new Error('已取消');return work();});queue=result.then(()=>{},()=>{});return result;}
 function renderLinear(input,opts){return enqueue(()=>renderLinearNow(input,opts));}
 function decode(x){x/=255;return x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4);}
 async function renderNow(image,value,opts){
  opts=opts||{};const p=normalize(value),generation=epoch,check=cancellation(generation,opts.cancelled),iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height;check();
  if(!Number.isInteger(iw)||!Number.isInteger(ih)||iw<1||ih<1)throw new Error('照片尺寸不符');
  const region=opts.region||{x:0,y:0,width:iw,height:ih},x=Math.max(0,Math.min(iw-1,Math.floor(region.x))),y=Math.max(0,Math.min(ih-1,Math.floor(region.y))),rw=Math.max(1,Math.min(iw-x,Math.floor(region.width))),rh=Math.max(1,Math.min(ih-y,Math.floor(region.height))),out=document.createElement('canvas'),tile=document.createElement('canvas');out.width=rw;out.height=rh;let scaled=null,path='cpu';
  try{
   const ctx=out.getContext('2d',{colorSpace:'srgb'}),tc=tile.getContext('2d',{colorSpace:'srgb',willReadFrequently:true});if(!ctx||!tc)throw new Error('照片渲染空间不足');
   const edge=Math.floor(Math.max(32,Math.min(768,Number(opts.tileEdge)||384))),total=Math.ceil(rw/edge)*Math.ceil(rh/edge),encoded=[0,0,0],source=[0,0,0],zero=[0,0,0];let count=0;
   for(let oy=0;oy<rh;oy+=edge)for(let ox=0;ox<rw;ox+=edge){
    check();const tw=Math.min(edge,rw-ox),th=Math.min(edge,rh-oy);tile.width=tw;tile.height=th;tc.drawImage(image,x+ox,y+oy,tw,th,0,0,tw,th);const pixels=tc.getImageData(0,0,tw,th);
    if(p.amount){
     modules();const linear=new Float32Array(tw*th*3),m=window.FilmifyGrainMaterialData.srgbTo2020;
     for(let i=0;i<tw*th;i++){const r=decode(pixels.data[i*4]),g=decode(pixels.data[i*4+1]),b=decode(pixels.data[i*4+2]);for(let c=0;c<3;c++)linear[i*3+c]=m[c*3]*r+m[c*3+1]*g+m[c*3+2]*b;}
     const result=await renderLinearNow({data:linear,width:tw,height:th,sourceWidth:iw,sourceHeight:ih,sourceOriginX:x+ox,sourceOriginY:y+oy,sourceStepX:1,sourceStepY:1},Object.assign({},opts,{params:p,onProgress:null}));check();path=result.path;
     for(let i=0;i<tw*th;i++){for(let c=0;c<3;c++)source[c]=result.data[i*result.channels+c];window.FilmifyGrainMaterial.carry(source,zero,encoded);for(let c=0;c<3;c++)pixels.data[i*4+c]=Math.round(encoded[c]);}
    }
    ctx.putImageData(pixels,ox,oy);if(opts.onProgress)opts.onProgress(++count/total*92);await grainYield();check();
   }
   const scale=opts.maxEdge?Math.min(1,opts.maxEdge/Math.max(rw,rh)):1,w=Math.max(1,Math.round(rw*scale)),h=Math.max(1,Math.round(rh*scale));
   if(scale<1){scaled=document.createElement('canvas');scaled.width=w;scaled.height=h;scaled.getContext('2d').drawImage(out,0,0,w,h);out.width=out.height=1;}
   check();return {canvas:scaled||out,width:w,height:h,path,approximate:false,model:'Standard',gpuFallback:lastRendererError};
  }catch(error){out.width=out.height=1;if(scaled)scaled.width=scaled.height=1;throw error;}finally{tile.width=tile.height=1;}
 }
 function render(image,value,opts){return enqueue(()=>renderNow(image,value,opts));}
 function blob(canvas,type,quality){return new Promise((resolve,reject)=>{try{canvas.toBlob(value=>value?resolve(value):reject(new Error('照片编码失败，请重试')),type,quality);}catch(error){reject(error);}});}
 async function develop(image,progress,opts){
  opts=opts||{};const generation=epoch,check=cancellation(generation,opts.cancelled),result=await render(image,opts.params,Object.assign({},opts,{onProgress:progress})),out=result.canvas,preview=document.createElement('canvas');
  try{check();const master=await blob(out,opts.masterPNG?'image/png':'image/jpeg',.92);check();const scale=Math.min(1,2048/Math.max(result.width,result.height));preview.width=Math.max(1,Math.round(result.width*scale));preview.height=Math.max(1,Math.round(result.height*scale));preview.getContext('2d').drawImage(out,0,0,preview.width,preview.height);const view=scale===1?master:await blob(preview,'image/jpeg',.92);check();if(progress)progress(100);return {blob:master,previewBlob:view,width:result.width,height:result.height,path:result.path,model:'Standard'};}finally{out.width=out.height=preview.width=preview.height=1;}
 }
 function release(){epoch++;activeSamplers.forEach(value=>value.dispose());activeSamplers.clear();activeSharedRenderers.forEach(value=>value.dispose());activeSharedRenderers.clear();retireRenderer();grainYieldWakes.forEach(wake=>wake());lastRendererError='';if(window.FilmifyGrainMaterial)window.FilmifyGrainMaterial.release();}
 function getStats(){let cacheBytes=renderer?renderer.workingBytes():0;for(const value of activeSharedRenderers)cacheBytes+=value.workingBytes();return {model:'Standard',materialRevision:window.FilmifyGrainMaterialData&&window.FilmifyGrainMaterialData.sourceRevision,algorithmReviewedRevision:'73dff127f68e',cacheBytes,activeSamplers:activeSamplers.size,activeSharedRenderers:activeSharedRenderers.size,gpuFallback:lastRendererError};}
 return {version:VERSION,model:'Standard',normalize,render,prepareLinear,ready:prepareLinear,createSharedRenderer,renderLinear,develop,release,getStats};
})();
