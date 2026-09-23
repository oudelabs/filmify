// v4 流程 UI 验证:驱动打包后的真实页面,截图各状态到 /tmp/v4-*.png
const path=require('node:path'),http=require('node:http'),fs=require('node:fs');
const ROOT=path.resolve(__dirname,'..');
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
  server.listen(8915,'127.0.0.1',()=>resolve(server));
 });
}
// 在页面内合成 n 张 900x1200 测试照片并通过 fileInput 注入
async function injectPhotos(page,n){
 await page.evaluate(async n=>{
  const dt=new DataTransfer();
  for(let i=0;i<n;i++){
   const c=document.createElement('canvas');c.width=900;c.height=1200;
   const x=c.getContext('2d');
   const hues=[[200,60],[30,70],[140,50],[340,55],[60,65],[260,60],[10,60],[180,55]];
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
 const server=await serve();
 const {chromium}=require('playwright');
 const browser=await require('./launch-browser.cjs').launchBrowser();
 const shot=async(page,name)=>{await page.screenshot({path:'/tmp/v4-'+name+'.png'});console.log('shot',name);};
 try{
  const page=await browser.newPage({viewport:{width:430,height:932}});
  page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  await page.goto('http://127.0.0.1:8915/dist/xhs-tool/',{waitUntil:'load'});
  await page.waitForSelector('.main-flow');
  await page.waitForTimeout(400);
  await shot(page,'1-main-empty');

  // 组图:4 张
  await injectPhotos(page,4);
  await page.waitForSelector('.photoarea img',{timeout:15000});
  await page.waitForTimeout(500);
  await shot(page,'2-main-photos');

  await page.click('[data-action="process"]');
  await page.waitForSelector('.proc-flow');
  await page.waitForTimeout(2600);
  await shot(page,'3-processing');

  await page.waitForSelector('.result-flow',{timeout:280000});
  await page.waitForTimeout(700);
  await shot(page,'4-result-collage');

  await swipeLeft(page);
  await page.waitForTimeout(500);
  await shot(page,'5-result-pair');

  // 分享直达:无弹层,直接以默认分享组调起发布;此处桩掉拼图动图录制走纯图片组
  // (实况混合组由 verify-live-share.cjs 专项覆盖):4 张静态组=效果拼静+底片拼静+逐对 8=10 张
  await page.evaluate(()=>{window.__shared=null;window.filmifySharePhotos=async blobs=>{window.__shared=blobs.length;};
   window.FilmifyCollageGrid.record=()=>Promise.reject(new Error('stub:静态组验证'));});
  await page.click('[data-action="share"]');
  await page.waitForFunction(()=>window.__shared!==null,{timeout:60000});
  const sharedN=await page.evaluate(()=>window.__shared);
  if(sharedN!==10)throw new Error('分享张数应为 10,实际 '+sharedN);
  console.log('share direct PASS:',sharedN,'张');
  await page.waitForTimeout(400);
  await shot(page,'6-share-direct');

  // 再冲一次 → 回主页,换单图流程
  await page.click('.againlink');
  await page.waitForSelector('.main-flow');
  await injectPhotos(page,1);
  await page.waitForTimeout(600);
  await shot(page,'7-main-single');
  await page.click('[data-action="process"]');
  await page.waitForSelector('.result-flow',{timeout:280000});
  await page.waitForTimeout(700);
  /* 单图页序：对比图、效果图、显影动画。 */
  const slideN=await page.evaluate(()=>document.querySelectorAll('#track .slide').length);
  if(slideN!==3)throw new Error('单图成片页应为 3 页,实际 '+slideN);
  if(await page.locator('.csm-tile').count())throw new Error('成片页不应再有合集卡');
  if(await page.locator('#track .slide').first().locator('canvas.live-wipe').count())throw new Error('首屏应为对比图,不是动图画布');
  /* 对比图按需合成:等图片实际载入再截图 */
  await page.waitForFunction(()=>{const imgs=document.querySelectorAll('#track .slide img');return imgs.length&&Array.prototype.every.call(imgs,i=>i.complete&&i.naturalWidth>0);},null,{timeout:60000});
  await shot(page,'8-result-compare');

  await swipeLeft(page);
  await page.waitForTimeout(500);
  await shot(page,'9-result-effect');

  await swipeLeft(page);
  await page.waitForTimeout(1200);/* 等负片渲染+动图页循环开播再截图 */
  if(!(await page.locator('#track canvas.live-wipe').count()))throw new Error('末页应为实况动图画布');
  await shot(page,'10-result-live');

  console.log('UI FLOW PASS');
 }finally{
  await browser.close();server.close();
 }
})().catch(e=>{console.error('FAIL:',e.message||e);process.exit(1);});
