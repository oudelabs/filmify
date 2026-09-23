// 单图单效果「实况分享组」端到端验证:驱动打包后的真实页面(dist/xhs-tool),
// 模拟宿主 postNote，检查对比图和效果图作为默认静态分享内容。
// 换原片×成片对比图)+ 1 组 4s 负片显影渐变实况。
// 多图混合组包含拼图实况、底片拼图及逐张结果，按照片数限制分享件数。
// (N=9 无对比图),此处 4 张验证混合组 = 10 静态图 + 1 拼图实况。
// 素材落盘 validation/live-share-fixture/。
const path=require('node:path'),http=require('node:http'),fs=require('node:fs');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'validation','live-share-fixture');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.json':'application/json'};
function serve(){
 return new Promise(resolve=>{
  const server=http.createServer((req,res)=>{
   const url=decodeURIComponent(req.url.split('?')[0]);
   let f;
   if(url==='/')f=path.join(ROOT,'dist','xhs-tool','index.html');
   else if(url.endsWith('/'))f=path.join(ROOT,url,'index.html');
   else{
    f=path.join(ROOT,'dist','xhs-tool',url);/* 打包页相对引用(./app.js 等)优先取包内文件 */
    if(!fs.existsSync(f))f=path.join(ROOT,url);/* 仓级资源回退(如 /minitool/*) */
   }
   if(!f.startsWith(ROOT)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);res.end();return;}
   res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});
   fs.createReadStream(f).pipe(res);
  });
  server.listen(8932,'127.0.0.1',()=>resolve(server));
 });
}
async function injectPhotos(page,n){
 await page.evaluate(async n=>{
  const dt=new DataTransfer();
  for(let i=0;i<n;i++){
   const c=document.createElement('canvas');c.width=900;c.height=1200;
   const x=c.getContext('2d');
   const hues=[[200,60],[30,70],[140,50],[340,55]];
   const h=hues[i%hues.length];
   const g=x.createLinearGradient(0,0,900,1200);
   g.addColorStop(0,'hsl('+h[0]+','+h[1]+'%,72%)');g.addColorStop(1,'hsl('+((h[0]+40)%360)+','+h[1]+'%,38%)');
   x.fillStyle=g;x.fillRect(0,0,900,1200);
   x.fillStyle='rgba(255,255,255,.35)';x.beginPath();x.arc(240+((i*97)%420),300+((i*61)%300),130,0,7);x.fill();
   x.fillStyle='rgba(0,0,0,.25)';x.fillRect(0,980,900,220);
   x.fillStyle='#fff';x.font='700 90px sans-serif';x.fillText('#'+(i+1),60,1120);
   const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));
   dt.items.add(new File([blob],'photo'+i+'.jpg',{type:'image/jpeg'}));
  }
  const input=document.getElementById('fileInput');
  input.files=dt.files;
  input.dispatchEvent(new Event('change'));
 },n);
}
function saveDataURI(uri,file){
 const m=/^data:([^;,]+)[^,]*;base64,(.*)$/.exec(uri);
 if(!m)throw new Error('bad data uri for '+file);
 fs.writeFileSync(file,Buffer.from(m[2],'base64'));
 return m[1];
}
(async()=>{
 fs.mkdirSync(OUT,{recursive:true});
 const server=await serve();
 const {chromium}=require('playwright');
 const browser=await require('./launch-browser.cjs').launchBrowser();
 try{
  const page=await browser.newPage({viewport:{width:430,height:932}});
  const failures=[];
  page.on('pageerror',e=>{failures.push('pageerror: '+e.message);console.log('PAGEERROR:',e.message);});
  page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE:',m.text().slice(0,300));});
  await page.addInitScript(()=>{
   window.__posts=[];
   window.xhs={miniTool:{
    postNote:function(options){window.__posts.push(options);return Promise.resolve({errMsg:'postNote:ok MOCK'});},
    writeTempFile:function(){return Promise.resolve({filePath:'/tmp/mock-file'});},
    saveImageToPhotosAlbum:function(){return Promise.resolve({errMsg:'ok'});}
   }};
  });
  await page.goto('http://127.0.0.1:8932/dist/xhs-tool/',{waitUntil:'load'});
  await page.waitForSelector('.main-flow');

  // ---- 单图单效果:分享 = 对比图(原片×成片) + 效果图 + 4s 负片显影实况 ----
  await injectPhotos(page,1);
  await page.waitForSelector('.photoarea img',{timeout:15000});
  await page.click('[data-action="process"]');
  await page.waitForSelector('.result-flow',{timeout:280000});
  await page.waitForTimeout(500);
  await page.click('[data-action="share"]');
  await page.waitForFunction(()=>window.__posts.length>=1,null,{timeout:60000});
  const post=await page.evaluate(()=>window.__posts[0]);
  const mi=post.mediaInfo;
  if(post.pageType!=='photo_publish')throw new Error('pageType 错误: '+post.pageType);
  if(!mi.image_resources||mi.image_resources.length!==2)throw new Error('静态图应为 2 张,实际 '+(mi.image_resources||[]).length);
  if(!mi.live_photo_resources||mi.live_photo_resources.length!==1)throw new Error('实况应为 1 组,实际 '+(mi.live_photo_resources||[]).length);
  saveDataURI(mi.image_resources[0].url,path.join(OUT,'post-1-compare.jpg'));
  saveDataURI(mi.image_resources[1].url,path.join(OUT,'post-2-effect.jpg'));
  saveDataURI(mi.live_photo_resources[0].url,path.join(OUT,'live-cover.jpg'));
  const videoMime=saveDataURI(mi.live_photo_resources[0].video_url,path.join(OUT,'live-video.mp4'));
  if(!/^video\/mp4/.test(videoMime))throw new Error('实况视频不是 mp4: '+videoMime);
  const mp4=fs.readFileSync(path.join(OUT,'live-video.mp4'));
  if(mp4.slice(4,8).toString()!=='ftyp')throw new Error('MP4 缺少 ftyp 头');
  console.log('单图实况分享组 PASS: 2 静态图 + 1 实况, MP4',mp4.length,'bytes');
  await page.screenshot({path:path.join(OUT,'shot-result-shared.png')});

  // 验证多图拼图实况混合组。
  // 4 张 = 底片拼静+效果拼静+逐对 8(对比+效果)=10 静态图 + 1 组拼图显影实况
  await page.click('.againlink');
  await page.waitForSelector('.main-flow');
  await injectPhotos(page,4);
  await page.waitForSelector('.photoarea img',{timeout:15000});
  await page.waitForTimeout(1000);
  await page.click('[data-action="process"]');
  let reached=false;
  for(let i=0;i<56&&!reached;i++){
   await page.waitForTimeout(5000);
   const st=await page.evaluate(()=>({
    result:!!document.querySelector('.result-flow'),
    proc:!!document.querySelector('.proc-flow'),
    main:!!document.querySelector('.main-flow'),
    sheet:document.querySelector('.sheet')?document.querySelector('.sheet').textContent.slice(0,150):null,
    toast:document.getElementById('toast')?document.getElementById('toast').textContent:null
   }));
   if(i%4===0||st.result||st.sheet)console.log('multi',(i+1)*5+'s',JSON.stringify(st));
   if(st.result)reached=true;
   if(st.sheet)throw new Error('多图冲印出错: '+st.sheet);
  }
  if(!reached)throw new Error('多图冲印 280s 未到成片页');
  await page.waitForTimeout(500);
  await page.click('[data-action="share"]');
  await page.waitForFunction(()=>window.__posts.length>=2,null,{timeout:60000});
  const post2=await page.evaluate(()=>window.__posts[1]);
  const mi2=post2.mediaInfo;
  if(!mi2.image_resources||mi2.image_resources.length!==10)throw new Error('多图分享应为 10 张静态图,实际 '+(mi2.image_resources||[]).length);
  if(!mi2.live_photo_resources||mi2.live_photo_resources.length!==1)throw new Error('多图分享应含 1 组拼图实况');
  saveDataURI(mi2.image_resources[0].url,path.join(OUT,'post-multi-1-neg-collage.jpg'));
  saveDataURI(mi2.image_resources[1].url,path.join(OUT,'post-multi-2-eff-collage.jpg'));
  saveDataURI(mi2.live_photo_resources[0].url,path.join(OUT,'multi-live-cover.jpg'));
  const mvMime=saveDataURI(mi2.live_photo_resources[0].video_url,path.join(OUT,'multi-live-video.mp4'));
  if(!/^video\/mp4/.test(mvMime))throw new Error('拼图实况视频不是 mp4: '+mvMime);
  const mp42=fs.readFileSync(path.join(OUT,'multi-live-video.mp4'));
  if(mp42.slice(4,8).toString()!=='ftyp')throw new Error('拼图实况 MP4 缺少 ftyp 头');
  console.log('多图实况混合分享组 PASS: 10 静态图 + 1 拼图实况, MP4',mp42.length,'bytes');

  if(failures.length)throw new Error('页面报错: '+failures.join(' | '));
  console.log('LIVE SHARE E2E PASS');
 }finally{
  await browser.close();server.close();
 }
})().catch(e=>{console.error('FAIL:',e.message||e);process.exit(1);});
process.on('unhandledRejection',e=>console.error('UNHANDLED:',e));
