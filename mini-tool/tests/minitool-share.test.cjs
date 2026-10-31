const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

function adapter(postNote,extra={}){
 const files=[];
 const sdk={postNote,writeTempFile:async({data})=>{files.push(data);return {filePath:'native-file:'+files.length};},...extra};
 const context={window:{xhs:{miniTool:sdk}},setTimeout,clearTimeout,setInterval,clearInterval,FileReader:class{
  readAsDataURL(blob){this.result='data:'+(blob.type||'image/png')+';base64,'+(blob.value||blob);this.onload();}
 }};
 vm.createContext(context);vm.runInContext(fs.readFileSync('minitool/host.js','utf8'),context);return {host:context.window,files};
}

test('18 stills preserve original/effect ordering and use native file handles in one post',async()=>{
 const calls=[],{host,files}=adapter(async data=>calls.push(JSON.parse(JSON.stringify(data))));
 const blobs=Array.from({length:9},(_,i)=>['original'+i,'effect'+i]).flat();
 await host.filmifySharePhotos(blobs);
 assert.equal(calls.length,1);assert.equal(calls[0].pageType,'photo_publish');
 assert.deepEqual(files,blobs.map(b=>'data:image/png;base64,'+b));
 assert.deepEqual(calls[0].mediaInfo.image_resources.map(item=>item.url),blobs.map((b,i)=>'native-file:'+(i+1)));
});
test('rejects empty/over-limit batches before writing files or calling the host',async()=>{
 let calls=0;const {host,files}=adapter(async()=>calls++);
 await assert.rejects(host.filmifySharePhotos([]),/1–18/);
 await assert.rejects(host.filmifySharePhotos(Array(19).fill('image')),/1–18/);
 await assert.rejects(host.filmifyShareLiveGroup(Array(18).fill('image'),'cover','video'),/1–17/);
 assert.equal(calls,0);assert.equal(files.length,0);
});
test('native failure is propagated for retry, never converted to a success',async()=>{
 const {host}=adapter(async()=>{throw new Error('permission denied');});
 await assert.rejects(host.filmifySharePhotos(['effect']),/permission denied/);
});
test('live group uses the working iOS 9.48 field/composer and passes verified video bytes directly',async()=>{
 const calls=[],{host,files}=adapter(async data=>{
  assert.equal(data.pageType,'photo_publish');
  // Payload parity with G only; this cannot assert the native editor's display order.
  assert.deepEqual(Object.keys(data.mediaInfo),['live_photo_resources','image_resources']);
  calls.push(JSON.parse(JSON.stringify(data)));
 });
 const video={type:'video/mp4',value:'video'};
 const source=await host.filmifyVideoSource(video);
 assert.equal(source.kind,'native-file');assert.equal(source.url,'native-file:1');
 await host.filmifyShareLiveGroup(['still'],'cover',video,{content:'recipe',tags:'Filmify,胶片感'});
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].mediaInfo.image_resources,[{url:'native-file:2'}]);
 assert.deepEqual(calls[0].mediaInfo.live_photo_resources,[{url:'data:image/png;base64,cover',video_url:'data:video/mp4;base64,video'}]);
 assert.equal(files.length,2,'Only the verification video and still should be written');
 assert.equal(calls[0].content,'recipe');assert.equal(calls[0].tags,'Filmify,胶片感');source.release();
});
test('one live photo uses the photo composer rather than the slides resource-count path',async()=>{
 const calls=[],{host}=adapter(async data=>calls.push(JSON.parse(JSON.stringify(data))));
 await host.filmifyShareLive('cover','video');
 assert.equal(calls.length,1);assert.equal(calls[0].pageType,'photo_publish');
 assert.deepEqual(Object.keys(calls[0].mediaInfo),['live_photo_resources']);
 assert.equal(calls[0].mediaInfo.live_photo_resources.length,1);
});
test('live native rejection is propagated without issuing a second static post',async()=>{
 let calls=0;const {host}=adapter(async()=>{calls++;throw new Error('native failed');});
 await assert.rejects(host.filmifyShareLiveGroup(['still'],'cover','video'),/native failed/);
 assert.equal(calls,1);
});
test('file-write rejection or empty handle aborts before any native post',async()=>{
 for(const writeTempFile of [async()=>{throw new Error('disk full');},async()=>({})]){
  let calls=0;const {host}=adapter(async()=>calls++,{writeTempFile});
  await assert.rejects(host.filmifyShareLiveGroup(['still'],'cover','video'),/disk full|临时素材/);
  await assert.rejects(host.filmifyVideoSource({type:'video/mp4'}),/disk full|临时素材/);
  assert.equal(calls,0);
 }
});
test('native media source requires documented writeTempFile; never silently falls back to blob',async()=>{
 const {host}=adapter(async()=>{},{writeTempFile:undefined});
 await assert.rejects(host.filmifyVideoSource({type:'video/mp4'}),/临时素材文件/);
});
test('image saving passes a native handle and never treats MP4 as an image',async()=>{
 const saved=[],{host,files}=adapter(async()=>{},{saveImageToPhotosAlbum:async o=>saved.push(o)});
 await host.filmifySavePhoto({type:'image/jpeg',value:'cover'});
 assert.equal(saved[0].filePath,'native-file:1');
 await assert.rejects(host.filmifySavePhoto({type:'video/mp4',value:'movie'}),/不能保存视频或实况/);
 assert.equal(saved.length,1);assert.equal(files.length,1);
});
test('browser media source releases its object URL',async()=>{
 let releases=0;const context={window:{},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:url=>{assert.equal(url,'blob:test');releases++;}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('minitool/host.js','utf8'),context);
 const source=await context.window.filmifyVideoSource({});assert.equal(source.kind,'blob');assert.equal(source.url,'blob:test');source.release();assert.equal(releases,1);
});
test('leaving during a native file write prevents later writes and postNote for both share groups',async()=>{
 for(const mixed of [false,true]){
  let active=true,release,started,posts=0,writes=0;
  const pending=new Promise(resolve=>started=resolve);
  const {host}=adapter(async()=>posts++,{writeTempFile:()=>{writes++;started();return new Promise(resolve=>release=resolve);}});
  const guard=()=>{if(!active)throw new Error('cancelled');};
  const task=mixed?host.filmifyShareLiveGroup(['one','two'],'cover','video',null,guard):host.filmifySharePhotos(['one','two'],null,guard);
  await pending;active=false;release({filePath:'late-file'});
  await assert.rejects(task,/cancelled/);assert.equal(posts,0);assert.equal(writes,1);
 }
});
test('final handoff guard runs before the native composer opens',async()=>{
 for(const mixed of [false,true]){
  let posts=0,handoffs=0;
  const {host}=adapter(async()=>posts++);
  const guard=posting=>{if(posting){handoffs++;throw new Error('cancelled before handoff');}};
  await assert.rejects(mixed?host.filmifyShareLiveGroup(['one'],'cover','video',null,guard):host.filmifySharePhotos(['one'],null,guard),/cancelled before handoff/);
  assert.equal(posts,0);assert.equal(handoffs,1);
 }
});

