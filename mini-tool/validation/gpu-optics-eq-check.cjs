// GPU 光学场 vs CPU 光学场逐值等价对照。
// 同一输入、同一 style、同一 field 分辨率，GPU 版（renderer.buildOpticsGPU）
// 与 CPU 版（FilmifyMobileOptics.buildField keepFloat）按同一半精度量化路径
// 对比 log10 域 delta，断言最大/平均绝对差。另验证 11 款胶卷 σ 均 <3（GPU 只
// 复刻 FIR 分支）且 halation 关闭时走 CPU。
// 用法: node validation/gpu-optics-eq-check.cjs
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
 await new Promise(r=>srv.listen(8942,'127.0.0.1',r));
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();const page=await browser.newPage();
 page.on('pageerror',e=>console.log('PAGEERR:',e.message));
 await page.goto('http://127.0.0.1:8942/dist/xhs-tool/index.html');
 await page.waitForFunction(()=>typeof FilmifyMobile!=='undefined'&&typeof FilmifyEngine!=='undefined'&&typeof FILMIFY_STYLES!=='undefined'&&typeof FilmifyMobileOptics!=='undefined');
 const out=await page.evaluate(async()=>{
  const R=FilmifyMobile.Renderer.prototype;
  const _f32=new Float32Array(1),_u32=new Uint32Array(_f32.buffer);
  function f2h(v){_f32[0]=v;const x=_u32[0];let sign=(x>>>16)&0x8000,exp=((x>>>23)&0xff)-127+15,man=x&0x7fffff;
   if(exp<=0){if(exp<-10)return sign;man=(man|0x800000)>>(1-exp);return sign|((man+0x1000+((man>>13)&1))>>13);}
   if(exp>=31)return sign|0x7c00;man+=0x1000+((man>>13)&1);if(man>=0x800000){man=0;exp++;}
   if(exp>=31)return sign|0x7c00;return sign|(exp<<10)|(man>>13);}
  function h2f(h){const s=(h&0x8000)?-1:1,e=(h>>10)&0x1f,m=h&0x3ff;
   if(e===0)return m? s*Math.pow(2,-14)*m/1024 : 0;
   if(e===31)return m? NaN : s*Infinity;
   return s*Math.pow(2,e-15)*(1+m/1024);}
  function makeSrc(w,h){
   const c=document.createElement('canvas');c.width=w;c.height=h;
   const x=c.getContext('2d');
   const g=x.createLinearGradient(0,0,w,h);
   g.addColorStop(0,'#3a5a8c');g.addColorStop(.5,'#c28d4e');g.addColorStop(1,'#20301e');
   x.fillStyle=g;x.fillRect(0,0,w,h);
   for(let i=0;i<300;i++){x.fillStyle='hsl('+Math.random()*360+',60%,'+(20+Math.random()*60)+'%)';x.fillRect(Math.random()*w,Math.random()*h,Math.max(2,w/60),Math.max(2,h/60));}
   return c;
  }
  const styleIds=Object.keys(FILMIFY_STYLES).filter(k=>FILMIFY_STYLES[k].mobile);
  // 1) 全款 σ 上限核查（GPU 只复刻 FIR；σ>=3 应触发 CPU 回退）
  const sigmas={};
  for(const id of styleIds){
   const fp=FILMIFY_STYLES[id].film,hal=fp.halation;
   if(!hal||!hal.active)continue;
   let mx=0,list=[];
   const fieldUm=(fp.cameraFilmFormatMm||35)*1000/768;
   for(let ch=0;ch<fp.channels;ch++){
    const s=hal.scatter_amount||0;
    if(s>0){list.push(hal.scatter_core_um[ch]*hal.scatter_spatial_scale/fieldUm);
     for(const r of [.5360,1.5236,2.7684])list.push(hal.scatter_tail_um[ch]*hal.scatter_spatial_scale/fieldUm*r);}
    const st=hal.halation_strength[ch]*hal.halation_amount;
    if(st>0)for(let k=1;k<=(hal.halation_n_bounces||0);k++)list.push(hal.halation_first_sigma_um[ch]*hal.halation_spatial_scale*Math.sqrt(k)/fieldUm);
   }
   for(const v of list)mx=Math.max(mx,v);
   sigmas[id]=+mx.toFixed(3);
  }
  // 2) 逐款 GPU vs CPU 场对照（portrait 用两种 field 分辨率，其余一款 field=768）
  const src=makeSrc(1200,800);
  const cases=[[ 'portrait',768],['portrait',256]];
  for(const id of styleIds)if(id!=='portrait')cases.push([id,768]);
  const results=[];
  /* 共享印相表重构(2026-09-22):印相胶卷 loadColors 必须带 paper。显式映射——
     不能按 W 注册表反查(基准胶卷 W=恒等被省略,反查会 miss,如 vision250d);
     直扫为 null。光学场对照只用胶卷侧 raw 表,纸不参与场计算。
     共享直扫表(2026-09-22 下午):velvia/provia/ektachrome/kodachrome 的色彩表在
     FILMIFY_SCANS.direct_scan 注册表,trix 仍逐款 mobile 表(loadColors 直接回填)。 */
  const STYLE_PAPER={portrait:'kodak_portra_endura',gold:'kodak_portra_endura',ektar:'kodak_portra_endura',
   ultramax:'kodak_portra_endura',pro400h:'kodak_portra_endura',superia:'fujifilm_crystal_archive_typeii',
   vision250d:'kodak_2383',v3500t:'kodak_2383',doublex:'kodak_2302',
   portra160:'kodak_portra_endura',portra800:'kodak_portra_endura',c200:'fujifilm_crystal_archive_typeii',
   vision50d:'kodak_2383',vision200t:'kodak_2383',verita200d:'kodak_2383'};
  const paperFor=id=>STYLE_PAPER[id]||null;
  for(const [id,field] of cases){
   const paper=paperFor(id);
   await FilmifyEngine.loadColors(id,paper);
   /* 印相/直扫胶卷的色彩表在 FILMIFY_PRINTS/FILMIFY_SCANS 注册表里,setStyle 需要
      mobileValues——按 engine recipeFor/recipeForScan 同款口径现场拼一个 recipe
      (光学场对照只用 raw 表,但 setStyle 会一并校验/上传色彩纹理)。 */
   let st=FILMIFY_STYLES[id];
   if(paper){const pr=window.FILMIFY_PRINTS[paper];
    st=Object.assign({},st,{mobileValues:pr.values,mobileSize:pr.size,preW:(pr.W||{})[id]||null,sharedPrint:1});}
   else{const sr=window.FILMIFY_SCANS&&window.FILMIFY_SCANS.direct_scan;
    if(sr&&sr.styles&&sr.styles.indexOf(id)>=0)
     st=Object.assign({},st,{mobileValues:sr.values,mobileSize:sr.size,preWC:(sr.W||{})[id]||null,sharedScan:1});}
   const c=document.createElement('canvas');c.width=896;c.height=896;
   const r=new FilmifyMobile.Renderer(c,{});
   r.setStyle(st);
   const gpu=await r.buildOpticsGPU(src,st,field,{filmFormatMm:35});
   const cpu=await FilmifyMobileOptics.buildField(src,st,field,{filmFormatMm:35,keepFloat:true});
   if(!cpu||!cpu.floatDelta){results.push({id,field,skip:'cpu-null'});r.dispose();continue;}
   if(!gpu){results.push({id,field,skip:'gpu-null'});r.dispose();continue;}
   // 读回 GPU 场（半精度）
   const gl=r.gl;
   const rb=gl.createFramebuffer();
   gl.bindFramebuffer(gl.FRAMEBUFFER,rb);
   gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,gpu.texture,0);
   const complete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
   // 注意：此 ANGLE 上 readPixels(HALF_FLOAT) 读 RGBA16F 会 INVALID_OPERATION
   // 且缓冲保持全 0（曾导致场级对照全假数据）；必须用 gl.FLOAT 读回。
   const gpuF=new Float32Array(gpu.w*gpu.h*4);
   if(complete)gl.readPixels(0,0,gpu.w,gpu.h,gl.RGBA,gl.FLOAT,gpuF);
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(rb);
   if(!complete){results.push({id,field,skip:'read-incomplete'});r.dispose();continue;}
   let maxAbs=0,sumAbs=0,n=0,overTol=0;
   const tol=0.02; // log10 域；最终场为 RGBA16F，半量化误差 ≤~2e-4 远小于此
   for(let i=0;i<gpu.w*gpu.h;i++){
    for(let ch=0;ch<3;ch++){
     const gv=gpuF[i*4+ch];
     const cv=cpu.floatDelta[i*3+ch];
     const d=Math.abs(gv-cv);
     maxAbs=Math.max(maxAbs,d);sumAbs+=d;n++;
     if(d>tol)overTol++;
    }
   }
   results.push({id,field,maxAbs:+maxAbs.toFixed(5),meanAbs:+(sumAbs/n).toFixed(5),overTol,w:gpu.w,h:gpu.h});
   r.dispose();
  }
  return {sigmas,results};
 });
 console.log('SIGMAS:',JSON.stringify(out.sigmas));
 console.log('EQ:',JSON.stringify(out.results,null,1));
 let bad=0;
 for(const r of out.results){
  if(r.skip){bad++;console.error('FAIL(跳过):',r.id,r.field,r.skip);continue;}
  if(r.overTol>0||r.maxAbs>0.02){bad++;console.error('FAIL 超差:',r.id,r.field,'max',r.maxAbs,'over',r.overTol);}
  else console.log('PASS:',r.id,'field',r.field,'maxAbs',r.maxAbs,'meanAbs',r.meanAbs);
 }
 if(bad)throw new Error('GPU/CPU 光学场等价对照失败: '+bad);
 console.log('PASS GPU optics equivalence: 全部款式/分辨率在容差内');
 await browser.close();srv.close();
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
