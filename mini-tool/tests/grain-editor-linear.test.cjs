'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,webkit}=require('playwright');
const ROOT=path.resolve(__dirname,'..'),FILES=['grain-material-data.js','grain-material.js','standard-data.js','standard-cpu.js','standard-glsl.js','standard-renderer.js','grain.js'];
function fixture(prefix){return '<!doctype html><meta charset="utf-8"><script>window.filmifyYield=()=>new Promise(r=>setTimeout(r,0));</script>'+FILES.map(file=>'<script src="'+prefix+'/'+file+'"></script>').join('');}
async function server(){
 const s=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),name=decodeURIComponent(url.pathname);
  if(name==='/new/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture('/new'));return;}
  const dir='minitool',file=path.basename(name);
  if(!FILES.includes(file)&&!['grain-tiles.png','grain-material.png'].includes(file)){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.png')?'image/png':'application/javascript; charset=utf-8');res.end(fs.readFileSync(path.join(ROOT,dir,file)));
 });
 await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});return {s,url:'http://127.0.0.1:'+s.address().port};
}
for(const [name,type] of [['chromium',chromium],['webkit',webkit]])test('finished-photo linear grain: '+name,{timeout:120000},async()=>{
 const {s,url}=await server();let browser;
 try{
  browser=name==='chromium'?await require('../scripts/launch-browser.cjs').launchBrowser():await type.launch({headless:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(url+'/new/');
  const measurements=await page.evaluate(async()=>{
   const grain=FilmifyGrain,p={amount:100,size:1,chroma:100,softness:1},w=96,h=72,sw=2048,sh=1536,data=new Float32Array(w*h*3);
   for(let i=0;i<w*h;i++){data[i*3]=((i*17)%121)/100;data[i*3+1]=((i*37)%99)/100;data[i*3+2]=((i*71)%111)/100;}
   data.set([-.02,.3,1.2],0);
   const input={width:w,height:h,data,sourceWidth:sw,sourceHeight:sh,sourceStepX:sw/w,sourceStepY:sh/h},opts={params:p,seed:291,grainFormatMm:35};
   const zero=await grain.renderLinear(input,{...opts,params:{...p,amount:0}});let zeroMax=0;for(let i=0;i<data.length;i++)zeroMax=Math.max(zeroMax,Math.abs(zero.data[i]-data[i]));
   const cpu=await grain.renderLinear(input,{...opts,forceCPU:true,tileEdge:32}),gpu=await grain.renderLinear(input,{...opts,tileEdge:64});let gpuCPU=0;for(let i=0;i<data.length;i++)gpuCPU=Math.max(gpuCPU,Math.abs(cpu.data[i]-gpu.data[i]));
   const tile=await grain.renderLinear(input,{...opts,tileEdge:32});let tileMax=0;for(let i=0;i<data.length;i++)tileMax=Math.max(tileMax,Math.abs(tile.data[i]-gpu.data[i]));
   const x=11,y=17,cw=23,ch=19,crop=new Float32Array(cw*ch*3);
   for(let row=0;row<ch;row++)crop.set(data.subarray(((y+row)*w+x)*3,((y+row)*w+x+cw)*3),row*cw*3);
   const region=await grain.renderLinear({...input,width:cw,height:ch,data:crop,sourceOriginX:x*sw/w,sourceOriginY:y*sh/h},{...opts,forceCPU:true});let cropMax=0;
   for(let row=0;row<ch;row++)for(let col=0;col<cw;col++)for(let c=0;c<3;c++)cropMax=Math.max(cropMax,Math.abs(region.data[(row*cw+col)*3+c]-cpu.data[((y+row)*w+x+col)*3+c]));
   const fullInput={...input,sourceWidth:3200,sourceHeight:2400,sourceOriginX:131,sourceOriginY:79,sourceStepX:1,sourceStepY:1},fullCPU=await grain.renderLinear(fullInput,{...opts,forceCPU:true,tileEdge:32}),fullGPU=await grain.renderLinear(fullInput,{...opts,tileEdge:64});let fullGPUCPU=0;for(let i=0;i<data.length;i++)fullGPUCPU=Math.max(fullGPUCPU,Math.abs(fullCPU.data[i]-fullGPU.data[i]));
   const rgba=new Float32Array(w*h*4);for(let i=0;i<w*h;i++){rgba.set(data.subarray(i*3,i*3+3),i*4);rgba[i*4+3]=1;}const rgbaGPU=await grain.renderLinear({...fullInput,data:rgba,channels:4},{...opts,pixelOps:{preferRGBA:true},tileEdge:32});let rgbaMax=0;for(let i=0;i<w*h;i++)for(let c=0;c<3;c++)rgbaMax=Math.max(rgbaMax,Math.abs(rgbaGPU.data[i*4+c]-fullGPU.data[i*3+c]));const rgbaChannels=rgbaGPU.channels;
   // Exercise the real upload boundary, so equality cannot pass solely via
   // the former repacking path. Keep a nonzero byteOffset and invalid unused
   // tail/padding: only active pixels belong to the linear input contract.
   const dw=65,dh=47,prefix=8,tail=12,backing=new Float32Array(prefix+dw*dh*4+tail).fill(NaN),directData=backing.subarray(prefix),directOpts={...opts,pixelOps:{preferRGBA:true},tileEdge:384};
   for(let i=0;i<dw*dh;i++){directData[i*4]=((i*17)%121)/100;directData[i*4+1]=((i*37)%99)/100;directData[i*4+2]=((i*71)%111)/100;directData[i*4+3]=1;}directData.set([-.02,.3,1.2,1],0);
   const directInput={data:directData,width:dw,height:dh,channels:4,sourceWidth:3200,sourceHeight:2400,sourceOriginX:131,sourceOriginY:79,sourceStepX:1,sourceStepY:1},inputBits=new Uint32Array(backing.buffer).slice();
   const maxDiff=(a,b)=>{let result=0;for(let i=0;i<a.length;i++)result=Math.max(result,Math.abs(a[i]-b[i]));return result;},sameBits=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
   const originalUpload=WebGL2RenderingContext.prototype.texSubImage2D;let observedData=null,uploadCalls=0,directUploads=0;
   WebGL2RenderingContext.prototype.texSubImage2D=function(){const value=arguments[8];if(value instanceof Float32Array){uploadCalls++;if(observedData&&value.buffer===observedData.buffer&&value.byteOffset===observedData.byteOffset&&value.length===dw*dh*4)directUploads++;}return originalUpload.apply(this,arguments);};
   let directGPU,splitGPU,stridedGPU,initialDirectUploads=0,splitDirectUploads=0,stridedDirectUploads=0,splitUploadCalls=0;
   try{
    observedData=directData;directGPU=await grain.renderLinear(directInput,directOpts);initialDirectUploads=directUploads;
    directUploads=uploadCalls=0;splitGPU=await grain.renderLinear(directInput,{...directOpts,tileEdge:32});splitDirectUploads=directUploads;splitUploadCalls=uploadCalls;
    const stride=dw*4+12,stridedData=new Float32Array(dh*stride+tail).fill(NaN);for(let row=0;row<dh;row++)stridedData.set(directData.subarray(row*dw*4,(row+1)*dw*4),row*stride);
    const strideBits=new Uint32Array(stridedData.buffer).slice();observedData=stridedData;directUploads=0;stridedGPU=await grain.renderLinear({...directInput,data:stridedData,stride},directOpts);stridedDirectUploads=directUploads;
    if(!sameBits(strideBits,new Uint32Array(stridedData.buffer)))throw Error('Strided grain input was mutated');
   }finally{WebGL2RenderingContext.prototype.texSubImage2D=originalUpload;}
   const directBits=new Uint32Array(directGPU.data.buffer,directGPU.data.byteOffset,directGPU.data.length).slice(),changedData=directData.slice(0,dw*dh*4);for(let i=0;i<dw*dh;i++)changedData[i*4]+=.07;
   const subsequent=await grain.renderLinear({...directInput,data:changedData},directOpts),outputOwned=directGPU.data.buffer!==directData.buffer&&directGPU.data.buffer!==splitGPU.data.buffer&&directGPU.data.buffer!==subsequent.data.buffer,ownedStable=sameBits(directBits,new Uint32Array(directGPU.data.buffer,directGPU.data.byteOffset,directGPU.data.length));
   let invalidNaN='',invalidAlpha='';for(const kind of ['nan','alpha']){const invalid=directData.slice(0,dw*dh*4);invalid[kind==='nan'?0:3]=kind==='nan'?NaN:.5;try{await grain.renderLinear({...directInput,data:invalid},directOpts);}catch(error){if(kind==='nan')invalidNaN=error.message;else invalidAlpha=error.message;}}
   const originalOutputRead=WebGL2RenderingContext.prototype.readPixels;let corruptReads=0,invalidGPU='';WebGL2RenderingContext.prototype.readPixels=function(){const value=originalOutputRead.apply(this,arguments),target=arguments[6];if(target instanceof Float32Array){target[0]=NaN;corruptReads++;}return value;};
   try{await grain.renderLinear(directInput,directOpts);}catch(error){invalidGPU=error.message;}finally{WebGL2RenderingContext.prototype.readPixels=originalOutputRead;}
   const directRGBA={paths:[directGPU.path,splitGPU.path,stridedGPU.path,subsequent.path],channels:[directGPU.channels,splitGPU.channels,stridedGPU.channels],directUploads:initialDirectUploads,splitDirectUploads,stridedDirectUploads,splitUploadCalls,splitMax:maxDiff(directGPU.data,splitGPU.data),strideMax:maxDiff(directGPU.data,stridedGPU.data),inputUnchanged:sameBits(inputBits,new Uint32Array(backing.buffer)),outputOwned,ownedStable,subsequentChanged:maxDiff(directGPU.data,subsequent.data)>0,invalidNaN,invalidAlpha,invalidGPU,corruptReads};
   const neutralData=new Float32Array(17*13*3).fill(.2),neutral=await grain.renderLinear({data:neutralData,width:17,height:13},{...opts,params:{...p,chroma:0}});let neutralMax=0;for(let i=0;i<17*13;i++)neutralMax=Math.max(neutralMax,Math.abs(neutral.data[i*3]-neutral.data[i*3+1]),Math.abs(neutral.data[i*3+1]-neutral.data[i*3+2]));
   grain.release();const originalRead=WebGL2RenderingContext.prototype.readPixels;let readCalls=0;WebGL2RenderingContext.prototype.readPixels=function(){if(++readCalls===3)throw Error('Injected Standard GPU readback loss');return originalRead.apply(this,arguments);};let recoveredGPU;try{recoveredGPU=await grain.renderLinear(fullInput,{...opts,tileEdge:32});}finally{WebGL2RenderingContext.prototype.readPixels=originalRead;}let runtimeFallbackMax=0;for(let i=0;i<data.length;i++)runtimeFallbackMax=Math.max(runtimeFallbackMax,Math.abs(recoveredGPU.data[i]-fullCPU.data[i]));const runtimeFallbackPath=recoveredGPU.path;
   const material=FilmifyGrainMaterial,d0=[0,0,0],linear=[0,0,0],d1=[0,0,0];let materialMax=0;
   for(const rgb of [[0,0,0],[255,0,0],[17,128,201],[255,255,255]]){material.density(...rgb,d0,linear);material.densityLinear2020(...linear,d1);for(let c=0;c<3;c++)materialMax=Math.max(materialMax,Math.abs(d0[c]-d1[c]));}
   const negativePreserved=cpu.data[0]<0,aboveWhitePreserved=cpu.data[2]>1;
   grain.release();let cancel=false;const canceled=grain.renderLinear(input,{...opts,tileEdge:32,cancelled:()=>cancel,onProgress:()=>{cancel=true;}});
   let canceledMessage='';try{await canceled;}catch(error){canceledMessage=error.message;}
   const valid=await grain.renderLinear(input,opts),recovered=valid.data.length===data.length;
   // A device with no float framebuffer must use the actual float CPU path.
   grain.release();const extension=WebGL2RenderingContext.prototype.getExtension;
   WebGL2RenderingContext.prototype.getExtension=function(name){return name==='EXT_color_buffer_float'?null:extension.call(this,name);};
   let fallback;try{fallback=await grain.renderLinear(input,opts);}finally{WebGL2RenderingContext.prototype.getExtension=extension;grain.release();}
   let fallbackMax=0;for(let i=0;i<data.length;i++)fallbackMax=Math.max(fallbackMax,Math.abs(fallback.data[i]-cpu.data[i]));
   Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
   const hidden=grain.renderLinear({...input,width:512,height:384,data:new Float32Array(512*384*3),sourceStepX:sw/512,sourceStepY:sh/384},{...opts,forceCPU:true});
   setTimeout(()=>grain.release(),20);let releaseMessage='';try{await hidden;}catch(error){releaseMessage=error.message;}finally{delete document.hidden;}
   let rejected=false;try{await grain.renderLinear({...input,sourceStepX:sw},opts);}catch(error){rejected=true;}
   return {directRGBA,runtimeFallbackMax,runtimeFallbackPath,zeroMax,gpuCPU,tileMax,cropMax,fullGPUCPU,rgbaMax,rgbaChannels,neutralMax,materialMax,gpuPath:gpu.path,negativePreserved,aboveWhitePreserved,canceledMessage,recovered,releaseMessage,rejected,fallbackPath:fallback.path,fallbackMax};
  });
  assert.equal(measurements.runtimeFallbackPath,'cpu');assert.equal(measurements.runtimeFallbackMax,0);assert.equal(measurements.zeroMax,0);assert(measurements.fullGPUCPU<.0006,JSON.stringify(measurements));assert.equal(measurements.rgbaMax,0);assert.equal(measurements.rgbaChannels,4);assert.equal(measurements.neutralMax,0);assert.equal(measurements.materialMax,0);assert.equal(measurements.cropMax,0);assert(measurements.gpuCPU<.0006,JSON.stringify(measurements));assert(measurements.tileMax<.00001,JSON.stringify(measurements));
  assert.equal(measurements.gpuPath,'webgl2');assert(measurements.negativePreserved);assert(measurements.aboveWhitePreserved);assert.equal(measurements.canceledMessage,'已取消');assert(measurements.recovered);assert.equal(measurements.releaseMessage,'已取消');assert(measurements.rejected);
  assert.equal(measurements.fallbackPath,'cpu');assert.equal(measurements.fallbackMax,0);
  const direct=measurements.directRGBA;assert.deepEqual(direct.paths,['webgl2','webgl2','webgl2','webgl2']);assert.deepEqual(direct.channels,[4,4,4]);assert.equal(direct.directUploads,1);assert.equal(direct.splitDirectUploads,0);assert.equal(direct.stridedDirectUploads,0);assert(direct.splitUploadCalls>1);assert.equal(direct.splitMax,0);assert.equal(direct.strideMax,0);assert(direct.inputUnchanged);assert(direct.outputOwned);assert(direct.ownedStable);assert(direct.subsequentChanged);assert.match(direct.invalidNaN,/输入无效/);assert.match(direct.invalidAlpha,/输入无效/);assert(direct.corruptReads>0);assert.match(direct.invalidGPU,/结果超出范围/);
  // The encoded entry must preserve complete-source crop and tile geometry.
  async function encoded(p){return p.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=512;canvas.height=384;const ctx=canvas.getContext('2d',{willReadFrequently:true}),img=ctx.createImageData(512,384);for(let i=0;i<512*384;i++)img.data.set([(i*19)%256,(i*43)%256,(i*67)%256,255],i*4);ctx.putImageData(img,0,0);const result=await FilmifyGrain.render(canvas,{amount:100,size:1,chroma:100,softness:1},{seed:291,grainFormatMm:35,forceCPU:true,region:{x:17,y:29,width:23,height:19}}),bytes=Array.from(result.canvas.getContext('2d').getImageData(0,0,23,19).data);FilmifyGrain.release();return bytes;});}
  const modern=await encoded(page);assert.deepEqual(await encoded(page),modern);assert.deepEqual(errors,[]);console.log(name+' '+JSON.stringify(measurements));
 }finally{if(browser)await browser.close();await new Promise(resolve=>s.close(resolve));}
});