test('clothesline geometry keeps full paper within page and both landscape jaws on the top edge',()=>{
 const context={window:{}};vm.createContext(context);vm.runInContext(fs.readFileSync('minitool/clothesline.js','utf8'),context);
 const D=context.window.FilmifyClothesline;
 for(const n of [1,2,4,9])for(let theme=0;theme<4;theme++)for(let seed=0;seed<20;seed++){
  const scene=D.scene(seed,n,'kodak_portra_endura');scene.theme=theme;
  assert.equal(JSON.stringify(D.scene(seed,n,'kodak_portra_endura')),JSON.stringify(D.scene(seed,n,'kodak_portra_endura')));
  assert(scene.angles.every(a=>a>=-2.5&&a<=2.5));
  for(let i=0;i<n;i++)for(const [w,h] of [[900,1200],[1200,900],[1000,1000],[200,2400],[2400,200]]){
   const L=D.geometry(w,h,i,scene),cos=Math.cos(L.angle),sin=Math.sin(L.angle);
   assert(Math.abs(L.iw/L.ih-w/h)<1e-10);
   for(const x of [-L.pw/2,L.pw/2])for(const y of [L.top,L.top+L.ph]){
    const px=450+x*cos-y*sin,py=L.cy+x*sin+y*cos;
    assert(px>70&&px<830&&py>140&&py<1100,'paper safe margin');
   }
   if(L.wide)for(const sign of [-1,1]){
    const x=L.cx+sign*L.span*cos,rope=D.ropeY(x,scene),paper=L.cy+sign*L.span*sin;
    assert(Math.abs(rope-paper)<.01,'two anchors follow chord');
   }
  }
 }
});

test('cancelled native save stops after the file write before calling the album',async()=>{
 let release,live=true,albums=0;
 const {host}=adapter(async()=>{}, {writeTempFile:()=>new Promise(r=>{release=r;}),saveImageToPhotosAlbum:async()=>albums++});
 const guard=()=>{if(!live){const e=Error('cancelled save');e.cancelled=true;throw e;}};
 const work=host.filmifySavePhoto({type:'image/jpeg',value:'still'},'print',guard);
 while(!release)await Promise.resolve();live=false;release({filePath:'old.jpg'});
 await assert.rejects(work,/cancelled save/);assert.equal(albums,0);
});
