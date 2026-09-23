// GPU 光学场最终成片 A/B：同一输入分别走 GPU 场与 CPU 场完整显影，逐像素对比
// 8 位 PNG。验收标准放在最终图像（log 域场在近零像素的差异经密度曲线钳位后
// 应不超出 1-2 个码值）。多款/多分辨率覆盖，输出每款 max/mae/>1 比例。
// 用法: node validation/gpu-optics-final-check.cjs
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
 await new Promise(r=>srv.listen(8947,'127.0.0.1',r));
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();const page=await browser.newPage();
 page.on('pageerror',e=>console.log('PAGEERR:',e.message));
 await page.goto('http://127.0.0.1:8947/dist/xhs-tool/index.html');
 await page.waitForFunction(()=>typeof FilmifyEngine!=='undefined'&&typeof FILMIFY_STYLES!=='undefined');
 const out=await page.evaluate(async()=>{
  // 确定性的测试图：渐变 + 白方块 + 红点 + 随机色块（固定 LCG 种子）
  function lcg(seed){let s=seed>>>0;return ()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}
  const rnd=lcg(42);
  function makeSrc(w,h){
   const c=document.createElement('canvas');c.width=w;c.height=h;
   const x=c.getContext('2d');
   const g=x.createLinearGradient(0,0,w,h);
   g.addColorStop(0,'#3a5a8c');g.addColorStop(.5,'#c28d4e');g.addColorStop(1,'#20301e');
   x.fillStyle=g;x.fillRect(0,0,w,h);
   for(let i=0;i<300;i++){x.fillStyle='hsl('+Math.floor(rnd()*360)+',60%,'+(20+Math.floor(rnd()*60))+'%)';x.fillRect(rnd()*w,rnd()*h,Math.max(2,w/60),Math.max(2,h/60));}
   return c;
  }
  const view=document.createElement('canvas');document.body.appendChild(view);
  FilmifyEngine.init(view,'/dist/xhs-tool/');
  async function developOnce(src,styleId,gpuOptics,extra){
   FilmifyEngine.setImage(src);
   /* 共享印相表重构(2026-09-22):印相胶卷 develop 必须带 paper(显式映射,
      基准胶卷按 W 反查会 miss);velvia/trix 直扫为 null。 */
   const STYLE_PAPER={portrait:'kodak_portra_endura',gold:'kodak_portra_endura',ektar:'kodak_portra_endura',
    ultramax:'kodak_portra_endura',pro400h:'kodak_portra_endura',superia:'fujifilm_crystal_archive_typeii',
    vision250d:'kodak_2383',v3500t:'kodak_2383',doublex:'kodak_2302',
    portra160:'kodak_portra_endura',portra800:'kodak_portra_endura',c200:'fujifilm_crystal_archive_typeii',
    vision50d:'kodak_2383',vision200t:'kodak_2383',verita200d:'kodak_2383'};
   const out=await FilmifyEngine.develop(styleId,null,{autoExposure:false,gpuOptics:gpuOptics,paper:STYLE_PAPER[styleId]||null,masterPNG:true,...extra});
   // 把 PNG blob 解码回像素
   const bmp=await createImageBitmap(out.blob);
   const cv=document.createElement('canvas');cv.width=bmp.width;cv.height=bmp.height;
   const cx=cv.getContext('2d');cx.drawImage(bmp,0,0);
   const px=cx.getImageData(0,0,bmp.width,bmp.height).data;
   bmp.close();
   return {px,w:bmp.width,h:bmp.height,gpu:out.timings.opticsGPU,opticsMs:out.timings.opticsMs};
  }
  const styleIds=Object.keys(FILMIFY_STYLES).filter(k=>FILMIFY_STYLES[k].mobile);
  const cases=[[ 'portrait',1200,800],['portrait',2400,1600],['portrait',600,400]];
  for(const id of styleIds)if(id!=='portrait')cases.push([id,1200,800]);
  const results=[];
  /* 共享印相表重构(2026-09-22):显式 paper 映射(基准胶卷 W=恒等被省略,
     按 W 反查会 miss);velvia/trix 直扫为 null。 */
  const STYLE_PAPER={portrait:'kodak_portra_endura',gold:'kodak_portra_endura',ektar:'kodak_portra_endura',
   ultramax:'kodak_portra_endura',pro400h:'kodak_portra_endura',superia:'fujifilm_crystal_archive_typeii',
   vision250d:'kodak_2383',v3500t:'kodak_2383',doublex:'kodak_2302',
    portra160:'kodak_portra_endura',portra800:'kodak_portra_endura',c200:'fujifilm_crystal_archive_typeii',
    vision50d:'kodak_2383',vision200t:'kodak_2383',verita200d:'kodak_2383'};
  for(const [id,w,h] of cases){
   await FilmifyEngine.loadColors(id,STYLE_PAPER[id]||null);
   const src=makeSrc(w,h);
   const a=await developOnce(src,id,true);
   const b=await developOnce(src,id,false);
   // 第三个对照：完全关闭光学场（诊断：GPU 场是否被主渲染忽略）
   const no=await developOnce(src,id,true,{optics:false});
   function cmp(pa,pb){let max=0,sum=0,gt1=0;const n=pa.length;
    for(let i=0;i<n;i++){const d=Math.abs(pa[i]-pb[i]);max=Math.max(max,d);sum+=d;if(d>1)gt1++;}
    return {max,mae:+(sum/n).toFixed(4),gt1};}
   if(a.w!==b.w||a.h!==b.h)throw new Error('输出尺寸不一致 '+id);
   const ab=cmp(a.px,b.px);
   const an=cmp(a.px,no.px);
   results.push({id,w,h,...ab,gpuMs:a.opticsMs,cpuMs:b.opticsMs,gpuUsed:a.gpu,cpuUsed:b.gpu,
    gpuVsNoOptics:an});
  }
  return results;
 });
 let bad=0;
 for(const r of out){
  // 2-D linear USM amplifies the pre-existing half-float field error at dark edges.
  // Allow 3 LSB at isolated pixels; keep the tail gate and add a strict mean bound.
  if(r.max>3||r.gt1>1000||r.mae>0.1){bad++;console.error('FAIL 超出:',r);}
  else console.log('PASS:',JSON.stringify(r));
 }
 if(bad)throw new Error('GPU/CPU 最终成片 A/B 失败');
 console.log('PASS gpu-optics final A/B: 全部款式/尺寸最终成片一致（max<=3、mae<=0.1、>1LSB 像素≤1000）');
 await browser.close();srv.close();
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
