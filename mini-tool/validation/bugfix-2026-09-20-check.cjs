// 2026-09-20 审查修复回归:B2 配方始终单选(多选已取消)、分享组构成(原图不逐对重复)。
// 2026-09-21 成片页收敛回归:单图成片页 = 动图/效果图两页(动图居首,无原图页,无合集卡);
// 动图为负片→成片渐变显影(弃划像),负片与主页选图预览同源。
// 驱动打包后的真实页面(dist 经根 index.html),截图到 /tmp/bf-*.png
const path=require('node:path'),http=require('node:http'),fs=require('node:fs');
const ROOT=path.resolve(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.json':'application/json'};
function serve(port){
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
  server.listen(port,'127.0.0.1',()=>resolve(server));
 });
}
async function injectPhotos(page,n){
 await page.evaluate(async n=>{
  const dt=new DataTransfer();
  for(let i=0;i<n;i++){
   const c=document.createElement('canvas');c.width=900;c.height=1200;
   const x=c.getContext('2d');
   const g=x.createLinearGradient(0,0,900,1200);
   g.addColorStop(0,'hsl(200,60%,72%)');g.addColorStop(1,'hsl(240,60%,38%)');
   x.fillStyle=g;x.fillRect(0,0,900,1200);
   x.fillStyle='#fff';x.font='700 90px sans-serif';x.fillText('#'+(i+1),60,1120);
   const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));
   dt.items.add(new File([blob],'photo'+i+'.jpg',{type:'image/jpeg'}));
  }
  const input=document.getElementById('fileInput');
  input.files=dt.files;
  input.dispatchEvent(new Event('change'));
 },n);
}
let failures=0;
function check(name,ok,detail){
 console.log((ok?'PASS':'FAIL')+' '+name+(detail?' — '+detail:''));
 if(!ok)failures++;
}
/* 分段运行支持(本机自动化单次调用时限用,缺省全跑、行为不变):
   BF_SECTIONS=result,share 只跑指定段。段名:result/b2/share/oom/save/reselect/cached */
