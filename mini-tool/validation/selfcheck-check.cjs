// 真机自检机制定向验证（2026-09-21 Android 假色事故防线）:
//   1) 正常构建:velvia/portrait 显影成功,FILMIFY_DIAG.caps 就位,无 gpuOpticsBroken;
//   2) 破坏 GPU 光学场(高斯 shader 输出放大 17 倍):显影仍成功,会话锁定 CPU 场
//      (FILMIFY_DIAG.gpuOpticsBroken=true),成片与纯 CPU 光学场渲染逐像素一致(max<=2);
//   3) 破坏色彩核心(扫描 LUT 坐标 b/r 互换):显影必须中止,错误信息含自检诊断码,
//      绝不输出假色照片。
// 用法: 先 npm run build,再 node validation/selfcheck-check.cjs
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const ROOT=path.join(__dirname,'..');
const DIST=path.join(ROOT,'dist','xhs-tool');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json'};
const PORT=Number(process.env.PORT)||8964;
let override=null; // 非空时替换 dist/xhs-tool/mobile-film.js
let lutOverride=null; // 非空时替换 {path: 包内路径, file: 替代文件}
const server=http.createServer((req,res)=>{
 const rel=decodeURIComponent(req.url.split('?')[0]);
 let file;
 if(rel==='/mobile-film.js'&&override)file=override;
 else if(lutOverride&&rel===lutOverride.path)file=lutOverride.file;
 else file=path.join(DIST,rel==='/'?'/index.html':rel);
 if(!fs.existsSync(file)){res.statusCode=404;res.end();return;}
 if(file!==override&&(!lutOverride||file!==lutOverride.file)&&!file.startsWith(DIST)){res.statusCode=404;res.end();return;}
 res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
 fs.createReadStream(file).pipe(res);
});
function mustReplace(src,from,to){
 if(!src.includes(from))throw new Error('dist mobile-film.js 中未找到待替换片段: '+from.slice(0,60));
 return src.replace(from,to);
}
(async()=>{
 const src=fs.readFileSync(path.join(DIST,'mobile-film.js'),'utf8');
 // 破坏 GPU 光学场:FIR 高斯累加放大 17 倍 → 场值整体错误但不触发任何 GL 错误
 const badGauss=mustReplace(src,'acc+=uW[k+7]*val;','acc+=uW[k+7]*val*17.0;');
 // 破坏色彩核心:主渲染的扫描 LUT 采样坐标 b/r 互换 → 假色,同样无 GL 错误
 const badCore=mustReplace(src,'vec3 s=sampleTable(colorLUT,lutSize,t);','vec3 s=sampleTable(colorLUT,lutSize,t.bgr);');
 const badGaussFile=path.join(os.tmpdir(),'mobile-film-badgauss-'+Date.now()+'.js');
 const badCoreFile=path.join(os.tmpdir(),'mobile-film-badcore-'+Date.now()+'.js');
 fs.writeFileSync(badGaussFile,badGauss);
 fs.writeFileSync(badCoreFile,badCore);
 await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const load=async()=>{
  await page.goto('http://127.0.0.1:'+PORT+'/',{waitUntil:'load'});
  await page.waitForFunction(()=>typeof FilmifyEngine!=='undefined'&&typeof FILMIFY_STYLES!=='undefined');
  await page.evaluate(()=>{const v=document.createElement('canvas');document.body.appendChild(v);FilmifyEngine.init(v,'/');return true;});
 };
 const RENDER=async(opts)=>page.evaluate(async(opts)=>{
  const W=800,H=533;
  const c=document.createElement('canvas');c.width=W;c.height=H;
  const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,W,H);
  g.addColorStop(0,'#16324a');g.addColorStop(.5,'#c28d4e');g.addColorStop(1,'#e8e8cc');
  x.fillStyle=g;x.fillRect(0,0,W,H);
  x.fillStyle='#fff';x.fillRect(W/2-40,H/2-40,80,80);
  FilmifyEngine.setImage(c);
  try{
   const r=await FilmifyEngine.develop('velvia',null,Object.assign({filmFormatMm:35,autoExposure:false,seed:7},opts));
   const b64=await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result.split(',')[1]);fr.readAsDataURL(r.blob);});
   return {ok:true,b64:b64,timings:r.timings,diag:window.FILMIFY_DIAG||null};
  }catch(error){
   return {ok:false,message:String(error&&error.message||error),diag:window.FILMIFY_DIAG||null};
  }finally{c.width=c.height=1;}
 },opts);
 const DECODE=async b64=>page.evaluate(async(b64)=>{
  const blob=await(await fetch('data:image/png;base64,'+b64)).blob();
  const img=await createImageBitmap(blob);
  const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
  const x=c.getContext('2d');x.drawImage(img,0,0);
  const d=x.getImageData(0,0,c.width,c.height).data;
  let maxAbs=0; // 由调用方比较;此处只回传抽样以省序列化
  const sample=[];for(let i=0;i<d.length;i+=397*4)sample.push(d[i],d[i+1],d[i+2]);
  return {w:c.width,h:c.height,sample:sample,dataLen:d.length};
 },b64);
 const DIFF=async(a,b)=>page.evaluate(async(pair)=>{
  const pa=pair.a,pb=pair.b;
  const dec=async b64=>{
   const blob=await(await fetch('data:image/png;base64,'+b64)).blob();
   const img=await createImageBitmap(blob);
   const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
   const x=c.getContext('2d');x.drawImage(img,0,0);
   return x.getImageData(0,0,c.width,c.height).data;
  };
  const A=await dec(pa),B=await dec(pb);
  if(A.length!==B.length)return {maxAbs:999};
  let maxAbs=0;
  for(let i=0;i<A.length;i++){if(i%4===3)continue;const d=Math.abs(A[i]-B[i]);if(d>maxAbs)maxAbs=d;}
  return {maxAbs:maxAbs};
 },{a:a,b:b});
 try{
  // ── 1) 正常构建:自检静默通过 ──
  override=null;await load();
  const ok=await RENDER({});
  if(!ok.ok)throw new Error('正常构建显影失败: '+ok.message);
  if(!ok.diag||!ok.diag.caps||typeof ok.diag.caps.renderer!=='string'||!ok.diag.caps.renderer.length)
   throw new Error('FILMIFY_DIAG.caps.renderer 缺失');
  if(ok.diag.gpuOpticsBroken)throw new Error('正常构建不应触发 gpuOpticsBroken');
  if(!ok.timings.gpuRenderer)throw new Error('timings.gpuRenderer 缺失');
  console.log('PASS 1 正常构建:自检通过,caps 就位 ('+ok.diag.caps.renderer.slice(0,40)+'…),opticsGPU='+ok.timings.opticsGPU);

  // ── 2) GPU 光学场被破坏:交叉校验识别 → CPU 回退,成片仍正确 ──
  override=badGaussFile;await load();
  const fb=await RENDER({});
  if(!fb.ok)throw new Error('破坏光学场后显影应回退成功,实际报错: '+fb.message);
  if(!fb.diag||fb.diag.gpuOpticsBroken!==true)throw new Error('破坏光学场后未锁定 CPU 路径 (gpuOpticsBroken!==true)');
  if(fb.timings.opticsGPU!==0)throw new Error('回退后 timings.opticsGPU 应为 0');
  // 全新页面(同破坏构建)强制纯 CPU 光学场渲染作对照
  await load();
  const cpuOnly=await RENDER({gpuOptics:false});
  if(!cpuOnly.ok)throw new Error('CPU 对照渲染失败: '+cpuOnly.message);
  const d=await DIFF(fb.b64,cpuOnly.b64);
  if(d.maxAbs>2)throw new Error('回退成片与纯 CPU 成片不一致: max='+d.maxAbs);
  console.log('PASS 2 GPU 场被破坏:交叉校验识别(maxΔ 超差),锁定 CPU,回退成片与纯 CPU max='+d.maxAbs);

  // ── 3) 色彩核心被破坏:必须中止显影,不得输出假色 ──
  override=badCoreFile;await load();
  const bad=await RENDER({});
  if(bad.ok)throw new Error('色彩核心被破坏后显影居然成功 — 自检未拦截');
  if(!/色彩核心自检未通过/.test(bad.message))throw new Error('错误信息不含自检诊断码: '+bad.message);
  if(!bad.diag||!bad.diag.coreFail)throw new Error('FILMIFY_DIAG.coreFail 缺失');
  console.log('PASS 3 色彩核心被破坏:显影中止,诊断码「'+bad.diag.coreFail+'」');

  // ── 4) LUT 文件被平台链路损坏:装载时必须被完整性校验拦截 ──
  // velvia 已入共享直扫表(2026-09-22 下午,逐款 velvia-mobile.png 退役):
  // 破坏对象改为 scan-fujifilm_velvia_100-41.png(velvia 显影实际装载的扫描表)
  const lutPath='/styles/scan-fujifilm_velvia_100-41.png';
  const lutBuf=fs.readFileSync(path.join(DIST,lutPath.slice(1)));
  const corruptBuf=Buffer.from(lutBuf);
  corruptBuf[corruptBuf.length>>>1]^=0xff; // 中间翻一个字节,PNG 解码可能仍成功但值已变
  const corruptFile=path.join(os.tmpdir(),'velvia-corrupt-'+Date.now()+'.png');
  fs.writeFileSync(corruptFile,corruptBuf);
  override=null;lutOverride={path:lutPath,file:corruptFile};
  await load();
  const corrupt=await RENDER({});
  // 两种合法结果:PNG 解码失败(资源未准备好)或像素变了(校验失败);绝不能显影成功
  if(corrupt.ok)throw new Error('LUT 被损坏后显影居然成功 — 完整性校验未拦截');
  if(!/校验失败|没有准备好|尺寸异常|读取失败/.test(corrupt.message))
   throw new Error('LUT 损坏的错误信息不含校验/资源提示: '+corrupt.message);
  console.log('PASS 4 LUT 损坏:装载被拦截,「'+corrupt.message.slice(0,42)+'…」');
  fs.unlinkSync(corruptFile);lutOverride=null;

  // 正式页面不显示调试诊断面板。
  //        包内无 diag.js、运行时无 FilmifyDiag、主页无可见入口、连点不再弹层 ──
  await load();
  await page.waitForSelector('.brandline',{timeout:5000});
  const gone=await page.evaluate(()=>({
   lex:typeof FilmifyDiag==='undefined',
   entry:!!document.querySelector('.diag-entry')
  }));
  if(!gone.lex)throw new Error('FilmifyDiag 仍然存在,面板未撤干净');
  if(gone.entry)throw new Error('主页仍有「设备诊断」可见入口');
  if(fs.existsSync(path.join(DIST,'diag.js')))throw new Error('dist 仍含 diag.js');
  for(let i=0;i<7;i++){
   await page.click('.brandline');
   if(await page.locator('.diag-backdrop').count())throw new Error('品牌标仍会弹出诊断面板');
   // A legitimate About dialog is now opened by the brand. Dismiss it before
   // the next click; the retired diagnostics must remain absent throughout.
   const about=page.locator('.about-backdrop [data-action="close-sheet"]');
   if(await about.count())await about.first().click();
  }
  await page.waitForTimeout(400);
  const popped=await page.evaluate(()=>!!document.querySelector('.diag-backdrop'));
  if(popped)throw new Error('连点品牌标仍会弹出诊断面板');
  console.log('PASS 5 诊断面板撤离:无 diag.js/无 FilmifyDiag/无可见入口/连点不弹层');

  if(errors.length){console.error('PAGEERRORS:',errors);process.exit(1);}
  console.log('PASS selfcheck: 正常/光学场回退/核心中止/LUT 拦截/面板撤离 全部符合预期');
 }finally{
  fs.unlinkSync(badGaussFile);fs.unlinkSync(badCoreFile);
  await browser.close();server.close();
 }
})().catch(e=>{console.error('FAIL',e.message||e);process.exit(1);});
