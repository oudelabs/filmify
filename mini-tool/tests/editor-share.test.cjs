const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {launchBrowser}=require('../scripts/launch-browser.cjs');
let browser;
test.before(async()=>{browser=await launchBrowser();});
test.after(async()=>{if(browser)await browser.close();});

async function fixture(count=1){
 const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.setContent('<div id="studio" class="app phone"><div id="screen"></div></div>');
 await page.addStyleTag({content:fs.readFileSync('minitool/studio.css','utf8')+'\n'+fs.readFileSync('minitool/editor-share.css','utf8')});
 for(const name of ['print-design','collage-grid','collage-compare','clothesline','editor-share'])await page.addScriptTag({content:fs.readFileSync('minitool/'+name+'.js','utf8')});
 await page.evaluate(async count=>{
  window.FilmifyPrintDesign.ready=async()=>{};
  window.FilmifyClothesline.ready=async()=>{};
  window.FilmifyCollageGrid.supported=()=>{throw Error('live media forbidden');};
  window.saved=[];window.notes=[];window.filmifyBrowserMode=()=>false;
  window.filmifySavePhoto=async(blob,name,guard)=>{guard();saved.push({id:masters.findIndex(output=>output.blob===blob),name});};
  window.filmifySharePhotos=async(blobs,note,guard)=>{guard(true);notes.push({ids:blobs.map(blob=>masters.findIndex(output=>output.blob===blob)),note});};
  window.makeBatch=async count=>{
   const originals=[],outputs=[];
   for(let i=0;i<count;i++){
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=320;const g=canvas.getContext('2d');g.fillStyle='rgb('+(40+i*12)+',90,130)';g.fillRect(0,0,240,320);g.fillStyle='#ddd';g.fillRect(60,80,80,80);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.94)),url=URL.createObjectURL(blob);
    originals.push({id:i+1,sourceBlob:blob,width:240,height:320,previewURL:url});outputs.push({id:i+1,blob:blob,width:240,height:320,previewURL:url});canvas.width=canvas.height=1;
   }
   return {photos:originals,outputs:outputs,seed:291,theme:'black'};
  };
  window.batch=await makeBatch(count);window.masters=batch.outputs;
  window.controller=FilmifyEditorShare.create({container:document.querySelector('#screen')});await controller.showResults(batch);
 },count);
 return page;
}
test('saving all results always delivers unchanged master Blobs even when the collage is viewed',async()=>{
 const page=await fixture(9);
 try{
  for(let i=0;i<9;i++)await page.locator('.slide[tabindex="0"]').press('ArrowRight');
  assert.equal(await page.locator('#dots .num').textContent(),'10 / 10');
  await page.evaluate(()=>controller.saveAll());
  assert.deepEqual(await page.evaluate(()=>saved.map(item=>item.id)),[0,1,2,3,4,5,6,7,8]);
  await page.click('[data-action="download-result"]');await page.click('[data-action="save-current"]');
  await page.waitForFunction(()=>saved.length===10);assert.equal(await page.evaluate(()=>saved[9].id),-1,'current collage can be saved separately');
 }finally{await page.close();}
});
test('static sharing keeps selected master ordering and recipe-free hashtags',async()=>{
 const page=await fixture(9);
 try{
  await page.click('[data-action="share"]');await page.click('[data-action="publish"]');
  await page.waitForFunction(()=>notes.length===1);const result=await page.evaluate(()=>notes[0]);
  assert.deepEqual(result.ids,[0,1,2,3,4,5,6,7,8]);
  assert.equal(result.note.tags,'Filmify,胶片感');assert.ok(result.note.content.endsWith('\n\n#Filmify #胶片感'));
  assert.doesNotMatch(result.note.content,/配方|Portra|Gold|ENDURA|曝光|显影/);
 }finally{await page.close();}
});
test('captions cover six choices before reuse, stay stable through retries and style changes, and never repeat consecutively',async()=>{
 const page=await fixture();
 try{
  const choices=['用个小工具，把日常冲成胶片。','手机里的照片，值得再冲一次。','工具不大，出片有点东西。','小工具，也能冲出大效果。','小小冲印室，出片有惊喜。','给日常，再加点故事感'];
  await page.evaluate(()=>{
   Math.random=()=>0;
   window.rejectPostOnce=true;
   filmifySharePhotos=async(blobs,note,guard)=>{guard(true);notes.push({note});if(rejectPostOnce){rejectPostOnce=false;throw Error('native post failed');}};
  });
  const publish=async()=>{const before=await page.evaluate(()=>notes.length);await page.click('[data-action="publish"]');await page.waitForFunction(n=>notes.length>n&&!document.querySelector('[data-action="publish"]').disabled,before);return page.evaluate(()=>notes[notes.length-1].note);};
  await page.click('[data-action="share"]');const failed=await publish(),retry=await publish();assert.deepEqual(retry,failed);
  await page.click('[data-share-style="frame"]');await page.waitForFunction(()=>!controller.diagnostics().preparing);assert.deepEqual(await publish(),retry);
  const seen=[retry.content.split('\n')[0]];
  for(let i=1;i<12;i++){
   await page.click('[data-action="share-back"]');await page.click('[data-action="share"]');
   const note=await publish(),text=note.content.split('\n')[0];assert(choices.includes(text));assert.notEqual(text,seen[seen.length-1]);assert.equal(note.tags,'Filmify,胶片感');assert(note.content.endsWith('\n\n#Filmify #胶片感'));seen.push(text);
  }
  assert.equal(new Set(seen.slice(0,6)).size,6);assert.equal(new Set(seen.slice(6,12)).size,6);
 }finally{await page.close();}
});
test('retry dismisses the reported share-generation error before a new preview completes',async()=>{
 const page=await fixture();
 try{
  await page.evaluate(async()=>{
   controller.release();window.errorDismissals=0;window.errorReports=0;window.holdRetry=false;window.resumeRetry=null;
   controller=FilmifyEditorShare.create({container:document.querySelector('#screen'),onError:()=>{errorReports++;return ()=>errorDismissals++;}});await controller.showResults(batch);
   const render=FilmifyCompare.render;let fail=true;FilmifyCompare.render=async(...args)=>{if(fail){fail=false;throw Error('encoder failed');}if(holdRetry)await new Promise(resolve=>resumeRetry=resolve);return render(...args);};
  });
  await page.click('[data-action="share"]');await page.click('[data-share-style="compare"]');await page.waitForSelector('[data-action="share-retry"]');
  assert.equal(await page.evaluate(()=>errorReports),1);assert.equal(await page.evaluate(()=>errorDismissals),0);
  await page.evaluate(()=>holdRetry=true);await page.click('[data-action="share-retry"]');await page.waitForFunction(()=>!!resumeRetry);
  assert.equal(await page.evaluate(()=>errorDismissals),1);assert.equal(await page.locator('[data-action="save-share"]').isDisabled(),true);
  await page.evaluate(()=>resumeRetry());await page.waitForFunction(()=>!controller.diagnostics().preparing);assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
  await page.evaluate(()=>controller.release());assert.equal(await page.evaluate(()=>errorDismissals),1);
 }finally{await page.close();}
});
test('plain frames and collage survive unavailable branding; cached frame revisits avoid recomposition',async()=>{
 const page=await fixture(2);
 try{
  await page.evaluate(()=>{
   window.frameCompositions=0;const compose=FilmifyPrintDesign.compose;FilmifyPrintDesign.compose=(...args)=>{frameCompositions++;return compose(...args);};
   FilmifyPrintDesign.ready=async()=>{throw Error('branding unavailable');};
  });
  await page.click('[data-action="share"]');await page.click('[data-share-style="frame"]');await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.evaluate(()=>frameCompositions),2);
  await page.click('[data-share-style="effect"]');await page.click('[data-share-style="frame"]');await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.evaluate(()=>frameCompositions),2);
  assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
  const before=await page.evaluate(()=>controller.diagnostics());assert.ok(before.cacheBytes>0&&before.cacheBytes<=before.cacheLimit);
  await page.evaluate(()=>controller.release());const after=await page.evaluate(()=>controller.diagnostics());assert.equal(after.ownedURLs,0);assert.equal(after.cacheBytes,0);
 }finally{await page.close();}
});
test('all four static styles remain available and compare labels contain no recipe',async()=>{
 const page=await fixture();
 try{
  await page.evaluate(()=>{
   window.compareOptions=[];const render=FilmifyCompare.render;FilmifyCompare.render=(a,b,opts,size)=>{compareOptions.push(opts);return render(a,b,opts,size);};
   // The real clothesline painter needs its clip atlas; a fixed Blob isolates
   // controller ordering/cancellation from that separately tested geometry.
   FilmifyClothesline.compose=async()=>masters[0].blob;
  });
  await page.click('[data-action="share"]');
  assert.equal(await page.locator('[data-share-style]').count(),4);
  for(const style of ['frame','hanging','compare','effect']){
   await page.click('[data-share-style="'+style+'"]');await page.waitForFunction(()=>!controller.diagnostics().preparing);
   assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true,style);
  }
  const captions=await page.evaluate(()=>compareOptions);assert.equal(captions.length,1);assert.equal(captions[0].film,'');assert.equal(captions[0].paper,null);assert.equal(captions[0].effectLabel,'EFFECT');
 }finally{await page.close();}
});
test('a cancelled hanging composition cannot overwrite a replacement photo batch',async()=>{
 const page=await fixture();
 try{
  await page.evaluate(()=>{window.started=false;FilmifyClothesline.compose=async()=>{started=true;return new Promise(resolve=>window.finishHanging=resolve);};});
  await page.click('[data-action="share"]');await page.click('[data-share-style="hanging"]');await page.waitForFunction(()=>started);
  await page.evaluate(async()=>{const replacement=await makeBatch(1);window.masters=replacement.outputs;await controller.showResults(replacement);finishHanging(batch.outputs[0].blob);});
  await page.waitForTimeout(30);assert.equal(await page.locator('.share-flow').count(),0);assert.equal(await page.locator('#dots .num').textContent(),'1 / 1');
  await page.evaluate(()=>controller.saveAll());assert.deepEqual(await page.evaluate(()=>saved.map(item=>item.id)),[0]);
  await page.evaluate(()=>controller.release());assert.equal(await page.evaluate(()=>controller.diagnostics().ownedURLs),0);
 }finally{await page.close();}
});
test('leaving while writing a native temporary file prevents album delivery',async()=>{
 const page=await fixture();
 try{
  await page.addScriptTag({content:fs.readFileSync('minitool/host.js','utf8')});
  await page.evaluate(()=>{
   window.albumCalls=0;window.writeStarted=false;
   window.xhs={miniTool:{writeTempFile:async()=>{writeStarted=true;return new Promise(resolve=>window.finishWrite=resolve);},saveImageToPhotosAlbum:async()=>albumCalls++}};
   window.saveTask=controller.saveAll();
  });
  await page.waitForFunction(()=>writeStarted);await page.evaluate(async()=>{controller.hide();finishWrite({filePath:'native-file:late'});await saveTask;});
  assert.equal(await page.evaluate(()=>albumCalls),0);assert.equal(await page.evaluate(()=>controller.diagnostics().ioBusy),false);
 }finally{await page.close();}
});
test('the result viewer keeps one master and returns the original preview DOM on close',async()=>{
 const page=await fixture(2);
 try{
  await page.evaluate(()=>{window.originalSlide=document.querySelector('.slide');window.originalPreview=originalSlide.firstElementChild;});
  await page.locator('.slide[tabindex="0"]').press('Enter');
  await page.waitForFunction(()=>document.querySelector('.viewer-content img').naturalWidth>0);
  assert.equal(await page.locator('#screen').getAttribute('inert'),'');
  await page.locator('.result-viewer').press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('.viewer-content img').naturalWidth>0);
  await page.locator('.result-viewer').press('ArrowLeft');await page.click('.viewer-close');
  assert.equal(await page.locator('.result-viewer').count(),0);
  assert.equal(await page.evaluate(()=>document.querySelector('.slide')===originalSlide&&originalSlide.firstElementChild===originalPreview),true);
  assert.equal(await page.locator('#screen').getAttribute('inert'),null);
 }finally{await page.close();}
});
test('browser saving downloads the master bytes and does not offer native publication',async()=>{
 const page=await fixture();
 try{
  await page.addScriptTag({content:fs.readFileSync('minitool/host.js','utf8')});
  await page.addScriptTag({content:fs.readFileSync('minitool/browser-save.js','utf8')});
  const expected=await page.evaluate(async()=>Array.from(new Uint8Array(await masters[0].blob.arrayBuffer())));
  const downloading=page.waitForEvent('download');await page.click('[data-action="download-result"]');const download=await downloading;
  const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  assert.deepEqual(Array.from(Buffer.concat(chunks)),expected);assert.match(download.suggestedFilename(),/^filmify-photo-1\.jpg$/);
  await page.click('[data-action="share"]');assert.equal(await page.locator('[data-action="publish"]').count(),0);
 }finally{await page.close();}
});
test('a stalled shared atlas wait does not block another selected static style',async()=>{
 const page=await fixture();
 try{
  await page.evaluate(()=>{FilmifyClothesline.ready=()=>new Promise(()=>{});});
  await page.click('[data-action="share"]');await page.click('[data-share-style="hanging"]');
  await page.click('[data-share-style="frame"]');await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
 }finally{await page.close();}
});
test('a real hanging atlas with no load callback times out and can be retried into a full-size JPEG',async()=>{
 const page=await fixture(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  // Restore the actual loader and painter: the shared fixture normally stubs
  // ready(), while controller-only hanging tests intentionally stub compose().
  await page.addScriptTag({content:fs.readFileSync('minitool/clothesline.js','utf8')});
  await page.evaluate(atlas=>{
   Promise.prototype.finally=undefined;
   window.atlasRequests=0;window.stallAtlas=true;window.resourceDeadlines=new Map();
   const source=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src'),schedule=setTimeout,clear=clearTimeout;
   Object.defineProperty(HTMLImageElement.prototype,'src',{configurable:true,get:source.get,set(value){
    if(String(value).includes('assets/clothesline-clips.png')){atlasRequests++;if(stallAtlas)return;value=atlas;}
    source.set.call(this,value);
   }});
   // Advance only a resource's documented long deadline. Short scheduling,
   // drawing, image decoding and JPEG callbacks keep their real timing.
   window.setTimeout=(callback,delay,...args)=>{const id=schedule(callback,delay,...args);if(delay>=10000&&delay<=60000)resourceDeadlines.set(id,{callback,delay,args});return id;};
   window.clearTimeout=id=>{resourceDeadlines.delete(id);clear(id);};
   window.expireResourceDeadline=()=>{const first=Array.from(resourceDeadlines.entries()).sort((a,b)=>a[1].delay-b[1].delay)[0];if(!first)throw Error('No bounded resource deadline');resourceDeadlines.delete(first[0]);clear(first[0]);first[1].callback(...first[1].args);};
  },'data:image/png;base64,'+fs.readFileSync('minitool/assets/clothesline-clips.png').toString('base64'));
  await page.click('[data-action="share"]');await page.click('[data-share-style="hanging"]');await page.waitForFunction(()=>atlasRequests===1);
  assert.equal(await page.evaluate(()=>controller.diagnostics().preparing),true);
  assert.equal(await page.locator('[data-action="save-share"]').isDisabled(),true);
  assert(await page.evaluate(()=>resourceDeadlines.size>0),'An atlas that never loads must have a bounded failure deadline');
  await page.evaluate(()=>expireResourceDeadline());await page.waitForSelector('[data-action="share-retry"]',{timeout:2000});
  assert.match(await page.locator('.share-status').textContent(),/超时/);
  assert.equal(await page.evaluate(()=>controller.diagnostics().preparing),false);
  await page.evaluate(()=>{stallAtlas=false;});await page.click('[data-action="share-retry"]');
  await page.waitForFunction(()=>!controller.diagnostics().preparing&&document.querySelector('#track img')?.naturalWidth>0,{},{timeout:15000});
  assert.equal(await page.locator('[data-share-style="hanging"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
  const output=await page.locator('#track .slide').evaluate(async slide=>{
   const blob=slide._fullBlob,url=URL.createObjectURL(blob),image=new Image();
   try{image.src=url;await image.decode();return {type:blob.type,width:image.naturalWidth,height:image.naturalHeight};}finally{image.src='';URL.revokeObjectURL(url);}
  });
  assert.deepEqual(output,{type:'image/jpeg',width:2400,height:3200});
  assert.equal(await page.evaluate(()=>atlasRequests),2,'Retry must start a fresh atlas load');
  await page.evaluate(()=>controller.release());assert.equal(await page.evaluate(()=>controller.diagnostics().ownedURLs),0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
for(const stage of ['writeTempFile','saveImageToPhotosAlbum','postNote'])test('a stalled native '+stage+' keeps share-page return available and ignores late completion',async()=>{
 const page=await fixture(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.addScriptTag({content:fs.readFileSync('minitool/host.js','utf8')});
  await page.evaluate(stage=>{
   Promise.prototype.finally=undefined;
   window.nativeCalls={writeTempFile:0,saveImageToPhotosAlbum:0,postNote:0};window.nativeStalled=false;window.finishNative=null;
   const call=name=>{nativeCalls[name]++;if(name===stage){nativeStalled=true;return new Promise(resolve=>{finishNative=()=>resolve(name==='writeTempFile'?{filePath:'native-file:late'}:{});});}return Promise.resolve(name==='writeTempFile'?{filePath:'native-file:'+nativeCalls[name]}:{});};
   // Only the SDK boundary is mocked. The real host adapter still reads the
   // Blob, writes handles and applies the controller's cancellation guard.
   window.xhs={miniTool:{writeTempFile:()=>call('writeTempFile'),saveImageToPhotosAlbum:()=>call('saveImageToPhotosAlbum'),postNote:()=>call('postNote')}};
  },stage);
  await page.click('[data-action="share"]');await page.waitForFunction(()=>!controller.diagnostics().preparing);
  await page.click('[data-action="'+(stage==='postNote'?'publish':'save-share')+'"]');await page.waitForFunction(()=>nativeStalled);
  assert.equal(await page.evaluate(()=>controller.diagnostics().ioBusy),true);
  const before=await page.evaluate(()=>({...nativeCalls}));
  assert.equal(await page.locator('[data-action="share-back"]').isEnabled(),true,'A native callback that never arrives must not trap the user on the share page');
  await page.click('[data-action="share-back"]');assert.equal(await page.locator('.share-flow').count(),0);
  assert.equal(await page.evaluate(()=>controller.diagnostics().ioBusy),false);
  await page.click('[data-action="share"]');await page.click('[data-share-style="frame"]');await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
  const current=await page.evaluate(()=>({diagnostics:controller.diagnostics(),url:document.querySelector('#track img').src}));
  await page.evaluate(()=>{finishNative();});await page.waitForTimeout(30);
  assert.deepEqual(await page.evaluate(()=>({...nativeCalls})),before,'An abandoned write must not continue to the album or composer');
  assert.deepEqual(await page.evaluate(()=>({diagnostics:controller.diagnostics(),url:document.querySelector('#track img').src})),current,'A late SDK result must not alter the replacement share page');
  assert.equal(await page.locator('.editor-share-toast').count(),0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
for(const stage of ['writeTempFile','saveImageToPhotosAlbum'])test('a stalled native '+stage+' reaches a bounded save failure and offers explicit retry',async()=>{
 const page=await fixture();
 try{
  await page.addScriptTag({content:fs.readFileSync('minitool/host.js','utf8')});
  await page.evaluate(stage=>{
   Promise.prototype.finally=undefined;
   window.nativeStalled=false;window.nativeCalls={writeTempFile:0,saveImageToPhotosAlbum:0};window.nativeDeadlines=new Map();
   const schedule=setTimeout,clear=clearTimeout;
   window.setTimeout=(callback,delay,...args)=>{const id=schedule(callback,delay,...args);if(delay>=10000&&delay<=60000)nativeDeadlines.set(id,{callback,args,delay});return id;};
   window.clearTimeout=id=>{nativeDeadlines.delete(id);clear(id);};
   window.expireNativeDeadline=()=>{const first=Array.from(nativeDeadlines.entries()).sort((a,b)=>a[1].delay-b[1].delay)[0];if(!first)throw Error('No native save deadline');nativeDeadlines.delete(first[0]);clear(first[0]);first[1].callback(...first[1].args);};
   const call=name=>{nativeCalls[name]++;if(name===stage){nativeStalled=true;return new Promise(resolve=>{window.finishNativeSave=()=>resolve(name==='writeTempFile'?{filePath:'native-file:late'}:{});});}return Promise.resolve({filePath:'native-file:ok'});};
   window.xhs={miniTool:{writeTempFile:()=>call('writeTempFile'),saveImageToPhotosAlbum:()=>call('saveImageToPhotosAlbum')}};
  },stage);
  await page.click('[data-action="share"]');await page.click('[data-action="save-share"]');await page.waitForFunction(()=>nativeStalled);
  assert(await page.evaluate(()=>nativeDeadlines.size>0),'A missing native save callback must have a finite failure deadline');
  await page.evaluate(()=>expireNativeDeadline());await page.waitForSelector('[data-action="retry-save"]',{timeout:2000});
  assert.match(await page.locator('.sheet').textContent(),/超时/);
  assert.equal(await page.evaluate(()=>controller.diagnostics().ioBusy),false);
  assert.equal(await page.locator('[data-action="share-back"]').isEnabled(),true);
  const before=await page.evaluate(()=>({...nativeCalls}));await page.evaluate(()=>{finishNativeSave();});await page.waitForTimeout(30);
  assert.deepEqual(await page.evaluate(()=>({...nativeCalls})),before,'A late failed-stage result must not resume the old operation');
  assert.equal(await page.locator('[data-action="retry-save"]').isVisible(),true);
 }finally{await page.close();}
});
test('a native post composer may remain open longer than save deadlines without a false timeout',async()=>{
 const page=await fixture();
 try{
  await page.clock.install();await page.addScriptTag({content:fs.readFileSync('minitool/host.js','utf8')});
  await page.evaluate(()=>{
   Promise.prototype.finally=undefined;window.nativeComposerOpen=false;window.nativePosts=0;
   window.xhs={miniTool:{writeTempFile:async()=>({filePath:'native-file:ok'}),postNote:()=>{nativePosts++;nativeComposerOpen=true;return new Promise(resolve=>{window.finishComposer=resolve;});}}};
  });
  await page.click('[data-action="share"]');await page.click('[data-action="publish"]');await page.waitForFunction(()=>nativeComposerOpen);
  await page.clock.fastForward(120000);
  assert.equal(await page.evaluate(()=>controller.diagnostics().ioBusy),true,'The user can still be editing the native note after two minutes');
  assert.equal(await page.locator('.editor-share-toast').filter({hasText:'超时'}).count(),0);
  assert.equal(await page.evaluate(()=>nativePosts),1,'A slow native composer must never trigger a second post');
  await page.evaluate(()=>{finishComposer();});await page.waitForFunction(()=>!controller.diagnostics().ioBusy);
  assert.equal(await page.locator('[data-action="publish"]').isEnabled(),true);
 }finally{await page.close();}
});
test('a submitted native post remains pending while its editor hides the webview',async()=>{
 const page=await fixture(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.addScriptTag({content:fs.readFileSync('minitool/host.js','utf8')});
  await page.evaluate(()=>{
   Promise.prototype.finally=undefined;window.nativeComposerOpen=false;window.nativePosts=0;window.nativeEditorHidden=false;
   Object.defineProperty(document,'hidden',{configurable:true,get:()=>nativeEditorHidden});
   window.xhs={miniTool:{writeTempFile:async()=>({filePath:'native-file:ok'}),postNote:()=>{nativePosts++;nativeComposerOpen=true;return new Promise(resolve=>{window.finishHiddenComposer=resolve;});}}};
  });
  await page.click('[data-action="share"]');await page.click('[data-action="publish"]');await page.waitForFunction(()=>nativeComposerOpen);
  await page.evaluate(()=>{nativeEditorHidden=true;document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>controller.diagnostics().ioBusy),true,'Opening the native editor normally hides the webview and must not cancel a submitted post');
  assert.equal(await page.evaluate(()=>nativePosts),1);
  await page.evaluate(()=>{finishHiddenComposer();});await page.waitForFunction(()=>!controller.diagnostics().ioBusy);
  await page.evaluate(()=>{nativeEditorHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await page.locator('[data-action="publish"]').isEnabled(),true);
  assert.equal(await page.locator('.editor-share-toast').count(),0);assert.equal(await page.evaluate(()=>nativePosts),1);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
async function holdOneEncoder(page){
 await page.evaluate(()=>{
  const encode=HTMLCanvasElement.prototype.toBlob;let first=true;window.heldEncoder=null;
  HTMLCanvasElement.prototype.toBlob=function(callback,...args){
   if(!first){encode.call(this,callback,...args);return;}first=false;const canvas=this;
   encode.call(this,blob=>{heldEncoder={canvas,blob,callback};},...args);
  };
 });
}
test('an encoder with no callback is cancelled on return and cannot block or overwrite the next template',async()=>{
 const page=await fixture(2);
 try{
  await page.evaluate(()=>{Promise.prototype.finally=undefined;});
  await holdOneEncoder(page);await page.click('[data-action="share"]');await page.click('[data-share-style="frame"]');await page.waitForFunction(()=>!!heldEncoder);
  await page.click('[data-action="share-back"]');await page.click('[data-action="share"]');await page.click('[data-share-style="compare"]');
  await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
  assert.deepEqual(await page.evaluate(()=>[heldEncoder.canvas.width,heldEncoder.canvas.height]),[1,1]);
  const before=await page.evaluate(()=>({diagnostics:controller.diagnostics(),url:document.querySelector('#track img').src}));
  await page.evaluate(()=>{heldEncoder.callback(heldEncoder.blob);heldEncoder.callback(null);});await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(()=>({diagnostics:controller.diagnostics(),url:document.querySelector('#track img').src})),before);
  assert.equal(await page.locator('[data-action="share-retry"]').count(),0);
 }finally{await page.close();}
});
test('an encoder timeout releases pixels, offers retry, and ignores the old callback after success',async()=>{
 const page=await fixture();
 try{
  await page.evaluate(()=>{const schedule=setTimeout;window.encodingTimeout=null;window.setTimeout=(callback,delay,...args)=>{if(delay===30000)encodingTimeout=callback;return schedule(callback,delay,...args);};});
  await holdOneEncoder(page);await page.click('[data-action="share"]');await page.click('[data-share-style="frame"]');await page.waitForFunction(()=>!!heldEncoder&&!!encodingTimeout);
  await page.evaluate(()=>encodingTimeout());await page.waitForSelector('[data-action="share-retry"]');
  assert.match(await page.locator('.share-status').textContent(),/编码超时/);assert.equal(await page.locator('[data-action="save-share"]').isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>[heldEncoder.canvas.width,heldEncoder.canvas.height]),[1,1]);
  await page.click('[data-action="share-retry"]');await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
  await page.evaluate(()=>heldEncoder.callback(null));await page.waitForTimeout(50);
  assert.equal(await page.locator('[data-action="share-retry"]').count(),0);assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
 }finally{await page.close();}
});
test('backgrounding cancels a missing encoder and foregrounding resumes the selected template',async()=>{
 const page=await fixture();
 try{
  await holdOneEncoder(page);await page.click('[data-action="share"]');await page.click('[data-share-style="frame"]');await page.waitForFunction(()=>!!heldEncoder);
  await page.evaluate(()=>{window.reviewHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>reviewHidden});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>heldEncoder.canvas.width===1&&heldEncoder.canvas.height===1);
  await page.evaluate(()=>{reviewHidden=false;document.dispatchEvent(new Event('visibilitychange'));});await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.locator('[data-share-style="frame"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
  await page.evaluate(()=>heldEncoder.callback(heldEncoder.blob));await page.waitForTimeout(50);
  assert.equal(await page.locator('[data-action="save-share"]').isEnabled(),true);
 }finally{await page.close();}
});
test('a cancelled static collage encoder settles before the replacement batch renders',async()=>{
 const page=await fixture();
 try{
  await page.evaluate(async()=>{window.twoPhotos=await makeBatch(2);window.replacement=await makeBatch(2);});
  await holdOneEncoder(page);await page.evaluate(()=>{window.oldCollage=controller.showResults(twoPhotos);});await page.waitForFunction(()=>!!heldEncoder);
  await page.evaluate(()=>{window.newCollage=controller.showResults(replacement);});
  await page.evaluate(()=>Promise.all([oldCollage,newCollage]));
  assert.deepEqual(await page.evaluate(()=>[heldEncoder.canvas.width,heldEncoder.canvas.height]),[1,1]);
  assert.equal(await page.locator('#dots .num').textContent(),'1 / 3');
  const before=await page.evaluate(()=>controller.diagnostics());await page.evaluate(()=>heldEncoder.callback(heldEncoder.blob));await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(()=>controller.diagnostics()),before);
 }finally{await page.close();}
});
test('keyboard sharing keeps logical focus across styles, selection, return and sheet dismissal',async()=>{
 const page=await fixture(2);
 try{
  // Template pixels have their own tests. Immediate real JPEGs isolate the
  // controller's DOM replacement and keyboard lifecycle here.
  await page.evaluate(()=>{FilmifyPrintDesign.compose=async()=>masters[0].blob;});
  await page.locator('[data-action="share"]').focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.shareStyle),'effect');
  await page.locator('[data-share-style="frame"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.shareStyle),'frame');
  await page.locator('[data-share-index="1"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.shareIndex),'1');
  assert.equal(await page.locator('[data-share-index="1"]').getAttribute('aria-pressed'),'false');
  await page.locator('[data-action="share-back"]').focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'share');
  await page.locator('[data-action="download-result"]').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('.sheet-backdrop').count(),1);await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sheet-backdrop').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'download-result');
 }finally{await page.close();}
});
test('asynchronous share completion preserves a later control or outside focus',async()=>{
 const page=await fixture(2);
 try{
  await page.evaluate(()=>{
   const button=document.createElement('button');button.id='outside-focus';button.textContent='Outside';document.body.appendChild(button);
   let first=true;window.frameStarted=false;window.hangingStarted=false;
   FilmifyPrintDesign.compose=()=>{if(!first)return Promise.resolve(masters[0].blob);first=false;frameStarted=true;return new Promise(resolve=>window.finishFrame=()=>resolve(masters[0].blob));};
   FilmifyClothesline.compose=()=>{window.hangingStarted=true;return new Promise(resolve=>window.finishHanging=()=>resolve(masters[0].blob));};
   FilmifyCompare.render=async()=>masters[0].blob;
  });
  await page.locator('[data-action="share"]').focus();await page.keyboard.press('Enter');
  await page.locator('[data-share-style="frame"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>frameStarted);
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.dataset.shareStyle),'hanging');
  await page.evaluate(()=>finishFrame());await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.shareStyle),'hanging','completion must preserve the new control, not the initiating frame button');
  // Use a single selected photo so this deferred template has one completion.
  await page.locator('[data-share-index="1"]').click();await page.waitForFunction(()=>!controller.diagnostics().preparing);
  await page.locator('[data-share-style="hanging"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>hangingStarted);
  await page.evaluate(()=>document.getElementById('outside-focus').focus());await page.evaluate(()=>finishHanging());await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'outside-focus');
  await page.evaluate(()=>document.querySelector('[data-share-style="compare"]').click());await page.waitForFunction(()=>!controller.diagnostics().preparing);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'outside-focus','programmatic refresh must not claim focus from outside');
 }finally{await page.close();}
});
test('keyboard carousel focus follows the current slide and viewer; pointer paging does not claim focus',async()=>{
 const page=await fixture(2);
 try{
  await page.locator('.slide[tabindex="0"]').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#dots .num').textContent(),'2 / 3');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.slide[tabindex="0"]')),true);
  await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#dots .num').textContent(),'1 / 3');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.slide[tabindex="0"]')),true);
  await page.keyboard.press('Enter');await page.waitForSelector('.result-viewer');await page.keyboard.press('ArrowRight');await page.keyboard.press('Escape');
  assert.equal(await page.locator('.result-viewer').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.slide[tabindex="0"]')),true);
  await page.evaluate(()=>{const button=document.createElement('button');button.id='outside-focus';document.body.appendChild(button);button.focus();});
  const sw=page.locator('#swiper'),r=await sw.boundingBox();
  await sw.dispatchEvent('pointerdown',{pointerId:7,isPrimary:true,button:0,clientX:r.x+200,clientY:r.y+80});
  await sw.dispatchEvent('pointermove',{pointerId:7,isPrimary:true,buttons:1,clientX:r.x+30,clientY:r.y+80});
  await sw.dispatchEvent('pointerup',{pointerId:7,isPrimary:true,button:0,clientX:r.x+30,clientY:r.y+80});
  assert.equal(await page.locator('#dots .num').textContent(),'3 / 3');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'outside-focus');
 }finally{await page.close();}
});
test('save sheet actions and failed-save retry restore the caller without stealing later outside focus',async()=>{
 const page=await fixture(2);
 try{
  await page.locator('[data-action="download-result"]').focus();await page.keyboard.press('Enter');
  await page.locator('[data-action="save-current"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>!controller.diagnostics().ioBusy&&saved.length===1);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'download-result');
  await page.evaluate(()=>{let fail=true;filmifySavePhoto=async(blob,name,guard)=>{guard();if(fail){fail=false;throw new Error('Album permission denied');}saved.push({id:masters.findIndex(output=>output.blob===blob),name});};});
  await page.locator('[data-action="download-result"]').focus();await page.keyboard.press('Enter');
  await page.locator('[data-action="save-all"]').focus();await page.keyboard.press('Enter');await page.waitForSelector('[data-action="retry-save"]');await page.waitForFunction(()=>!controller.diagnostics().ioBusy);
  await page.locator('[data-action="retry-save"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>!controller.diagnostics().ioBusy&&saved.length===3);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'download-result');
  await page.evaluate(()=>{
   const button=document.createElement('button');button.id='outside-focus';document.body.appendChild(button);
   filmifySavePhoto=(blob,name,guard)=>new Promise(resolve=>window.finishSave=()=>{guard();resolve();});
  });
  await page.locator('[data-action="download-result"]').focus();await page.keyboard.press('Enter');
  await page.locator('[data-action="save-current"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>typeof finishSave==='function');
  await page.evaluate(()=>document.getElementById('outside-focus').focus());await page.evaluate(()=>finishSave());await page.waitForFunction(()=>!controller.diagnostics().ioBusy);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'outside-focus');
 }finally{await page.close();}
});
