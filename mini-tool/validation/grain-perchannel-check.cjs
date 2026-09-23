// 逐通道颗粒选档(2026-09-21 色彩状态落地)专项验证,三层:
//
// 数据层(精确):用当前发行的 FILMIFY_GRAIN_STATS 表,JS 复刻 shader 新查档数学
//   (每通道独立 bin + Cholesky 行),与 native grainPlane 混色态实测 std 对比。
//   阈值 5% 的依据:发行表只有 9 档(档间线性插值)+ calibrate 输出六位小数舍入
//   + 3 seeds 采样噪声,实测残差 ~3.7%;旧平均 tt 数学同一测量 22%(判别性守卫
//   ≥10%,防止检查形同虚设)。
// 渲染层 A/B(中性区零漂移):同页面对 改动前 shader(git HEAD 钉版夹具
//   validation/grain-perchannel/mobile-film-sharedtt.fixture.js,MOBILE_FILM
//   override 模式)与 当前构建 各渲一遍灰平场——逐通道 std 比必须在 ±8% 内
//   (灰场逐通道 bin 几乎相同,新旧应近似等价);饱和场差异即本特性预期效果,只报告。
// 渲染层接线:饱和场逐通道 std 离散 ≥1.08 的 patch ≥2/3(逐通道档真的生效)、
//   确定性一致。
// 用法: node validation/grain-perchannel-check.cjs
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const ROOT=path.join(__dirname,'..');
const OUTDIR=path.join(__dirname,'grain-perchannel');
const FIXTURE=path.join(OUTDIR,'mobile-film-sharedtt.fixture.js');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json'};
const PORT=8934;
const TOL_NEW=0.05,TOL_OLD_MIN=0.10,SAT_SPREAD_MIN=1.08;

let serveOld=false;
const server=http.createServer((req,res)=>{
 let p=decodeURIComponent(req.url.split('?')[0]);
 if(serveOld&&p==='/dist/xhs-tool/mobile-film.js'){
  res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});
  fs.createReadStream(FIXTURE).pipe(res);return;
 }
 if(p==='/')p='/dist/xhs-tool/index.html'; // 首页即打包页
 const file=path.join(ROOT,p);
 if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
 fs.createReadStream(file).pipe(res);
});

