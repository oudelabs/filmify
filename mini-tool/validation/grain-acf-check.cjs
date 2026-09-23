// 颗粒裁判:native grainPlane 平场实测 vs mobile shader 平场复现的
// ACF(lag 1/2/4/8,x/y 双轴)+ 盒式尺度能量比(scale 2/4/8,白噪声=1)对比。
//
// 颗粒统计验收框架：
//  1) 首跑 --record-baseline 记录当前单分量 S9 模型的基线 validation/grain-acf/baseline.json;
//  2) 之后任何颗粒模型改动(逐通道标定/双分量/核扩展)重跑本脚本:
//     - lag1 标定不跑偏(硬断言,现模型本就是按 lag1 标定的);
//     - E_tail(lag2/lag4 双轴对 native 的平均绝对误差)与 E_scale8 不劣化于基线(硬断言);
//     - 误差缩小 = 「效果变好」的量化证据,不靠肉眼。
//  3) 报告的 native 尾巴实测(lag2/lag4、scale 能量比)本身就是提案②③的 go/no-go 数据。
//
// 形态说明:
//  - native 侧:每款胶片 9 个密度档 × 3 seeds,直接对 pinned grainPlane 输出(密度域)算统计;
//  - mobile 侧:去 glare 的探针配方渲染 6 档灰平场(512px,autoExposure/optics/scannerUSM 关),
//    取「grain on − grain off」差场(sRGB LSB 域)算统计,3 seeds 平均;
//  - 相关/能量比是归一化量,密度域与 sRGB 差场可直接对比(每通道线性缩放不变);
//    方差单位不同,仅记录不作跨侧断言;
//  - 档位对应:mobile 灰阶档按 lag1_x 最接近匹配 native 密度档(标定轴本就是 x 向 lag1)。
// 用法: node validation/grain-acf-check.cjs [--record-baseline]
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const ROOT=path.join(__dirname,'..');
const OUTDIR=path.join(__dirname,'grain-acf');
const RECORD=process.argv.includes('--record-baseline');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json'};

/* 验收阈值(首跑后按实测校准,见 validation/grain-acf/baseline.json 头部注释):
   - 每 cell |Δlag1_x| ≤ TOL_LAG1_CELL 的比例 ≥ FRAC_LAG1_OK(lag1 是现模型的标定目标);
   - 全体 E_lag1 ≤ TOL_E_LAG1;
   - 基线不劣化:E_tail/E_scale8 ≤ 基线 × REGRESS_FACTOR + REGRESS_ABS。 */
const TOL_LAG1_CELL=0.10,FRAC_LAG1_OK=0.90,TOL_E_LAG1=0.06;
const REGRESS_FACTOR=1.25,REGRESS_ABS=0.005,REGRESS_ABS_SCALE=0.05;

const server=http.createServer((req,res)=>{
 let p=decodeURIComponent(req.url.split('?')[0]);
 if(p==='/')p='/dist/xhs-tool/index.html'; // 首页即打包页
 const file=path.join(ROOT,p);
 if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
 fs.createReadStream(file).pipe(res);
});

