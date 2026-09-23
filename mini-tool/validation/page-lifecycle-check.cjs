// 页面生命周期定向回归(2026-09-21 review 第 9 点修复):
// 冲印中触发 pagehide(卸载/bfcache 冻结)后,任务取消 + 引擎释放;
// pageshow 恢复时复位回主页(照片/配方保留),不卡死在冲印页。
// 另验证恢复后仍能正常重新冲印。
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
(async()=>{
 const server=await serve(8925);
 const {chromium}=require('playwright');
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 let failed=0;
 const check=(label,ok,detail)=>{console.log((ok?'PASS':'FAIL')+' '+label+(detail?' — '+detail:''));if(!ok)failed++;};
 try{
  const page=await browser.newPage({viewport:{width:430,height:932}});
  page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  await page.goto('http://127.0.0.1:8925/dist/xhs-tool/',{waitUntil:'load'});
  await page.waitForSelector('.main-flow');

  // 注入一张照片并开始冲印
  await page.evaluate(()=>{
   (async()=>{
    const c=document.createElement('canvas');c.width=1200;c.height=800;
    const x=c.getContext('2d');
    const g=x.createLinearGradient(0,0,1200,800);
    g.addColorStop(0,'hsl(210,60%,70%)');g.addColorStop(1,'hsl(20,65%,40%)');
    x.fillStyle=g;x.fillRect(0,0,1200,800);
    const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));
    const dt=new DataTransfer();
    dt.items.add(new File([blob],'life.jpg',{type:'image/jpeg'}));
    const input=document.getElementById('fileInput');
    input.files=dt.files;
    input.dispatchEvent(new Event('change'));
   })().catch(()=>{});
  });
  await page.waitForFunction(()=>typeof photos!=='undefined'&&Object.keys(photos).length===1,null,{timeout:20000});
  await page.click('[data-action="process"]');
  await page.waitForSelector('.proc-flow',{timeout:20000});

  // 冲印中触发 pagehide → 任务取消 + 引擎释放
  const released=await page.evaluate(()=>{
   let released=false;
   const orig=FilmifyEngine.release;
   FilmifyEngine.release=function(){released=true;orig.call(this);};
   window.dispatchEvent(new PageTransitionEvent('pagehide'));
   return released;
  });
  check('pagehide 触发引擎 release',released===true);

  // bfcache 恢复:复位回主页,不卡死
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow')));
  await page.waitForSelector('.main-flow',{timeout:10000});
  const st=await page.evaluate(()=>({page:state.page,busy:busy,ioBusy:ioBusy,photos:Object.keys(photos).length}));
  check('pageshow 复位回主页',st.page==='main'&&!st.busy&&!st.ioBusy,JSON.stringify(st));
  check('照片保留可再次冲印',st.photos===1);

  // 恢复后重新冲印应正常到成片页
  await page.click('[data-action="process"]');
  await page.waitForSelector('.result-flow',{timeout:280000});
  const out=await page.evaluate(()=>Object.keys(outputs).length);
  check('恢复后重新冲印正常',out===1,'outputs='+out);
 }finally{
  await browser.close();server.close();
 }
 if(failed){console.error('PAGE LIFECYCLE CHECK FAIL');process.exit(1);}
 console.log('PAGE LIFECYCLE CHECK PASS');
})().catch(e=>{console.error('FAIL:',e.message||e);process.exit(1);});