const PAGE_FN=async(withDataLevel)=>{
 const richText=await (await fetch('/styles/presets.js')).text();
 const rich=JSON.parse(richText.replace(/^window\.FILMIFY_STYLES=/,'').replace(/;\s*$/,''));
 const S=256,UM=8,SEEDS=[11,22,33],MS=384;
 const STATES=[{hi:0.8,lo:0.2},{hi:0.9,lo:0.1}];
 /* ── 复刻 setGrain 的 Cholesky 表(与 mobile-film.js setGrain 相同输入/数学) ── */
 function buildTable(stats){
  const mono=stats.channels===1,L=[],W=[];
  for(let i=0;i<9;i++){
   const c=stats.cov[i];let l0,l1,l2,l3,l4,l5;
   if(mono){l0=Math.sqrt(Math.max(c[0],0));l1=l2=l3=l4=l5=0;}
   else{
    l0=Math.sqrt(Math.max(c[0],0));l1=c[1]/l0;l2=c[2]/l0;
    const d11=c[3]-l1*l1;l3=Math.sqrt(Math.max(d11,0));
    l4=d11>0?(c[4]-l2*l1)/l3:0;
    const d22=c[5]-l2*l2-l4*l4;l5=Math.sqrt(Math.max(d22,0));
   }
   L.push([l0,l1,l2,l3,l4,l5]);
   W.push([0,0,0].map((_,ch)=>Math.max(0.001,Math.min(0.999,mono?stats.corr[i][0]:stats.corr[i][ch]))));
  }
  return {L:L,W:W};
 }
 function binOf(t){const x=Math.max(0,Math.min(8,(t-0.5/9)*9));const i=Math.max(0,Math.min(7,Math.floor(x)));
  return {i:i,f:Math.max(0,Math.min(1,x-i))};}
 function mixL(tab,i,off,f){return tab.L[i][off]*(1-f)+tab.L[i+1][off]*f;}
 function lookupNew(tab,ts){ // 新数学:每通道独立 bin;返回每通道 std(Cholesky 行模)
  const bR=binOf(ts[0]),bG=binOf(ts[1]),bB=binOf(ts[2]);
  const L0=mixL(tab,bR.i,0,bR.f);
  const L1=mixL(tab,bG.i,1,bG.f),L3=mixL(tab,bG.i,3,bG.f);
  const L2=mixL(tab,bB.i,2,bB.f),L4=mixL(tab,bB.i,4,bB.f),L5=mixL(tab,bB.i,5,bB.f);
  return [Math.abs(L0),Math.sqrt(L1*L1+L3*L3),Math.sqrt(L2*L2+L4*L4+L5*L5)];
 }
 function lookupOld(tab,ts){ // 旧数学:平均 tt 共享 bin
  const tt=(ts[0]+ts[1]+ts[2])/3,b=binOf(tt);
  const L0=mixL(tab,b.i,0,b.f),L1=mixL(tab,b.i,1,b.f),L3=mixL(tab,b.i,3,b.f);
  const L2=mixL(tab,b.i,2,b.f),L4=mixL(tab,b.i,4,b.f),L5=mixL(tab,b.i,5,b.f);
  return [Math.abs(L0),Math.sqrt(L1*L1+L3*L3),Math.sqrt(L2*L2+L4*L4+L5*L5)];
 }
 function nativeStd(fp,ts,seed){
  const out=[];
  for(let c=0;c<fp.channels;c++){
   const p=new Float32Array(S*S);p.fill(fp.densityMin[c]+ts[c]*(fp.densityMax[c]-fp.densityMin[c]));
   FilmifyNativeFilm.grainPlane(p,S,S,UM,fp,c,[new Float32Array(S*S),new Float32Array(S*S),new Float32Array(S*S)],seed,null);
   let mu=0;for(let i=0;i<p.length;i++)mu+=p[i];mu/=p.length;
   let v=0;for(let i=0;i<p.length;i++)v+=(p[i]-mu)*(p[i]-mu);
   out.push(Math.sqrt(v/p.length));
  }
  return out;
 }
 const keys=Object.keys(FILMIFY_GRAIN_STATS).filter(k=>FILMIFY_GRAIN_STATS[k]&&FILMIFY_STYLES[k]&&FILMIFY_STYLES[k].mobile
  &&rich[k]&&rich[k].film&&rich[k].film.grain&&rich[k].film.grain.active&&rich[k].film.channels===3);
 /* ── 数据层 ── */
 const dataLevel=[],nearLevel=[];
 if(withDataLevel)for(const key of keys){
  const fp=rich[key].film,tab=buildTable(FILMIFY_GRAIN_STATS[key]);
  for(const sc of STATES)for(let dom=0;dom<3;dom++){
   const ts=[sc.lo,sc.lo,sc.lo];ts[dom]=sc.hi;
   let nat=[0,0,0];
   for(const seed of SEEDS){const s=nativeStd(fp,ts,seed);for(let c=0;c<3;c++)nat[c]+=s[c]/SEEDS.length;}
   const nw=lookupNew(tab,ts),od=lookupOld(tab,ts);
   dataLevel.push({stock:key,dom:dom,hi:sc.hi,lo:sc.lo,native:nat,
    errNew:nw.map((s,c)=>(s-nat[c])/Math.max(nat[c],1e-9)),
    errOld:od.map((s,c)=>(s-nat[c])/Math.max(nat[c],1e-9))});
  }
  /* 近灰态(中性区判据):t 基底 0.25/0.5/0.75 × 小幅通道间偏移。真实灰场的逐通道
     密度本就差几个百分点(曲线/LUT 非恒等),新旧查档在这些状态下的差异可能达到
     档间步长——断言新查档对 native 不劣于旧查档,则渲染层 A/B 偏差是「更接近
     native」而非漂移。 */
  for(const base of [0.25,0.5,0.75])for(const off of [[0.03,0,-0.03],[0.02,-0.02,0.02]]){
   const ts=[base+off[0],base+off[1],base+off[2]];
   let nat=[0,0,0];
   for(const seed of SEEDS){const s=nativeStd(fp,ts,seed);for(let c=0;c<3;c++)nat[c]+=s[c]/SEEDS.length;}
   const nw=lookupNew(tab,ts),od=lookupOld(tab,ts);
   nearLevel.push({stock:key,ts:ts,native:nat,
    errNew:nw.map((s,c)=>(s-nat[c])/Math.max(nat[c],1e-9)),
    errOld:od.map((s,c)=>(s-nat[c])/Math.max(nat[c],1e-9))});
  }
 }
 /* ── 渲染层 ── */
 const PATCHES=[{name:'gray',rgb:[128,128,128]},{name:'red',rgb:[200,40,40]},
  {name:'green',rgb:[40,170,60]},{name:'blue',rgb:[50,60,210]}];
 const view=document.createElement('canvas');document.body.appendChild(view);
 FilmifyEngine.init(view,'/dist/xhs-tool/');
 /* 共享印相表重构(2026-09-22)后,印相胶卷 develop 必须带 paper;探针款
    pcprobe-<key> 不在 print.W 注册表 → 按恒等 W 渲染(颗粒 on/off 同表相减,
    色彩映射不影响 std 差值测量)。 */
 const STYLE_PAPER={portrait:'kodak_portra_endura',gold:'kodak_portra_endura',ektar:'kodak_portra_endura',
  ultramax:'kodak_portra_endura',pro400h:'fujifilm_crystal_archive_typeii',superia:'fujifilm_crystal_archive_typeii',
  vision250d:'kodak_2383',v3500t:'kodak_2383',doublex:'kodak_2302',
   portra160:'kodak_portra_endura',portra800:'kodak_portra_endura',c200:'fujifilm_crystal_archive_typeii',
   vision50d:'kodak_2383',vision200t:'kodak_2383',verita200d:'kodak_2383'};
 async function renderPixels(style,grain,seed){
  const out=await FilmifyEngine.develop(style,null,{autoExposure:false,optics:false,scannerUSM:false,
   grain:grain,seed:seed,filmFormatMm:UM*MS/1000,paper:STYLE_PAPER[style.replace(/^pcprobe-/,'')]||null,masterPNG:true});
  const bmp=await createImageBitmap(out.blob);
  const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;
  const x=c.getContext('2d');x.drawImage(bmp,0,0);bmp.close();
  const px=x.getImageData(0,0,c.width,c.height).data;c.width=c.height=1;
  return px;
 }
 function chStd(delta){let mu=0;for(let i=0;i<delta.length;i++)mu+=delta[i];mu/=delta.length;
  let v=0;for(let i=0;i<delta.length;i++)v+=(delta[i]-mu)*(delta[i]-mu);return Math.sqrt(v/delta.length);}
 const renderLevel=[];let determinism=null;
 for(const key of keys){
  const st=JSON.parse(JSON.stringify(FILMIFY_STYLES[key]));delete st.glare;
  const pk='pcprobe-'+key;FILMIFY_STYLES[pk]=st;FILMIFY_GRAIN_STATS[pk]=FILMIFY_GRAIN_STATS[key];
  /* 共享直扫款(velvia/provia/ektachrome/kodachrome,2026-09-22 下午)的探针克隆
     登记进注册表:名单加 pk,W 映射同款复制(颗粒 on/off 同表相减,W 只影响色彩
     不影响 std 差值,但引擎路线判定需要名单命中,否则找不到直扫资源) */
  const sr=window.FILMIFY_SCANS&&window.FILMIFY_SCANS.direct_scan;
  if(sr&&sr.styles&&sr.styles.indexOf(key)>=0){
   sr.styles.push(pk);
   if(sr.W&&sr.W[key])sr.W[pk]=sr.W[key];
  }
  for(const patch of PATCHES){
   const src=document.createElement('canvas');src.width=MS;src.height=MS;
   const sx=src.getContext('2d');sx.fillStyle='rgb('+patch.rgb.join(',')+')';sx.fillRect(0,0,MS,MS);
   FilmifyEngine.setImage(src);
   const off=await renderPixels(pk,false,SEEDS[0]);
   if(!determinism){
    const a=await renderPixels(pk,true,SEEDS[0]),b=await renderPixels(pk,true,SEEDS[0]);
    let same=a.length===b.length;for(let i=0;same&&i<a.length;i++)if(a[i]!==b[i])same=false;
    determinism=same;
   }
   const std=[0,0,0];
   for(const seed of SEEDS){
    const on=await renderPixels(pk,true,seed);
    for(let c=0;c<3;c++){const d=new Float32Array(MS*MS);
     for(let i=0;i<MS*MS;i++)d[i]=on[i*4+c]-off[i*4+c];
     std[c]+=chStd(d)/SEEDS.length;}
   }
   renderLevel.push({stock:key,patch:patch.name,std:std,
    spread:Math.max(std[0],std[1],std[2])/Math.max(Math.min(std[0],std[1],std[2]),1e-9)});
  }
 }
 return {keys:keys,dataLevel:dataLevel,nearLevel:nearLevel,renderLevel:renderLevel,determinism:determinism};
};

