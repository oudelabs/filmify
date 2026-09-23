// 拼图/单图保存导出快速验证:桩掉引擎重计算,只走真实 composeCollage 合成与保存路径
// (合集卡保存项已于 2026-09-21 移除:单图保存 = 效果图一张)
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
  server.listen(8923,'127.0.0.1',()=>resolve(server));
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
   x.fillStyle='#fff';x.font='700 90px sans-serif';x.fillText('#'+(i+1),60,1120);
   const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));
   dt.items.add(new File([blob],'photo'+i+'.jpg',{type:'image/jpeg'}));
  }
  const input=document.getElementById('fileInput');
  input.files=dt.files;
  input.dispatchEvent(new Event('change'));
 },n);
}
async function stubEngine(page){
 await page.evaluate(()=>{
  let k=0;
  FilmifyEngine.setImage=function(){};
  FilmifyEngine.develop=async function(style,onProgress){
   if(onProgress)onProgress(100);
   const c=document.createElement('canvas');c.width=900;c.height=1200;
   const x=c.getContext('2d');
   const g=x.createLinearGradient(0,0,900,1200);
   const hue=(k++*37+style.length*53)%360;
   g.addColorStop(0,'hsl('+hue+',45%,68%)');g.addColorStop(1,'hsl('+((hue+50)%360)+',40%,36%)');
   x.fillStyle=g;x.fillRect(0,0,900,1200);
   const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));
   return {blob:blob,previewBlob:blob,width:900,height:1200};
  };
  /* 捕获合成产物 URL(跟踪 revoke 只留活的),用于直接查看导出图 */
  window.__caps=[];
  const origCreate=URL.createObjectURL.bind(URL),origRevoke=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=b=>{const u=origCreate(b);window.__caps.push({u:u,size:b.size||0});return u;};
  URL.revokeObjectURL=u=>{window.__caps=window.__caps.filter(e=>e.u!==u);origRevoke(u);};
 });
}
async function showLastCapture(page){
 await page.evaluate(()=>{
  /* 取仍存活的最大产物(保存版导出图) */
  const best=window.__caps.slice().sort((a,b)=>b.size-a.size)[0];
  if(!best)return;
  const im=document.createElement('img');
  im.style.cssText='position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#26262a;z-index:9999';
  im.src=best.u;document.body.appendChild(im);
  return new Promise(r=>{im.onload=r;});
 });
}
(async()=>{
 const server=await serve();
 const {chromium}=require('playwright');
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 try{
  const page=await browser.newPage({viewport:{width:430,height:932}});
  page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  await page.goto('http://127.0.0.1:8923/dist/xhs-tool/',{waitUntil:'load'});
  await page.waitForSelector('.main-flow');
  await stubEngine(page);
  // 组图 4 张 → 拼图
  await injectPhotos(page,4);
  await page.waitForSelector('.photoarea img',{timeout:15000});
  await page.click('[data-action="process"]');
  await page.waitForSelector('.result-flow',{timeout:60000});
  await page.waitForTimeout(600);
  await page.screenshot({path:'validation/footer-collage.png'});
  console.log('shot footer-collage');
  // 单图 → 成片页(原图/效果图/动图三页)
  await page.click('.againlink');
  await page.waitForSelector('.main-flow');
  await injectPhotos(page,1);
  await page.waitForTimeout(400);
  await page.click('[data-action="process"]');
  await page.waitForSelector('.result-flow',{timeout:60000});
  await page.waitForTimeout(600);
  await page.screenshot({path:'validation/footer-single.png'});
  console.log('shot footer-single');
  // 触发保存(单图 = 效果图一张),直接查看导出图
  await page.click('[data-action="save"]',{timeout:10000});
  console.log('save clicked');
  await page.waitForTimeout(4000);
  console.log('alive caps',await page.evaluate(()=>window.__caps.length));
  await showLastCapture(page);
  await page.waitForTimeout(300);
  await page.screenshot({path:'validation/footer-single-export.png'});
  console.log('shot footer-single-export');
  console.log('FOOTER CHECK PASS');
 }finally{
  await browser.close();server.close();
 }
})().catch(e=>{console.error('FAIL:',e.message||e);process.exit(1);});
