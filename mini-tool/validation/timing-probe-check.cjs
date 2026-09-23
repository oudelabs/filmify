// 抽查 developMobile 五段计时埋点:注入一张照片走真实显影,读取 timings 与 FILMIFY_PROFILE。
// 用法: node validation/timing-probe-check.cjs
const {chromium}=require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json'};
const srv=http.createServer((req,res)=>{
 const rel=decodeURIComponent(req.url.split('?')[0]);
 const p=path.join(ROOT,rel==='/'?'/dist/xhs-tool/index.html':rel);
 fs.readFile(p,(e,d)=>{if(e){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type',MIME[path.extname(p)]||'application/octet-stream');
  res.end(d);});
});
(async()=>{
 await new Promise(r=>srv.listen(8923,'127.0.0.1',r));
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();const page=await browser.newPage();
 page.on('console',m=>{if(m.text().includes('developMobile ms'))console.log('CONSOLE:',m.text());});
 await page.goto('http://127.0.0.1:8923/dist/xhs-tool/index.html');
 await page.waitForFunction(()=>typeof FilmifyEngine!=='undefined'&&typeof FILMIFY_STYLES!=='undefined');
 const styleId=await page.evaluate(()=>Object.keys(FILMIFY_STYLES).find(k=>FILMIFY_STYLES[k].mobile));
 const info=await page.evaluate(async(style)=>{
  const c=document.createElement('canvas');c.width=2400;c.height=1600;
  const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,2400,1600);
  g.addColorStop(0,'#3a5a8c');g.addColorStop(.5,'#c28d4e');g.addColorStop(1,'#20301e');
  x.fillStyle=g;x.fillRect(0,0,2400,1600);
  for(let i=0;i<400;i++){x.fillStyle='hsl('+Math.random()*360+',60%,'+(20+Math.random()*60)+'%)';x.fillRect(Math.random()*2400,Math.random()*1600,30,30);}
  const view=document.createElement('canvas');document.body.appendChild(view);
  FilmifyEngine.init(view,'/dist/xhs-tool/');
  FilmifyEngine.setImage(c);
  const t0=performance.now();
  /* 共享印相表重构(2026-09-22):印相胶卷 develop 必须带 paper——优先该胶卷
     在 FILMIFY_PRINTS 注册表里有 W 的第一款纸,无注册(velvia/trix 直扫)走 null。 */
  const paper=Object.keys(window.FILMIFY_PRINTS||{}).find(p=>((window.FILMIFY_PRINTS[p].W||{})[style]))||null;
  const out=await FilmifyEngine.develop(style,null,{autoExposure:false,paper:paper});
  return {w:out.width,h:out.height,ms:Math.round(performance.now()-t0),timings:out.timings,
   profileEntries:(window.FILMIFY_PROFILE||[]).length};
 },styleId);
 console.log('style:',styleId);
 console.log('RESULT:',JSON.stringify(info,null,1));
 // 断言:五段都存在且为有限数,分段和不超过总时长太多(yield 计入 total 但不入段)
 const t=info.timings,keys=['opticsMs','uploadMs','shadeMs','compositeMs','encodeMs','totalMs','tiles'];
 for(const k of keys)if(!(Number.isFinite(t[k])&&t[k]>=0))throw new Error('timings 缺字段或非法: '+k);
 if(t.tiles<1)throw new Error('tiles 计数异常');
 console.log('PASS timing probe: 五段计时字段齐全、数值合法');
 await browser.close();srv.close();
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