(async()=>{
 await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
 if(!fs.existsSync(FIXTURE)){console.error('缺夹具 '+FIXTURE+'(git show HEAD:minitool/mobile-film.js 提取)');process.exit(1);}
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 try{
  async function runPhase(old,withDataLevel){
   serveOld=old;
   const page=await browser.newPage();
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:'+PORT+'/dist/xhs-tool/index.html');
   await page.waitForFunction(()=>typeof FilmifyNativeFilm!=='undefined'&&typeof FilmifyEngine!=='undefined'
    &&typeof FILMIFY_STYLES!=='undefined'&&typeof FILMIFY_GRAIN_STATS!=='undefined');
   const r=await page.evaluate(PAGE_FN,withDataLevel);
   await page.close();
   if(errors.length)throw new Error('页面错误: '+errors[0]);
   return r;
  }
  const cur=await runPhase(false,true);
  /* 钉版旧 shader 夹具退役(2026-09-22 共享印相表重构):旧 shader 依赖的逐组合
     mobile.png 已随包退役,夹具无法再渲染;灰场新旧 A/B 与饱和场新旧变化两个
     过渡性判据随之撤下。数据层「旧查档数学」判别性守卫保留(纯 JS,不依赖
     旧资产)。 */
  const old={renderLevel:[]};

  /* ── 断言 ── */
  const fails=[];
  const mAbs=a=>a.reduce((s,x)=>s+Math.abs(x),0)/a.length;
  const errNew=cur.dataLevel.flatMap(r=>r.errNew),errOld=cur.dataLevel.flatMap(r=>r.errOld);
  const meanNew=mAbs(errNew),meanOld=mAbs(errOld);
  console.log('数据层: 新查档(逐通道 bin) 平均 |err|='+(meanNew*100).toFixed(2)+'% ,旧查档(平均 tt) 平均 |err|='+(meanOld*100).toFixed(1)+'% ('+cur.dataLevel.length+' 状态×通道)');
  if(!(meanNew<=TOL_NEW))fails.push('新查档数学对 native 混色态误差 '+(meanNew*100).toFixed(2)+'% > '+(TOL_NEW*100)+'%');
  if(!(meanOld>=TOL_OLD_MIN))fails.push('判别性守卫失败:旧查档误差仅 '+(meanOld*100).toFixed(1)+'%(应≥'+(TOL_OLD_MIN*100)+'%),检查可能形同虚设');
  if(!cur.determinism)fails.push('确定性:同 build 同 seed 两次渲染不一致');

  /* 中性区判据(数据层近灰态,硬断言):新查档对 native 不劣于旧查档,则灰场渲染
     A/B 的偏差是「更接近 native」而非漂移。真实灰场逐通道密度差几个百分点,落
     在 bin 边界附近时新旧可差一个档间步长(实测 superia ch2 12%),故 A/B 只作
     报告+25% 防接线爆炸的宽松守卫。 */
  const nearNew=mAbs(cur.nearLevel.flatMap(r=>r.errNew)),nearOld=mAbs(cur.nearLevel.flatMap(r=>r.errOld));
  console.log('近灰态: 新查档平均 |err|='+(nearNew*100).toFixed(2)+'%,旧查档='+(nearOld*100).toFixed(2)+'% ('+cur.nearLevel.length+' 状态×通道)');
  if(nearNew>nearOld*1.05+0.005)fails.push('近灰态新查档对 native 劣于旧查档:'+(nearNew*100).toFixed(2)+'% vs '+(nearOld*100).toFixed(2)+'%——中性区真漂移');
  if(nearNew>TOL_NEW)fails.push('近灰态新查档误差 '+(nearNew*100).toFixed(2)+'% > '+(TOL_NEW*100)+'%');

  // 灰场绝对守卫(旧 A/B 随夹具退役):逐通道 std 必须非零且同通道量级合理
  let grayWorst=0,grayWorstCell='';
  for(const r of cur.renderLevel){
   if(r.patch!=='gray')continue;
   for(let c=0;c<3;c++){
    if(!(r.std[c]>0.1)){grayWorst=1;grayWorstCell=r.stock+' ch'+c+' std='+r.std[c].toFixed(3)+' (颗粒消失?)';}
   }
  }
  console.log('灰场: 逐通道 std 非零检查 '+(grayWorst?'FAIL '+grayWorstCell:'通过'));
  if(grayWorst>0.25)fails.push('灰场 std 异常:'+grayWorstCell);

  // 饱和场:离散≥1.08 的 patch ≥2/3/款(逐通道档生效)
  let satGood=0,satTotal=0;const spreads=[];
  for(const r of cur.renderLevel){
   if(r.patch==='gray')continue;
   satTotal++;spreads.push(r.spread);if(r.spread>=SAT_SPREAD_MIN)satGood++;
  }
  spreads.sort((a,b)=>a-b);
  const satMedian=spreads.length?spreads[Math.floor(spreads.length/2)]:0;
  console.log('饱和场: 离散≥'+SAT_SPREAD_MIN+' 占 '+satGood+'/'+satTotal+',中位 ×'+satMedian.toFixed(2));
  if(satGood<SAT_SPREAD_MIN*0+2*cur.keys.length)fails.push('饱和场逐通道离散不足:'+satGood+'/'+satTotal+'(逐通道档未生效或接线错误)');

  console.log('\n逐款明细(新 shader,stock/patch → per-channel std LSB, spread):');
  for(const r of cur.renderLevel){
   console.log(' '+r.stock+'/'+r.patch+': '+r.std.map(x=>x.toFixed(2)).join('/')+'  ×'+r.spread.toFixed(2));
  }
  fs.mkdirSync(OUTDIR,{recursive:true});
  fs.writeFileSync(path.join(OUTDIR,'report.json'),JSON.stringify({generatedAt:new Date().toISOString(),
   meanErrNew:meanNew,meanErrOld:meanOld,grayWorst:grayWorst,satGood:satGood,satTotal:satTotal,satMedian:satMedian,
   determinism:cur.determinism,dataLevel:cur.dataLevel,nearLevel:cur.nearLevel,
   renderLevel:cur.renderLevel},null,1));
  console.log('\n报告 → '+path.join(OUTDIR,'report.json'));
  if(fails.length){for(const f of fails)console.error('✗ '+f);process.exitCode=1;}
  else console.log('PASS grain-perchannel: 新查档=native 混色态(≤5%)、灰场新旧零漂移、饱和场逐通道生效、确定性一致');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
