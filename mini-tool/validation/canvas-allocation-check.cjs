'use strict';
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');

async function suite(){
 const must=(ok,message)=>{if(!ok)throw new Error(message);};
 const w=769,h=513,source=document.createElement('canvas');source.width=w;source.height=h;
 const sx=source.getContext('2d'),pixels=sx.createImageData(w,h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const i=(y*w+x)*4;pixels.data[i]=x<w/2?8:240;pixels.data[i+1]=(x+y)%29?70:255;pixels.data[i+2]=y<h/2?20:210;pixels.data[i+3]=255;
 }
 sx.putImageData(pixels,0,0);FilmifyEngine.setImage(source);
 const get=HTMLCanvasElement.prototype.getContext,read=CanvasRenderingContext2D.prototype.getImageData;
 let mode='normal',attempts=0,output=null;
 HTMLCanvasElement.prototype.getContext=function(kind,opts){
  if(kind==='2d'&&opts&&opts.alpha===false&&this.width===w&&this.height===h){
   output=this;attempts++;
   if(mode==='null-always'||mode==='null-once'&&attempts===1)return null;
  }
  return get.apply(this,arguments);
 };
 CanvasRenderingContext2D.prototype.getImageData=function(x,y,rw,rh){
  if(this.canvas===output&&x===w-1&&y===h-1&&rw===1&&rh===1){
   if(mode==='zero-always'||mode==='zero-once'&&attempts===1)return new ImageData(1,1);
   if(mode==='stuck-white')return new ImageData(new Uint8ClampedArray([255,255,255,255]),1,1);
   if(mode==='security')throw new DOMException('Injected blocked readback','SecurityError');
   if(mode==='safari-noise'){
    const data=read.apply(this,arguments);
    for(let i=0;i<data.data.length;i++)data.data[i]=Math.max(0,data.data[i]-2);
    return data;
   }
  }
  return read.apply(this,arguments);
 };
 async function decode(blob){
  const url=URL.createObjectURL(blob),im=new Image(),c=document.createElement('canvas');
  try{im.src=url;await im.decode();c.width=im.naturalWidth;c.height=im.naturalHeight;const x=c.getContext('2d');x.drawImage(im,0,0);return x.getImageData(0,0,c.width,c.height).data;}
  finally{c.width=c.height=1;im.src='';URL.revokeObjectURL(url);}
 }
 async function render(gpuOptics,nextMode){
  mode=nextMode;attempts=0;output=null;
  const result=await FilmifyEngine.develop('gold',null,{paper:'kodak_portra_endura',diffusion:.125,spatialDir:true,autoExposure:false,masterPNG:true,gpuOptics,seed:17});
  must(result.width===w&&result.height===h,'Output resolution changed');
  must(output.width===1&&output.height===1,'Output backing retained');
  return {data:await decode(result.blob),attempts};
 }
 const results=[];
 try{
  for(const gpu of [true,false]){
   await render(gpu,'normal');
   const baseline=await render(gpu,'normal');
   for(const nextMode of ['null-once','zero-once','safari-noise']){
    const retry=await render(gpu,nextMode);let max=0,count=0;
    for(let i=0;i<baseline.data.length;i++){const d=Math.abs(baseline.data[i]-retry.data[i]);max=Math.max(max,d);if(d)count++;}
    results.push({gpu,mode:nextMode,attempts:retry.attempts,max,count});
    must(retry.attempts===(nextMode==='safari-noise'?1:2),'Unexpected allocation retry count');
    must(max<=1&&count<baseline.data.length*.01,'Allocation retry changed optical effects: '+JSON.stringify(results[results.length-1]));
   }
  }
  for(const nextMode of ['null-always','zero-always','stuck-white','security']){
   let error='';try{await render(true,nextMode);}catch(e){error=e.message;}
   must(error.includes('画布')&&attempts===(nextMode==='security'?1:2),'Persistent allocation failure not bounded: '+nextMode);
   must(!error.includes('iOS 画布内存上限'),'Readback error misreported as iOS memory limit');
   must(output.width===1&&output.height===1,'Failed output backing retained');
   results.push({mode:nextMode,attempts,error,diag:window.FILMIFY_DIAG.canvasAllocFail});
  }
  await render(true,'normal');
  must(!window.FILMIFY_DIAG.canvasAllocFail&&!window.FILMIFY_DIAG.canvasAllocRetry,'Successful run kept stale failure diagnostics');
  return results;
 }finally{HTMLCanvasElement.prototype.getContext=get;CanvasRenderingContext2D.prototype.getImageData=read;FilmifyEngine.release();source.width=source.height=1;}
}

module.exports={suite};
if(require.main===module)(async()=>{
 const root=path.resolve(__dirname,'..'),server=http.createServer((req,res)=>{
  const url=req.url.split('?')[0];let file=path.join(root,url);
  if(process.argv.includes('--source')&&url==='/dist/xhs-tool/engine.js')file=path.join(root,'minitool/engine.js');
  fs.readFile(file,(e,data)=>{res.statusCode=e?404:200;res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(e?'':data);});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=process.argv.includes('--webkit')?await require('playwright').webkit.launch():await require('../scripts/launch-browser.cjs').launchBrowser();
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/validation/sample-grid.html');
  await page.evaluate(()=>FilmifyEngine.init(document.createElement('canvas'),'/dist/xhs-tool/'));
  console.log(JSON.stringify(await page.evaluate(suite),null,2));console.log('PASS canvas allocation: retry preserves effects, bounded failure, cleanup and recovery');
 }finally{if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