const ONLY=(process.env.BF_SECTIONS||'').split(',').filter(Boolean);
function sec(name){return !ONLY.length||ONLY.indexOf(name)>=0;}
async function swipeLeft(page){
 await page.evaluate(()=>{
  const sw=document.getElementById('swiper');const r=sw.getBoundingClientRect();
  const y=r.top+r.height/2;
  const base={bubbles:true,cancelable:true,pointerId:1,isPrimary:true};
  sw.dispatchEvent(new PointerEvent('pointerdown',Object.assign({clientX:r.right-30,clientY:y,button:0},base)));
  sw.dispatchEvent(new PointerEvent('pointermove',Object.assign({clientX:r.left+30,clientY:y},base)));
  sw.dispatchEvent(new PointerEvent('pointerup',Object.assign({clientX:r.left+30,clientY:y},base)));
 });
}
(async()=>{
 const server=await serve(8919);
 const {chromium}=require('playwright');
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 const pageerrors=[];
 try{
  /* 检查单图成片页的对比图、效果图与显影动画。 */
  if(sec('result')){
  const page=await browser.newPage({viewport:{width:430,height:932}});
  page.on('pageerror',e=>pageerrors.push(e.message));
  await page.goto('http://127.0.0.1:8919/dist/xhs-tool/',{waitUntil:'load'});
  await page.waitForSelector('.main-flow');
  await injectPhotos(page,1);
  await page.waitForSelector('.photoarea img',{timeout:15000});
  await page.click('[data-action="process"]');
  await page.waitForSelector('.result-flow',{timeout:280000});
  await page.waitForTimeout(500);
  const slides=await page.locator('#track .slide').count();
  check('成片页单图 3 页(对比图/效果图/动图)',slides===3,'实际 '+slides+' 页');
  check('成片页无配方合集卡',(await page.locator('.csm-tile').count())===0&&(await page.locator('.coll-card').count())===0);
  /* 从 slideMeta 读取页序。 */
  const cap0=await page.evaluate(()=>slideMeta[0]||'');
  /* 默认页序为对比图、效果图、显影动画。 */
  check('首屏为对比图',cap0.indexOf('对比图')>=0,cap0);
  /* 对比图按需合成:等图片实际载入再往后走(空 img 未占位属预期中间态) */
  await page.waitForFunction(()=>{const imgs=document.querySelectorAll('#track .slide img');return imgs.length&&Array.prototype.every.call(imgs,i=>i.complete&&i.naturalWidth>0);},null,{timeout:60000});
  await swipeLeft(page);await page.waitForTimeout(500);
  const cap1=await page.evaluate(()=>slideMeta[1]||'');
  check('第二页为效果图',cap1.indexOf('·')>=0&&cap1.indexOf('实况')<0,cap1);
  await swipeLeft(page);await page.waitForTimeout(500);
  const cap2=await page.evaluate(()=>slideMeta[2]||'');
  /* 第三页包含显影动画画布。 */
  const liveLast=await page.evaluate(()=>{
   const ss=document.querySelectorAll('#track .slide');const s=ss[ss.length-1];
   return !!(s&&s.querySelector('canvas.live-wipe'));});
  check('第三页为实况动图',liveLast,cap2);
  /* 画布随时间变化的断言必须在动图页(当前页)上做:滑走后预览循环暂停,画面静止属预期 */
  await page.waitForFunction(()=>!!document.querySelector('#track canvas.live-wipe'),null,{timeout:30000});
  await page.waitForTimeout(400);/* 预览循环 resume 后再采样 */
  const live=await page.evaluate(async()=>{
   const c=document.querySelector('#track canvas.live-wipe');
   if(!c)return {ok:false,why:'no canvas'};
   const a=c.toDataURL();
   await new Promise(r=>setTimeout(r,1200));
   return {ok:a!==c.toDataURL(),w:c.width,h:c.height};
  });
  check('动图画布随时间变化',live.ok,JSON.stringify(live));
  check('动图页无角标残留(角标已随文案统一移除)',(await page.locator('#track .live-badge').count())===0);
  check('页下文案行已撤除(2026-09-22 下午拍板)',(await page.locator('#sum').count())===0&&(await page.locator('.cap-live').count())===0);
  check('成片页流程无未捕获异常',pageerrors.length===0,pageerrors.join(';'));
  await page.screenshot({path:'/tmp/bf-result-live.png'});
  await page.close();
  }

  /* 配方始终单选，连续点击多款后仅最新一款选中。 */
  if(sec('b2')){
  const page2=await browser.newPage({viewport:{width:430,height:932}});
  page2.on('pageerror',e=>pageerrors.push(e.message));
  await page2.goto('http://127.0.0.1:8919/dist/xhs-tool/',{waitUntil:'load'});
  await page2.waitForSelector('.main-flow');
  await injectPhotos(page2,1);
  await page2.waitForSelector('.photoarea img',{timeout:15000});
  for(const k of [5,6,7]){await page2.click('[data-film="'+k+'"]');await page2.waitForTimeout(300);}
  const onCount=await page2.evaluate(()=>document.querySelectorAll('.rcard.on').length);
  const onIdx=await page2.evaluate(()=>{const el=document.querySelector('.rcard.on');return el?el.dataset.film:'none';});
  check('B2 配方单选:只有一款选中',onCount===1,'实际选中 '+onCount+' 款');
  check('B2 配方单选:选中最新点击的一款',onIdx==='7','实际 data-film='+onIdx);
  const summary2=await page2.textContent('.main-flow .summary');
  check('B2 配方单选:摘要为单款配方',summary2.indexOf('款配方 · 一次出')<0,summary2.trim());
  await page2.screenshot({path:'/tmp/bf-b2-single-pick.png'});
  await page2.close();
  }

  /* 默认静态分享包含对比图和效果图。 */
  if(sec('share')){
  const page2b=await browser.newPage({viewport:{width:430,height:932}});
  page2b.on('pageerror',e=>pageerrors.push(e.message));
  await page2b.goto('http://127.0.0.1:8919/dist/xhs-tool/',{waitUntil:'load'});
  await page2b.waitForSelector('.main-flow');
  await injectPhotos(page2b,1);
  await page2b.waitForSelector('.photoarea img',{timeout:15000});
  /* 本段测纯图片默认组:强制实况不可用(实况混合组由 verify-live-share.cjs 专项覆盖)。
     2026-09-21 起实况「生成」失败才回退图片组,postNote 失败不再吞错误回退,
     因此不能再依赖旧行为兜底到 filmifySharePhotos。 */
  await page2b.evaluate(()=>{window.FilmifyLiveWipe.supported=()=>'';});
  await page2b.click('[data-action="process"]');
  await page2b.waitForSelector('.result-flow',{timeout:280000});
  const slides2b=await page2b.evaluate(()=>document.querySelectorAll('#track .slide').length);
  check('成片页单图 3 页(动图/对比图/效果图)',slides2b===3,'实际 '+slides2b+' 页');
  await page2b.evaluate(()=>{window.__shareCalls=[];window.filmifySharePhotos=async blobs=>{window.__shareCalls.push(blobs.length);};});
  await page2b.click('[data-action="share"]');
  await page2b.waitForFunction(()=>window.__shareCalls.length>0,{timeout:120000});
  const directN=await page2b.evaluate(()=>window.__shareCalls[0]);
  check('分享直达:单图默认分享组 2 张(对比图+效果图)',directN===2,'实际 '+directN+' 张');
  check('分享直达:无弹层',await page2b.locator('.sheet-backdrop').count()===0);
  await page2b.screenshot({path:'/tmp/bf-share-direct.png'});
  await page2b.close();
  }

  /* ---------- OOM:8 张拼图逐格解码合成,流程与内容正确 ---------- */
  if(sec('oom')){
  const page3=await browser.newPage({viewport:{width:430,height:932}});
  page3.on('pageerror',e=>pageerrors.push(e.message));
  await page3.goto('http://127.0.0.1:8919/dist/xhs-tool/',{waitUntil:'load'});
  await page3.waitForSelector('.main-flow');
  await injectPhotos(page3,8);
  await page3.waitForSelector('.photoarea img',{timeout:15000});
  await page3.click('[data-action="process"]');
  await page3.waitForSelector('.result-flow',{timeout:280000});
  await page3.waitForTimeout(700);
  const collageCap=await page3.evaluate(()=>slideMeta[0]||'');
  check('OOM 首屏为整组拼图',collageCap.indexOf('拼图')>=0,collageCap);
  check('OOM 8 张流程无未捕获异常',pageerrors.length===0,pageerrors.join(';'));
  await page3.screenshot({path:'/tmp/bf-oom-collage.png'});
  await page3.close();
  }

  /* ---------- 保存:部分失败弹层提示,「重试」只补失败张 ---------- */
  if(sec('save')){
  const page4=await browser.newPage({viewport:{width:430,height:932}});
  page4.on('pageerror',e=>pageerrors.push(e.message));
  await page4.goto('http://127.0.0.1:8919/dist/xhs-tool/',{waitUntil:'load'});
  await page4.waitForSelector('.main-flow');
  await injectPhotos(page4,2);
  await page4.waitForSelector('.photoarea img',{timeout:15000});
  await page4.click('[data-action="process"]');
  await page4.waitForSelector('.result-flow',{timeout:280000});
  // 保存探针:第一次调用模拟失败,其余成功
  await page4.evaluate(()=>{window.__saves=[];window.__failNext=true;window.filmifySavePhoto=async(blob,name)=>{window.__saves.push(name);if(window.__failNext){window.__failNext=false;throw new Error('模拟保存失败');}};});
  await page4.click('[data-action="save"]');
  await page4.waitForSelector('.sheet-backdrop',{timeout:30000});
  const saveSheetText=await page4.textContent('.sheet');
  /* 两张照片对应六个保存件；首件失败后重试只补该项。 */
  check('保存 部分失败弹层计数正确',saveSheetText.indexOf('5 张已发起下载，1 张未完成')>=0,saveSheetText.replace(/\s+/g,' ').trim());
  check('保存 首轮调用 6 张',(await page4.evaluate(()=>window.__saves.length))===6);
  await page4.screenshot({path:'/tmp/bf-save-partial.png'});
  await page4.click('.sheet [data-action="save"]');
  await page4.waitForFunction(()=>window.__saves.length===7,{timeout:30000});
  const saves=await page4.evaluate(()=>window.__saves);
  check('保存 重试只补失败张',saves[6]===saves[0],saves.join(','));
  await page4.waitForSelector('#toast.visible',{timeout:15000});
  const saveToast=await page4.textContent('#toast');
  check('保存 重试成功 toast',saveToast.indexOf('已发起 1 张下载')>=0,saveToast.trim());
  await page4.screenshot({path:'/tmp/bf-save-retried.png'});
  await page4.close();
  }

  /* 已选照片的大图仅作预览，点击不会打开重选确认层。 */
  if(sec('reselect')){
  const page5=await browser.newPage({viewport:{width:430,height:932}});
  page5.on('pageerror',e=>pageerrors.push(e.message));
  await page5.goto('http://127.0.0.1:8919/dist/xhs-tool/',{waitUntil:'load'});
  await page5.waitForSelector('.main-flow');
  await injectPhotos(page5,2);
  await page5.waitForSelector('.strip .cell',{timeout:15000});
  /* 大图区不再是按钮、无 data-action */
  check('已选图大图区非按钮',await page5.locator('button.photoarea').count()===0);
  await page5.click('.photoarea');
  await page5.waitForTimeout(600);
  check('点大图不弹任何弹层',await page5.locator('.sheet-backdrop').count()===0);
  check('点大图后照片仍在',await page5.locator('.strip .cell').count()===2);
  /* 空态占位区仍是选图入口(事件委托在 #screen,重渲染后旧按钮已脱离 DOM,须逐次点击) */
  while(await page5.locator('.thumb-x').count()){
   await page5.locator('.thumb-x').first().click();
   await page5.waitForTimeout(200);
  }
  await page5.waitForSelector('.photoarea.empty',{timeout:5000});
  check('清空后占位区恢复可选图',await page5.locator('button.photoarea.empty[data-action="select-photos"]').count()===1);
  await page5.close();
  }

  /* ---------- 全缓存再冲印直达成片页(2026-09-21 review):不再空播四段动画 ---------- */
  if(sec('cached')){
  const page6=await browser.newPage({viewport:{width:430,height:932}});
  page6.on('pageerror',e=>pageerrors.push(e.message));
  await page6.goto('http://127.0.0.1:8919/dist/xhs-tool/',{waitUntil:'load'});
  await page6.waitForSelector('.main-flow');
  await injectPhotos(page6,1);
  await page6.waitForSelector('.photoarea img',{timeout:15000});
  await page6.click('[data-action="process"]');
  await page6.waitForSelector('.result-flow',{timeout:280000});
  /* 模拟离开再回(pagehide→pageshow):复位回主页,outputs/smalls 全部保留 */
  await page6.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));});
  await page6.waitForSelector('.main-flow',{timeout:10000});
  const t0=Date.now();
  await page6.click('[data-action="process"]');
  await page6.waitForSelector('.result-flow',{timeout:10000});
  const quickMs=Date.now()-t0;
  check('全缓存再冲印 2s 内直达成片(不空播动画)',quickMs<2000,'实际 '+quickMs+'ms');
  const sawProc=await page6.evaluate(()=>!!document.querySelector('.proc-flow'));
  check('全缓存再冲印不经冲印页',!sawProc);
  await page6.close();
  }
 }finally{
  await browser.close();server.close();
 }
 console.log(failures?('BUGFIX CHECK FAIL ('+failures+')'):'BUGFIX CHECK PASS');
 process.exit(failures?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
