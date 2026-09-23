// 冲印工序文案与波浪动画专项验证。
// 进度语义 = 所选路线的真实工序名(默认 Portra 走 C-41→RA-4 路线,5 道工序)逐段推进,
// 视觉为单橙波浪横向游动。
// 断言:波浪单 path 动画在跑、「正在xx」恒为当前路线合法工序且推进单调、首快照=第一道工序、
// 工序列表(.proc-list,2026-09-21 撤除)与工序插画(同日撤除)不存在。
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
  server.listen(8917,'127.0.0.1',()=>resolve(server));
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
   const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));
   dt.items.add(new File([blob],'photo'+i+'.jpg',{type:'image/jpeg'}));
  }
  const input=document.getElementById('fileInput');
  input.files=dt.files;
  input.dispatchEvent(new Event('change'));
 },n);
}
function snap(page){
 return page.evaluate(()=>{
  const out={};
  const waves=document.querySelector('.proc-waves');
  out.waves=!!waves;
  if(waves){
   out.paths=waves.querySelectorAll('path').length;
   const w1=waves.querySelector('.w1'),w2=waves.querySelector('.w2');
   out.w1=w1?getComputedStyle(w1).animationName:null;
   out.w2=w2?getComputedStyle(w2).animationName:null;
  }
  out.procName=(document.querySelector('#procName')||{}).textContent||'';
  /* 段条/工序列表/工序插画均已撤除,断言不存在 */
  out.pstepCount=document.querySelectorAll('.pstep').length;
  out.listCount=document.querySelectorAll('.proc-list,.proc-list li').length;
  out.art=!!document.querySelector('.stage-card,#stageArt,img.art');
  return out;
 });
}
(async()=>{
 const server=await serve();
 const {chromium}=require('playwright');
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 try{
  const page=await browser.newPage({viewport:{width:430,height:932}});
  page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  await page.goto('http://127.0.0.1:8917/dist/xhs-tool/',{waitUntil:'load'});
  await page.waitForSelector('.main-flow');
  await injectPhotos(page,4);
  await page.waitForSelector('.strip .cell',{timeout:15000});
  await page.click('[data-action="process"]');
  await page.waitForSelector('.proc-flow');

  const snaps=[];
  // 冲印全程每 700ms 采一次,直到进成片页
  for(let t=0;t<80;t++){
   const onProc=await page.$('.proc-flow');
   if(!onProc)break;
   snaps.push(await snap(page));
   if(snaps.length===3)await page.screenshot({path:path.join(ROOT,'validation','pstep-lines-mid.png')});
   await page.waitForTimeout(700);
  }
  await page.waitForSelector('.result-flow',{timeout:280000}).catch(()=>{});

  let fails=0;
  const fail=m=>{fails++;console.log('FAIL:',m);};
  /* 期望工序 = 默认配方(列表第 0 款 Portra 400)路线的 steps */
  const expected=await page.evaluate(()=>FilmifyMaterials.routes[FilmifyMaterials.films[0].route].steps);
  if(!snaps.length)fail('未采到冲印页快照');
  const stageSeq=[];
  snaps.forEach((s,idx)=>{
   // 1. 波浪在:v4 单条 path,w1 动画在跑(w2 已撤,断言不存在)
   if(!s.waves||s.paths!==1)fail('快照'+idx+' 波浪不存在或 path 数!=1: '+JSON.stringify(s));
   if(s.w1!=='proc-wave-a')fail('快照'+idx+' w1 动画不在跑: '+s.w1);
   if(s.w2)fail('快照'+idx+' w2 波浪应已撤除: '+s.w2);
   // 2. 「正在xx」恒为当前路线的合法工序名
   const k=expected.findIndex(n=>s.procName==='正在'+n);
   if(k<0)fail('快照'+idx+' 文案「'+s.procName+'」不在路线工序里');
   stageSeq.push(k);
   // 3. 退役元素不存在
   if(s.pstepCount!==0)fail('快照'+idx+' 仍存在段条(.pstep)');
   if(s.listCount!==0)fail('快照'+idx+' 仍存在工序列表(.proc-list)');
   if(s.art)fail('快照'+idx+' 仍存在工序插画(stage-card/stageArt/img.art)');
  });
  // 4. 首快照=第一道工序;推进单调不回退
  if(snaps.length&&stageSeq[0]!==0)fail('首快照不是第一道工序: '+snaps[0].procName);
  for(let i=1;i<stageSeq.length;i++)if(stageSeq[i]>=0&&stageSeq[i-1]>=0&&stageSeq[i]<stageSeq[i-1])fail('工序回退: '+stageSeq.join(','));
  // 5. 4 张冲印时长足够,应采到至少两道工序(推进真实发生)
  const seen=new Set(stageSeq.filter(k=>k>=0));
  if(seen.size<2)fail('全程只见 '+seen.size+' 道工序,推进未生效: '+stageSeq.join(','));
  console.log('工序推进序列:',stageSeq.join(' → '));
  if(!fails)console.log('PASS proc-waves: '+expected.length+' 道真实工序逐段推进 + 单波浪动画在跑 + 「正在xx」同步 + 无段条/工序列表/插画 ('+snaps.length+' 快照)');
  process.exitCode=fails?1:0;
 }finally{await browser.close();server.close();}
})();