(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 try{
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/dist/xhs-tool/index.html');
  await page.waitForFunction(()=>typeof FilmifyNativeFilm!=='undefined'&&typeof FilmifyEngine!=='undefined'
   &&typeof FILMIFY_STYLES!=='undefined'&&typeof FILMIFY_GRAIN_STATS!=='undefined');
  const data=await page.evaluate(async()=>{
   /* dist presets 的 film 是瘦身版(无 grain/layers/densityMin);native 侧实测需要
      源 styles/presets.js 的富 film 参数。直接抓文本解析,不执行赋值,避免覆盖
      引擎正在用的 dist FILMIFY_STYLES(engine 已在 dist 样式对象上合并 mobile 字段)。 */
   const richText=await (await fetch('/styles/presets.js')).text();
   const rich=JSON.parse(richText.replace(/^window\.FILMIFY_STYLES=/,'').replace(/;\s*$/,''));
   const S=256,UM=8,SEEDS=[11,22,33],BINS=9,LEVELS=[40,80,120,160,200,232],MS=512;
   const LAGS=[1,2,4,8],SCALES=[2,4,8];
   function fieldStats(f,w,h){
    const n=w*h;let mu=0;for(let i=0;i<n;i++)mu+=f[i];mu/=n;
    let v=0;const sx={1:0,2:0,4:0,8:0},sy={1:0,2:0,4:0,8:0};
    for(let y=0;y<h;y++){const row=y*w;
     for(let x=0;x<w;x++){const d=f[row+x]-mu;v+=d*d;
      for(const L of LAGS){
       if(x+L<w)sx[L]+=d*(f[row+x+L]-mu);
       if(y+L<h)sy[L]+=d*(f[row+L*w+x]-mu);
      }}}
    const ax={},ay={};for(const L of LAGS){ax[L]=v>0?sx[L]/v:0;ay[L]=v>0?sy[L]/v:0;}
    // 盒式尺度能量比:积分图求 k×k 盒均值的方差,归一化到白噪声期望=1(白噪声 e=1/k²)。
    const ii=new Float64Array((w+1)*(h+1));
    for(let y=0;y<h;y++){let rs=0;const row=y*w,ir=(y+1)*(w+1),ir0=y*(w+1);
     for(let x=0;x<w;x++){rs+=f[row+x]-mu;ii[ir+x+1]=ii[ir0+x+1]+rs;}}
    const r={};const vn=v/n;
    for(const k of SCALES){let s=0,cnt=0;
     for(let y=0;y+k<=h;y+=2)for(let x=0;x+k<=w;x+=2){
      const sum=ii[(y+k)*(w+1)+x+k]-ii[y*(w+1)+x+k]-ii[(y+k)*(w+1)+x]+ii[y*(w+1)+x];
      const m=sum/(k*k);s+=m*m;cnt++;}
     r[k]=(vn>0&&cnt>0)?(s/cnt)/vn*k*k:0;}
    return {v:vn,ax:ax,ay:ay,r:r};
   }
   function avgStats(list){
    const o={v:0,ax:{},ay:{},r:{}};const m=list.length;
    for(const L of LAGS){o.ax[L]=0;o.ay[L]=0;}for(const k of SCALES)o.r[k]=0;
    for(const s of list){o.v+=s.v/m;for(const L of LAGS){o.ax[L]+=s.ax[L]/m;o.ay[L]+=s.ay[L]/m;}for(const k of SCALES)o.r[k]+=s.r[k]/m;}
    return o;
   }
   /* 共享印相表重构(2026-09-22)后,印相胶卷 develop 必须带 paper;与
      grain-perchannel-check 同款映射。直扫 velvia 等四款已入共享直扫表
      (2026-09-22 下午),trix 仍逐款表 null;探针克隆款须同步登记进
      FILMIFY_SCANS 注册表(样式名单+W 映射),否则引擎找不到它的直扫路线。 */
   const STYLE_PAPER={portrait:'kodak_portra_endura',gold:'kodak_portra_endura',ektar:'kodak_portra_endura',
    ultramax:'kodak_portra_endura',pro400h:'kodak_portra_endura',superia:'fujifilm_crystal_archive_typeii',
    vision250d:'kodak_2383',v3500t:'kodak_2383',doublex:'kodak_2302',
   portra160:'kodak_portra_endura',portra800:'kodak_portra_endura',c200:'fujifilm_crystal_archive_typeii',
   vision50d:'kodak_2383',vision200t:'kodak_2383',verita200d:'kodak_2383'};
   async function renderPixels(style,grain,seed){
    /* filmFormatMm 按 8µm/px 反推:默认 35mm 在 512px 探针上是 68µm/px,颗粒密度域
       幅度被 grainUmScale=8/68 压到亚 LSB,量化噪声会把相关系数洗低(首跑实测教训)。
       固定 um/px=um_ref=8,与 native 侧测量同物理尺度,相关结构对幅度不变、可比。 */
    const out=await FilmifyEngine.develop(style,null,{autoExposure:false,optics:false,scannerUSM:false,
     grain:grain,seed:seed,filmFormatMm:UM*MS/1000,paper:STYLE_PAPER[style.replace(/^acfprobe-/,'')]||null,masterPNG:true});
    const bmp=await createImageBitmap(out.blob);
    const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;
    const x=c.getContext('2d');x.drawImage(bmp,0,0);bmp.close();
    const px=x.getImageData(0,0,c.width,c.height).data;c.width=c.height=1;
    return px;
   }
   const keys=Object.keys(FILMIFY_GRAIN_STATS).filter(k=>FILMIFY_GRAIN_STATS[k]&&FILMIFY_STYLES[k]&&FILMIFY_STYLES[k].mobile
    &&rich[k]&&rich[k].film&&rich[k].film.grain&&rich[k].film.grain.active);
   const view=document.createElement('canvas');document.body.appendChild(view);
   FilmifyEngine.init(view,'/dist/xhs-tool/');
   const result={umRef:UM,seeds:SEEDS,bins:BINS,levels:LEVELS,mobileSize:MS,stocks:{},skipped:[],determinism:null};
   let determinismDone=false;
   for(const key of keys){
    const fp=rich[key].film,ch=fp.channels;
    // ── native 侧:密度域 grainPlane 平场 ──
    const bins=[];
    for(let b=0;b<BINS;b++){const t=(b+.5)/BINS;
     const per=Array.from({length:ch},()=>[]);
     for(const seed of SEEDS)for(let c=0;c<ch;c++){
      const p=new Float32Array(S*S);p.fill(fp.densityMin[c]+t*(fp.densityMax[c]-fp.densityMin[c]));
      FilmifyNativeFilm.grainPlane(p,S,S,UM,fp,c,[new Float32Array(S*S),new Float32Array(S*S),new Float32Array(S*S)],seed,null);
      per[c].push(fieldStats(p,S,S));
     }
     bins.push({t:t,ch:per.map(avgStats)});
    }
    // ── mobile 侧:去 glare 探针配方渲染灰平场,grain on−off 差场 ──
    const st=JSON.parse(JSON.stringify(FILMIFY_STYLES[key]));delete st.glare;
    const pk='acfprobe-'+key;FILMIFY_STYLES[pk]=st;FILMIFY_GRAIN_STATS[pk]=FILMIFY_GRAIN_STATS[key];
    /* 共享直扫款(velvia/provia/ektachrome/kodachrome)的探针克隆登记进注册表:
       名单加 pk,W 映射同款复制(基准 velvia 无 W=恒等,不复制) */
    const sr=window.FILMIFY_SCANS&&window.FILMIFY_SCANS.direct_scan;
    if(sr&&sr.styles&&sr.styles.indexOf(key)>=0){
     sr.styles.push(pk);
     if(sr.W&&sr.W[key])sr.W[pk]=sr.W[key];
    }
    const levels=[];
    for(const g of LEVELS){
     const src=document.createElement('canvas');src.width=MS;src.height=MS;
     const sx=src.getContext('2d');sx.fillStyle='rgb('+g+','+g+','+g+')';sx.fillRect(0,0,MS,MS);
     FilmifyEngine.setImage(src);
     const off=await renderPixels(pk,false,SEEDS[0]);
     if(!determinismDone){
      const a=await renderPixels(pk,true,SEEDS[0]),b=await renderPixels(pk,true,SEEDS[0]);
      let same=a.length===b.length;for(let i=0;same&&i<a.length;i++)if(a[i]!==b[i])same=false;
      result.determinism={stock:key,gray:g,same:same};determinismDone=true;
     }
     const per=Array.from({length:ch},()=>[]);
     for(const seed of SEEDS){
      const on=await renderPixels(pk,true,seed);
      for(let c=0;c<ch;c++){const d=new Float32Array(MS*MS);
       for(let i=0;i<MS*MS;i++)d[i]=on[i*4+c]-off[i*4+c];
       per[c].push(fieldStats(d,MS,MS));}
     }
     levels.push({gray:g,ch:per.map(avgStats)});
    }
    result.stocks[key]={channels:ch,bins:bins,levels:levels};
   }
   return result;
  });
  if(errors.length)throw new Error('页面错误: '+errors[0]);

  /* ── 档位匹配 + 误差汇总(node 侧) ── */
  const LAGS=[1,2,4,8];
  const summary={stocks:{},overall:{}};
  let cellsAll=0,lag1Ok=0,sumAbsLag1=0,sumTail=0,sumScale8=0;
  const table=[];
  for(const key of Object.keys(data.stocks)){
   const stock=data.stocks[key],ch=stock.channels;
   const perCh=[];
   for(let c=0;c<ch;c++){
    const cells=[];
    for(const lv of stock.levels){
     const m=lv.ch[c];
     if(m.v<0.64){cells.push({gray:lv.gray,lowSignal:true});continue;} // 差场 std<0.8 LSB,量化噪声主导
     let best=null,bestD=1e9;
     for(const b of stock.bins){const d=Math.abs(m.ax[1]-b.ch[c].ax[1]);if(d<bestD){bestD=d;best=b;}}
     const n=best.ch[c];
     cells.push({gray:lv.gray,t:best.t,
      dLag1x:m.ax[1]-n.ax[1],dLag2x:m.ax[2]-n.ax[2],dLag4x:m.ax[4]-n.ax[4],dLag8x:m.ax[8]-n.ax[8],
      dLag1y:m.ay[1]-n.ay[1],dLag2y:m.ay[2]-n.ay[2],dLag4y:m.ay[4]-n.ay[4],
      dR4:m.r[4]-n.r[4],dR8:m.r[8]-n.r[8]});
    }
    perCh.push(cells);
   }
   // 每款汇总:native/mobile 均值尾巴 + 误差
   const valid=perCh.flat().filter(x=>!x.lowSignal);
   const nb=stock.bins.map(b=>b.ch).flat(),ml=stock.levels.map(l=>l.ch).flat();
   const mean=(arr,f)=>arr.reduce((s,x)=>s+f(x),0)/arr.length;
   const rec={
    channels:ch,cellsValid:valid.length,cellsTotal:perCh.flat().length,
    nativeMean:{lag1x:mean(nb,x=>x.ax[1]),lag2x:mean(nb,x=>x.ax[2]),lag4x:mean(nb,x=>x.ax[4]),
     lag1y:mean(nb,x=>x.ay[1]),lag2y:mean(nb,x=>x.ay[2]),r4:mean(nb,x=>x.r[4]),r8:mean(nb,x=>x.r[8])},
    mobileMean:{lag1x:mean(ml,x=>x.ax[1]),lag2x:mean(ml,x=>x.ax[2]),lag4x:mean(ml,x=>x.ax[4]),
     lag1y:mean(ml,x=>x.ay[1]),lag2y:mean(ml,x=>x.ay[2]),r4:mean(ml,x=>x.r[4]),r8:mean(ml,x=>x.r[8])},
    E_lag1:mean(valid,x=>Math.abs(x.dLag1x)),
    E_tail:mean(valid,x=>(Math.abs(x.dLag2x)+Math.abs(x.dLag2y)+Math.abs(x.dLag4x)+Math.abs(x.dLag4y))/4),
    E_scale8:mean(valid,x=>Math.abs(x.dR8)),
    cells:perCh
   };
   summary.stocks[key]=rec;
   for(const cell of valid){
    cellsAll++;if(Math.abs(cell.dLag1x)<=TOL_LAG1_CELL)lag1Ok++;
    sumAbsLag1+=Math.abs(cell.dLag1x);
    sumTail+=(Math.abs(cell.dLag2x)+Math.abs(cell.dLag2y)+Math.abs(cell.dLag4x)+Math.abs(cell.dLag4y))/4;
    sumScale8+=Math.abs(cell.dR8);
   }
   table.push({stock:key,ch:ch,
    nLag1:rec.nativeMean.lag1x,nLag2:rec.nativeMean.lag2x,nLag4:rec.nativeMean.lag4x,
    mLag1:rec.mobileMean.lag1x,mLag2:rec.mobileMean.lag2x,mLag4:rec.mobileMean.lag4x,
    nR8:rec.nativeMean.r8,mR8:rec.mobileMean.r8,
    E_tail:rec.E_tail,E_scale8:rec.E_scale8});
  }
  summary.overall={cells:cellsAll,lag1OkFrac:cellsAll?lag1Ok/cellsAll:0,
   E_lag1:cellsAll?sumAbsLag1/cellsAll:0,E_tail:cellsAll?sumTail/cellsAll:0,E_scale8:cellsAll?sumScale8/cellsAll:0};

  /* ── 报告 ── */
  console.log('stock            ch | native lag1/lag2/lag4 x | mobile lag1/lag2/lag4 x | nativeR8 mobileR8 | E_tail  E_scale8');
  for(const r of table){
   console.log((r.stock+'                ').slice(0,16)+(' '+r.ch+' | ')
    +r.nLag1.toFixed(3)+'/'+r.nLag2.toFixed(3)+'/'+r.nLag4.toFixed(3)+'        | '
    +r.mLag1.toFixed(3)+'/'+r.mLag2.toFixed(3)+'/'+r.mLag4.toFixed(3)+'        | '
    +r.nR8.toFixed(2)+'   '+r.mR8.toFixed(2)+'     | '+r.E_tail.toFixed(4)+'  '+r.E_scale8.toFixed(3));
  }
  console.log('\nOVERALL cells='+summary.overall.cells
   +' lag1OkFrac='+summary.overall.lag1OkFrac.toFixed(3)
   +' E_lag1='+summary.overall.E_lag1.toFixed(4)
   +' E_tail='+summary.overall.E_tail.toFixed(4)
   +' E_scale8='+summary.overall.E_scale8.toFixed(3));
  // native 尾巴实测(提案②③ go/no-go):lag2/lag4 是否实质非零、scale8 能量是否超白噪声
  const tn=table.reduce((s,r)=>s+r.nLag2,0)/table.length,tn4=table.reduce((s,r)=>s+r.nLag4,0)/table.length,
   tr8=table.reduce((s,r)=>s+r.nR8,0)/table.length;
  console.log('NATIVE TAIL mean lag2x='+tn.toFixed(4)+' lag4x='+tn4.toFixed(4)+' scale8ratio='+tr8.toFixed(2)+' (白噪声=1.00)');
  console.log('determinism:',JSON.stringify(data.determinism));

  fs.mkdirSync(OUTDIR,{recursive:true});
  const report={generatedAt:new Date().toISOString(),constants:{TOL_LAG1_CELL,FRAC_LAG1_OK,TOL_E_LAG1,REGRESS_FACTOR,REGRESS_ABS,REGRESS_ABS_SCALE},
   meta:{umRef:data.umRef,seeds:data.seeds,levels:data.levels,mobileSize:data.mobileSize},determinism:data.determinism,raw:data.stocks,summary:summary};
  fs.writeFileSync(path.join(OUTDIR,'latest.json'),JSON.stringify(report,null,1));

  /* ── 断言 ── */
  const fails=[];
  if(!data.determinism||!data.determinism.same)fails.push('确定性:同 build 同 seed 两次渲染不一致');
  if(summary.overall.cells===0)fails.push('有效 cell 为 0');
  if(summary.overall.lag1OkFrac<FRAC_LAG1_OK)fails.push('lag1 标定跑偏:|Δlag1_x|≤'+TOL_LAG1_CELL+' 的比例 '+summary.overall.lag1OkFrac.toFixed(3)+' < '+FRAC_LAG1_OK);
  if(summary.overall.E_lag1>TOL_E_LAG1)fails.push('lag1 平均误差 '+summary.overall.E_lag1.toFixed(4)+' > '+TOL_E_LAG1);
  const basePath=path.join(OUTDIR,'baseline.json');
  if(RECORD){
   fs.writeFileSync(basePath,JSON.stringify(report,null,1));
   console.log('\nbaseline 已记录 → '+basePath);
  }else if(fs.existsSync(basePath)){
   const base=JSON.parse(fs.readFileSync(basePath,'utf8'));
   const bT=base.summary.overall.E_tail,bS=base.summary.overall.E_scale8;
   console.log('\nbaseline 对比:E_tail '+bT.toFixed(4)+' → '+summary.overall.E_tail.toFixed(4)
    +'('+(bT>0?((summary.overall.E_tail/bT-1)*100).toFixed(1):'0')+'%), E_scale8 '+bS.toFixed(3)+' → '+summary.overall.E_scale8.toFixed(3));
   if(summary.overall.E_tail>bT*REGRESS_FACTOR+REGRESS_ABS)fails.push('E_tail 劣化于基线:'+summary.overall.E_tail.toFixed(4)+' > '+bT.toFixed(4)+'×'+REGRESS_FACTOR+'+'+REGRESS_ABS);
   if(summary.overall.E_scale8>bS*REGRESS_FACTOR+REGRESS_ABS_SCALE)fails.push('E_scale8 劣化于基线:'+summary.overall.E_scale8.toFixed(3)+' > '+bS.toFixed(3)+'×'+REGRESS_FACTOR+'+'+REGRESS_ABS_SCALE);
   if(summary.overall.E_tail<bT*0.9)console.log('改善:E_tail 较基线缩小 '+((1-summary.overall.E_tail/bT)*100).toFixed(1)+'%');
  }else{
   console.log('\n(无 baseline.json,跳过基线对比;首跑请用 --record-baseline)');
  }
  if(fails.length){for(const f of fails)console.error('✗ '+f);process.exitCode=1;}
  else console.log('\nPASS grain-acf: 确定性一致、lag1 标定在容差内、尾巴/尺度误差不劣化');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
