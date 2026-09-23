// Post-build smoke gate: load the PACKAGED tool (dist/xhs-tool) in a real
// browser, fail on any missing asset, then run
// scripts/dist-smoke-page.html which exercises a real mobile-core develop
// (dimensions conserved, real progress, mono neutrality, timing spot-check).
// Source-served tests cannot catch packaging path/layout bugs; this gate can.
// Exits 77 when Playwright is unavailable so the build can warn and continue.
const path=require('node:path');
const http=require('node:http');
const fs=require('node:fs');
let chromium;
try{chromium=require('playwright').chromium;}catch(error){
 console.log('SKIP dist smoke: playwright module not available (exit 77)');
 process.exit(77);
}
const ROOT=path.resolve(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.json':'application/json','.svg':'image/svg+xml'};
function serve(){
 return new Promise(resolve=>{
  const server=http.createServer((req,res)=>{
   const url=decodeURIComponent(req.url.split('?')[0]);
   let file;
   if(url==='/')file=path.join(ROOT,'dist','xhs-tool','index.html');
   else if(url.endsWith('/'))file=path.join(ROOT,url,'index.html');
   else{
    file=path.join(ROOT,'dist','xhs-tool',url);/* 打包页相对引用(./app.js 等)优先取包内文件 */
    if(!fs.existsSync(file))file=path.join(ROOT,url);/* 仓级资源回退 */
   }
   if(!file.startsWith(ROOT)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('not found');return;}
   res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream'});
   fs.createReadStream(file).pipe(res);
  });
  server.listen(8917,'127.0.0.1',()=>resolve(server));
 });
}
(async()=>{
 const server=await serve();
 const browser=await require('./launch-browser.cjs').launchBrowser();
 try{
  const results=[];
  for(const target of ['/dist/xhs-tool/']){
   const page=await browser.newPage(),missing=[],errors=[];
   page.on('response',r=>{if(r.status()===404)missing.push(r.url());});
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:8917'+target,{waitUntil:'load'});
   await page.waitForFunction(()=>typeof FilmifyEngine!=='undefined'&&typeof FilmifyMobile!=='undefined');
   results.push({target,missing:missing,errors:errors});
   await page.close();
  }
  // Develop checks live in the packaged smoke harness page.
  const page=await browser.newPage();
  page.on('pageerror',e=>{throw e;});
  await page.goto('http://127.0.0.1:8917/scripts/dist-smoke-page.html',{waitUntil:'load'});
  await page.waitForFunction(()=>document.title.startsWith('SMOKE:'),null,{timeout:120000});
  const report=JSON.parse(await page.locator('#result').textContent());
  await page.close();
  results.push({target:'smoke-page',verdict:report.verdict,checks:report.checks});
  console.log(JSON.stringify(results,null,1));
  const assert=require('node:assert/strict');
  for(const r of results){
   if(!r.missing)continue;
   assert.deepEqual(r.missing,[],'Missing packaged assets: '+r.missing.join(', '));
   assert.deepEqual(r.errors,[],'Page errors: '+r.errors.join(' | '));
  }
  assert.deepEqual(report.errors||[],[],'Smoke page errors: '+(report.errors||[]).join(' | '));
  assert.equal(report.verdict,'PASS','Smoke page verdict: '+JSON.stringify(report.checks));
  console.log('PASS dist smoke: packaged tool loads cleanly; mobile develop, progress and mono path verified');
 }finally{
  await browser.close();server.close();
 }
})().catch(error=>{console.error('FAIL dist smoke:',error.message||error);process.exit(1);});
