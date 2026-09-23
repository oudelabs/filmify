// Real import/composition with controlled async boundaries; rendering math has separate gates.
'use strict';
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(process.env.FILMIFY_TEST_ROOT||path.join(__dirname,'../dist/xhs-tool'));
const server=http.createServer((req,res)=>{
 const f=path.resolve(ROOT,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));
 if(!f.startsWith(ROOT+path.sep)){res.writeHead(404);res.end();return;}
 fs.readFile(f,(error,data)=>{if(error){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff':'font/woff'})[path.extname(f)]||'application/octet-stream');res.end(data);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser(),errors=[];
 async function fresh(){
  const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto('http://127.0.0.1:'+server.address().port+'/');
  await p.evaluate(async()=>{
   window.makeFile=async i=>{const c=document.createElement('canvas');c.width=180;c.height=240;const g=c.getContext('2d');g.fillStyle=['#308aca','#ea7938','#45aa65'][i%3];g.fillRect(0,0,180,240);g.fillStyle='#e8cfab';g.fillRect(20+i*15,40,50,80);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));c.width=c.height=1;return new File([blob],'photo-'+i+'.jpg',{type:'image/jpeg'});};
   await acceptFiles([await makeFile(0),await makeFile(1)]);
   let image;window.renderCount=0;
   FilmifyEngine.setImage=im=>{image=im;};FilmifyEngine.develop=async()=>{renderCount++;const c=document.createElement('canvas');c.width=180;c.height=240;c.getContext('2d').drawImage(image,0,0,180,240);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));c.width=c.height=1;return{blob,previewBlob:blob,width:180,height:240};};
   const process=startProcessing;startProcessing=()=>{window.processingTask=process();return processingTask;};
   const compose=FilmifyCollageGrid.composeStatic;window.composes=[];
   FilmifyCollageGrid.composeStatic=async(...a)=>{composes.push({count:a[0].length,label:a[1],seed:a[2]});return compose(...a);};
   const revoke=URL.revokeObjectURL;window.revoked=[];URL.revokeObjectURL=u=>{revoked.push(u);revoke.call(URL,u);};
   window.saved=[];window.shared=[];window.filmifySavePhoto=async b=>saved.push(b);window.filmifySharePhotos=async b=>{shared=b;};FilmifyCollageGrid.supported=()=>'';
  });return p;
 }
 async function result(p){await p.waitForSelector('.result-flow',{timeout:30000});await p.evaluate(()=>processingTask);}
 async function checkDelivery(p){
  await p.evaluate(async()=>{await saveAll();await share();});
  assert(await p.evaluate(()=>saved[0]===collage.blob&&saved[1]===collage.negBlob&&shared[0]===collage.blob&&shared[1]===collage.negBlob),'save/share deliver the current two stills');
 }
 try{
  // The old composition finishes AFTER a new recipe has already reached results.
  for(const holdAt of [1,2]){
   const p=await fresh();
   await p.evaluate(holdAt=>{
    const compose=FilmifyCollageGrid.composeStatic;let calls=0;
    FilmifyCollageGrid.composeStatic=async(...a)=>{const n=++calls,blob=await compose(...a);if(n===holdAt){window.oldCells=a[0];window.held=true;await new Promise(r=>window.releaseOld=r);}return blob;};
   },holdAt);
   await p.click('[data-action=process]');await p.waitForFunction(()=>window.held);await p.evaluate(()=>{window.oldTask=processingTask;});
   await p.click('[data-action=cancel-process]');await p.click('[data-film="1"]');
   assert(await p.evaluate(()=>collage===null),'changing recipe invalidates collage');
   await p.click('[data-action=process]');await result(p);
   const before=await p.evaluate(()=>{window.newCollage=collage;return{label:collageFooterLabel(),calls:composes.length};});
   const after=await p.evaluate(async()=>{releaseOld();await oldTask;return{same:collage===newCollage,calls:composes.length,page:state.page,released:oldCells.every(i=>i.width<=1&&i.height<=1)};});
   assert(after.same&&after.released);assert.equal(after.page,'result');assert.equal(after.calls,before.calls);
   assert(await p.evaluate(label=>composes.slice(-2).every(c=>c.label===label),before.label));
   await checkDelivery(p);await p.close();
  }
  console.log('PASS cancelled composition cannot overwrite a completed new recipe; both await boundaries release cells');

  const append=await fresh();await append.click('[data-action=process]');await append.waitForFunction(()=>!!collage&&state.page==='processing');
  await append.click('[data-action=cancel-process]');await append.evaluate(async()=>{await processingTask;window.old=collage;window.oldOutputs=state.selected.map(id=>outputs[id]);});
  await append.click('[data-action=add]');await append.evaluate(async()=>acceptFiles([await makeFile(2)]));
  assert(await append.evaluate(()=>collage===null&&revoked.includes(old.url)&&revoked.includes(old.negUrl)&&oldOutputs.every((o,i)=>outputs[state.selected[i]]===o)),'append invalidates/revokes only group stills');
  await append.click('[data-action=process]');await result(append);
  assert.deepEqual(await append.evaluate(()=>({count:state.selected.length,renders:renderCount,composes:composes.map(c=>c.count),newBlob:collage.blob!==old.blob})),{count:3,renders:3,composes:[2,2,3,3],newBlob:true});
  await checkDelivery(append);await append.close();console.log('PASS append regenerates both 3-photo stills, preserves the first two outputs, saves/shares the new stills');

  // Hold the first BW job; the second is still queued when processing starts.
  const mono=await fresh();
  await mono.evaluate(()=>{
   const negative=FilmNegativePreview.render;window.bwCalls=0;
   FilmNegativePreview.render=async(...a)=>{if(a[2]==='bw'){bwCalls++;if(!window.heldBW){window.heldBW=true;await new Promise(r=>window.releaseBW=r);}}return negative(...a);};
   const compose=FilmifyCollageGrid.composeStatic;window.negativePixels=[];
   FilmifyCollageGrid.composeStatic=async(...a)=>{
    if(composes.length===1)negativePixels=a[0].map(img=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const g=c.getContext('2d');g.drawImage(img,0,0);const pixels=g.getImageData(0,0,c.width,c.height).data;let max=0;for(let i=0;i<pixels.length;i+=4)max=Math.max(max,Math.abs(pixels[i]-pixels[i+1]),Math.abs(pixels[i]-pixels[i+2]));c.width=c.height=1;return max;});
    return compose(...a);
   };
  });
  const film=await mono.evaluate(()=>FilmifyMaterials.films.findIndex(f=>f.mono));await mono.click('[data-film="'+film+'"]');await mono.waitForFunction(()=>window.heldBW);
  await mono.click('[data-action=process]');await mono.evaluate(()=>releaseBW());await result(mono);
  const negatives=await mono.evaluate(()=>({calls:bwCalls,pixels:negativePixels,ready:state.selected.every(id=>!photos[id].negBWPending&&photos[id].thumbNegBW!==photos[id].thumb)}));
  assert.equal(negatives.calls,2,'in-flight BW work is shared, not duplicated');assert(negatives.ready);assert.equal(negatives.pixels.length,2);assert(negatives.pixels.every(v=>v<=1),'every negative cell is grayscale');
  await checkDelivery(mono);await mono.close();console.log('PASS queued/in-flight BW negatives are prepared without deadlock; all exported negative cells are grayscale');

  // Export must fail and remain retryable when negative preparation fails.
  const failure=await fresh();
  await failure.evaluate(()=>{const negative=FilmNegativePreview.render;window.restoreNegative=()=>{FilmNegativePreview.render=negative;};FilmNegativePreview.render=async(...a)=>{if(a[2]==='bw')throw Error('negative fixture failure');return negative(...a);};});
  await failure.click('[data-film="'+film+'"]');await failure.click('[data-action=process]');await failure.waitForSelector('.sheet-backdrop',{timeout:30000});
  assert(await failure.evaluate(()=>!busy&&collage===null&&Object.keys(outputs).length===2),'no fallback still committed on failure');
  await failure.click('[data-action=close-sheet]');await failure.evaluate(()=>restoreNegative());await failure.click('[data-action=process]');await result(failure);
  assert(await failure.evaluate(()=>renderCount===2&&state.selected.every(id=>photos[id].thumbNegBW!==photos[id].thumb)),'retry prepares negatives and reuses outputs');
  await failure.close();console.log('PASS failed negative preparation aborts composition; retry recovers without re-rendering completed photos');
  assert.deepEqual(errors,[]);console.log('COLLAGE STATE PASS');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
