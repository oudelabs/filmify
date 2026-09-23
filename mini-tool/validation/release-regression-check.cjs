// Real rendering for automatic output fallback; real import and UI state for recovery.
// FILMIFY_TEST_ROOT may point to an offline source fixture without building a ZIP.
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),DIST=path.resolve(process.env.FILMIFY_TEST_ROOT||path.join(ROOT,'dist/xhs-tool'));
const server=http.createServer((req,res)=>{
 const f=path.resolve(DIST,'.'+(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]));
 if(!f.startsWith(DIST+path.sep)){res.writeHead(404);res.end();return;}
 fs.readFile(f,(error,data)=>{if(error){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff':'font/woff'})[path.extname(f)]||'application/octet-stream');res.end(data);
 });
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser(),errors=[];
 async function fresh(){
  const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto('http://127.0.0.1:'+server.address().port+'/');await p.evaluate(()=>FilmifyPrintDesign.ready());return p;
 }
 try{
  // Use the actual automatic probe, not localStorage force-mode shortcuts.
  const modes={};
  for(const variant of ['normal','fbo','pixels','zero','throw']){
   const p=await fresh();
   const result=await p.evaluate(async variant=>{
    const draw=CanvasRenderingContext2D.prototype.drawImage,read=WebGL2RenderingContext.prototype.readPixels;
    const upload=FilmifyMobile.Renderer.prototype.setSourcePixels;let recovered=false,attempts=0,active=variant!=='normal';
    FilmifyMobile.Renderer.prototype.setSourcePixels=function(){
     if(active&&this.outFBO&&this.outputWidth>8){recovered=true;attempts++;}
     return upload.apply(this,arguments);
    };
    CanvasRenderingContext2D.prototype.drawImage=function(source,...args){
     if(active&&source.id==='view'&&this.canvas.height===1){this.clearRect(0,0,this.canvas.width,1);return;}
     return draw.call(this,source,...args);
    };
    WebGL2RenderingContext.prototype.readPixels=function(x,y,w,h,format,type,pixels,...rest){
     if(active&&variant!=='fbo'&&h===1&&y>8&&w>=8){
      if(variant==='throw'&&recovered)throw new Error('injected output read failure');
      if(!recovered||variant==='zero'){pixels.fill(0);return;}
     }
     return read.call(this,x,y,w,h,format,type,pixels,...rest);
    };
    const c=document.createElement('canvas');c.width=769;c.height=513;
    const ctx=c.getContext('2d'),gradient=ctx.createLinearGradient(0,0,c.width,c.height);
    gradient.addColorStop(0,'#2865a1');gradient.addColorStop(1,'#e5b976');ctx.fillStyle=gradient;ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle='#9d4630';ctx.fillRect(430,100,190,300);
    async function run(){FilmifyEngine.setImage(c);return FilmifyEngine.develop('portrait',null,{paper:'kodak_portra_endura',autoExposure:false,diffusion:.125,spatialDir:true,masterPNG:true,seed:7});}
    let result,error='';try{result=await run();}catch(e){error=e.message;}
    const probe=Object.assign({},FILMIFY_DIAG.compositeProbe),initialMode=result&&result.timings.composite;
    // Failed probing must remain retryable in the same engine/context.
    if(error){active=false;result=await run();}
    const b=await createImageBitmap(result.blob),out=document.createElement('canvas');out.width=b.width;out.height=b.height;
    const g=out.getContext('2d');g.drawImage(b,0,0);b.close();const bytes=g.getImageData(0,0,out.width,out.height).data;
    let hash=2166136261;for(const v of bytes){hash^=v;hash=Math.imul(hash,16777619);}
    out.width=out.height=c.width=c.height=1;
    return {error,probe,initialMode,finalMode:result.timings.composite,attempts,hash:hash>>>0,dimensions:[result.width,result.height]};
   },variant);
   modes[variant]=result;await p.close();
   if(variant==='normal'){assert.equal(result.initialMode,'drawImage');assert.equal(result.error,'');}
   else if(variant==='fbo'){assert.equal(result.initialMode,'fbo');assert.equal(result.probe.mode,2);assert.equal(result.error,'');}
   else if(variant==='pixels'){assert.equal(result.initialMode,'fbo+pixels');assert.equal(result.probe.mode,3);assert(result.attempts>0);assert.equal(result.error,'');}
   else{assert.match(result.error,variant==='zero'?/输出读回失败/:/injected output read failure/);assert.equal(result.probe.mode,0);assert.equal(result.finalMode,'drawImage');}
   assert.deepEqual(result.dimensions,[769,513]);assert.equal(result.hash,modes.normal.hash,variant+' output equals healthy pixels');
  }
  console.log('PASS automatic L1/L2/L3 output paths match pixel-for-pixel; failed probes abort and recover',JSON.stringify(modes));

  // Both bitmap resize and img fallback must create the same bounded display size.
  for(const bitmap of [true,false]){
   const p=await fresh();
   const result=await p.evaluate(async bitmap=>{
    if(!bitmap)window.createImageBitmap=undefined;
    const c=document.createElement('canvas');c.width=4096;c.height=3072;const g=c.getContext('2d');g.fillStyle='#995533';g.fillRect(0,0,c.width,c.height);
    const file=new File([await canvasBlob(c,'image/jpeg')],'large.jpg',{type:'image/jpeg'});c.width=c.height=1;await acceptFiles([file]);
    const id=state.selected[0],photo=photos[id],im=await decode(photo.display);
    const display={input:[photo.width,photo.height],size:[im.naturalWidth,im.naturalHeight],separate:photo.display!==photo.src,unchanged:photo.file===file};im.src='';
    const revoke=URL.revokeObjectURL,urls=[];URL.revokeObjectURL=u=>{urls.push(u);revoke.call(URL,u);};removePhoto(id);
    display.released=urls.includes(photo.display)&&urls.includes(photo.src);
    const small=document.createElement('canvas');small.width=600;small.height=800;
    const sf=new File([await canvasBlob(small,'image/jpeg')],'small.jpg',{type:'image/jpeg'});small.width=small.height=1;await acceptFiles([sf]);
    const sp=photos[state.selected[0]];display.smallReused=sp.display===sp.src&&sp.file===sf;
    return display;
   },bitmap);
   assert.deepEqual(result.input,[4096,3072]);assert.deepEqual(result.size,[2048,1536]);assert(result.separate&&result.unchanged&&result.released&&result.smallReused);
   await p.close();console.log('PASS display source bound, full-size file retained, small-file reuse and URL release; bitmap='+bitmap);
  }

  // Cancel only after a real output is cached, then interrupt the real second spin.
  for(const interrupted of [true,false]){
   const p=await fresh();
   await p.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=180;c.height=240;c.getContext('2d').fillRect(0,0,180,240);
    await acceptFiles([new File([await canvasBlob(c,'image/jpeg')],'photo.jpg',{type:'image/jpeg'})]);c.width=c.height=1;
    window.renderCalls=[];FilmifyEngine.setImage=()=>{};
    FilmifyEngine.develop=async style=>{renderCalls.push(style);const blob=new Blob([photos[state.selected[0]].file],{type:'image/jpeg'});return{blob,previewBlob:blob,width:180,height:240};};
    window.processingTask=startProcessing();
   });
   await p.waitForFunction(()=>!!outputs[state.selected[0]]&&state.page==='processing');await p.click('[data-action=cancel-process]');
   await p.evaluate(()=>{
    window.before={film:state.film,blob:outputs[state.selected[0]].blob};
    window.savedRandom=Math.random;Math.random=()=>.06;
   });
   await p.click('[data-action=dice]');await p.evaluate(()=>{Math.random=savedRandom;});
   await p.waitForFunction(()=>state.film!==before.film&&diceRolling);
   assert(await p.evaluate(()=>!outputs[state.selected[0]]&&collage===null),'film commit immediately invalidates old outputs');
   if(interrupted)await p.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide'));window.dispatchEvent(new PageTransitionEvent('pageshow'));});
   await p.waitForFunction(()=>!diceRolling);
   await p.click('[data-action=process]');await p.waitForSelector('.result-flow',{timeout:30000});
   const result=await p.evaluate(()=>({calls:renderCalls,style:selectedFilm().style,changed:outputs[state.selected[0]].blob!==before.blob}));
   assert.equal(result.calls.length,2);assert.equal(result.calls[1],result.style);assert(result.changed);await p.close();
   console.log('PASS random recipe renders fresh output; lifecycle interruption='+interrupted);
  }
  assert.deepEqual(errors,[]);console.log('RELEASE REGRESSION PASS');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
