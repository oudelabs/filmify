// 最终 dither 定向验证:同图同 seed 渲染「带 dither / 去 dither」两版,逐像素断言:
//   1) max|Δ| ≤ 1 (±0.5 LSB 抖动的量化翻转最多 1 个码值)
//   2) mae ≤ 0.6 且均值差 ≈ 0 (零均值,不改变亮度)
//   3) 差异像素占比 > 1% (dither 确实生效,而非恒等)
// 另做确定性复现:同 build 两次渲染 PNG 逐字节一致。
// 用法: 先 npm run build,再 node validation/dither-check.cjs
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const ROOT=path.join(__dirname,'..');
const DIST=path.join(ROOT,'dist','xhs-tool');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json'};
const PORT=Number(process.env.PORT)||8961;
const DITHER_BLOCK=' s+=(dith-.5)/255.;';
const SCAN_DITHER='s+(noise-.5)/255.';
let override=null; // 非空时替换 dist/xhs-tool/mobile-film.js
const server=http.createServer((req,res)=>{
 const rel=decodeURIComponent(req.url.split('?')[0]);
 let file;
 if(rel==='/mobile-film.js'&&override)file=override;
 else file=path.join(DIST,rel==='/'?'/index.html':rel);
 if(!fs.existsSync(file)){res.statusCode=404;res.end();return;}
 if(file!==override&&!file.startsWith(DIST)){res.statusCode=404;res.end();return;}
 res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
 fs.createReadStream(file).pipe(res);
});
function stripDither(src){
 if(!src.includes(DITHER_BLOCK))throw new Error('dist mobile-film.js 中未找到 dither 代码块,无法生成去 dither 对照版');
 if(!src.includes(SCAN_DITHER))throw new Error('scanner dither missing');
 return src.replace(DITHER_BLOCK,'').replace(SCAN_DITHER,'s');
}
(async()=>{
 const noDitherFile=path.join(os.tmpdir(),'mobile-film-nodither-'+Date.now()+'.js');
 fs.writeFileSync(noDitherFile,stripDither(fs.readFileSync(path.join(DIST,'mobile-film.js'),'utf8')));
 await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // 页面内:渲染全部组合并返回 base64 图(Blob 无法跨 evaluate 序列化)
 const RENDER=async()=>page.evaluate(async()=>{
  const SIZE=800; /* 单 tile(≤896)尺寸:slowTier 降档会改变 tile 切分与 USM 边界,
                  大图跨会话计时抖动会破坏 A/A2/B 的布局一致性,单 tile 下该路径不存在 */
  function makeImage(kind){
   const w=SIZE,h=Math.round(SIZE*2/3),c=document.createElement('canvas');c.width=w;c.height=h;
   const x=c.getContext('2d');
   if(kind==='gradient'){
    const g=x.createLinearGradient(0,0,w,h);
    g.addColorStop(0,'#16324a');g.addColorStop(.5,'#cc8855');g.addColorStop(1,'#e8e8cc');
    x.fillStyle=g;x.fillRect(0,0,w,h);
   }else{
    x.fillStyle='#808080';x.fillRect(0,0,w,h);
    for(let i=0;i<w;i+=4){x.fillStyle=i%8?'#202020':'#e0e0e0';x.fillRect(i,0,2,h);}
    x.fillStyle='#c04030';x.beginPath();x.arc(600,400,220,0,7);x.fill();
    x.fillStyle='#2040c0';x.fillRect(100,550,300,180);
   }
   return c;
  }
  const toB64=async blob=>new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result.split(',')[1]);fr.onerror=rej;fr.readAsDataURL(blob);});
  const out={};
  for(const kind of ['gradient','edges'])for(const style of ['portrait','velvia']){
   const c=makeImage(kind);
   FilmifyEngine.setImage(c);
   /* 共享印相表重构(2026-09-22):印相胶卷必须带 paper(注册表有 W 的第一款),
      velvia/trix 直扫为 null。 */
   const paper=Object.keys(window.FILMIFY_PRINTS||{}).find(p=>((window.FILMIFY_PRINTS[p].W||{})[style]))||null;
   const r=await FilmifyEngine.develop(style,null,{filmFormatMm:35,autoExposure:false,seed:7,paper:paper,masterPNG:true});
   out[kind+'-'+style]=await toB64(r.blob);
   c.width=c.height=1;
  }
  return out;
 });
 // 页面内:解码 base64 → ImageData
 const DECODE=async b64=>page.evaluate(async(b64)=>{
  const blob=await(await fetch('data:image/png;base64,'+b64)).blob();
  const img=await createImageBitmap(blob);
  const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
  const x=c.getContext('2d');x.drawImage(img,0,0);
  const d=x.getImageData(0,0,c.width,c.height).data;
  return {w:c.width,h:c.height,data:Array.from(d)};
 },b64);
 const diffStats=(a,b)=>{
  const d=a.data,N=b.data,n=d.length;let maxAbs=0,mae=0,mean=0,diff=0;
  for(let i=0;i<n;i++){
   if(i%4===3)continue;
   const dv=d[i]-N[i],av=Math.abs(dv);
   if(av>maxAbs)maxAbs=av;mae+=av;mean+=dv;if(av>0)diff++;
  }
  const px=n/4;
  return {maxAbs:maxAbs,mae:mae/(px*3),mean:mean/(px*3),diffRatio:diff/px};
 };
 try{
  // 每次渲染都从全新页面加载开始:slowTier 是会话级记忆(超时后 tile 896→384),
  // 会改变 tile 切分与 USM 边界,必须让 A/A2/B 三组跑同一 tile 布局。
  const load=async()=>{
   await page.goto('http://127.0.0.1:'+PORT+'/',{waitUntil:'load'});
   await page.waitForFunction(()=>typeof FilmifyEngine!=='undefined'&&typeof FILMIFY_STYLES!=='undefined');
   await page.evaluate(()=>{const v=document.createElement('canvas');document.body.appendChild(v);FilmifyEngine.init(v,'/');return true;});
  };
  // A:带 dither(当前构建)
  await load();const a=await RENDER();
  // 确定性:全新页面再跑一次(同 build 同 seed)
  await load();const a2=await RENDER();
  for(const k of Object.keys(a))if(a[k]!==a2[k])throw new Error('确定性失败:同 build 同 seed 两次输出不一致 '+k);
  console.log('PASS determinism: 同 build 两次渲染 PNG 逐字节一致');
  // B:去 dither 对照(仅 shader 差 dither 块)
  override=noDitherFile;
  await load();const b=await RENDER();
  let worst=0;
  for(const k of Object.keys(a)){
   const A=await DECODE(a[k]),B=await DECODE(b[k]);
   const s=diffStats(A,B);
   console.log(k+': max|Δ|='+s.maxAbs+' mae='+s.mae.toFixed(3)+' meanΔ='+s.mean.toFixed(3)+' diffRatio='+(s.diffRatio*100).toFixed(1)+'%');
   if(s.maxAbs>1)throw new Error(k+' max|Δ|>1: '+s.maxAbs+' — dither 幅度越界');
   if(s.mae>0.6)throw new Error(k+' mae 过大: '+s.mae);
   if(Math.abs(s.mean)>0.1)throw new Error(k+' 均值偏移过大: '+s.mean);
   if(s.diffRatio<0.01)throw new Error(k+' 差异像素占比过低: dither 未生效');
   worst=Math.max(worst,s.maxAbs);
  }
  if(errors.length){console.error('PAGEERRORS:',errors);process.exit(1);}
  console.log('PASS dither: 幅度≤1 LSB、零均值、全部图像生效 (worst max|Δ|='+worst+')');
 }finally{
  fs.unlinkSync(noDitherFile);
  await browser.close();server.close();
 }
})().catch(e=>{console.error('FAIL',e.message||e);process.exit(1);});
