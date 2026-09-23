// LUT 采样路径回归（2026-09-21 外部 review 建议，Android 假色排查）：
// 自检 8 色多为常用色，不足以暴露手工三线性插值的索引/权重错误。
// 本脚本用 256 个确定性网格外色向量走真实渲染路径（optics/grain/USM 全关），
// 分别在「默认硬件采样」与「强制 lutNearest 手工插值」两种构建下对照纯 JS 参考，
// 并做两路径整图逐像素 A/B。容差沿用自检 5/255（8bit 量化 + ±0.5 LSB dither）。
// 用法: node validation/lut-paths-check.cjs
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json'};

/* 强制 lutNearest 的临时构建：只改一行能力判定 */
const src=fs.readFileSync(path.join(ROOT,'minitool','mobile-film.js'),'utf8');
const anchor='this.lutNearest=!this.lutFloat32&&!this.halfFloatLinear;';
if(!src.includes(anchor)){console.error('FAIL: lutNearest 判定行未找到，构建脚本需同步');process.exit(1);}
const OVERRIDE=path.join(__dirname,'.tmp-mobile-film-lutnearest.js');
fs.writeFileSync(OVERRIDE,src.replace(anchor,'this.lutNearest=true; /* lut-paths-check 强制手工插值 */'));

function serve(port,override){
 return new Promise(resolve=>{
  const server=http.createServer((req,res)=>{
   let p=decodeURIComponent(req.url.split('?')[0]);
   if(p==='/')p='/index.html';
   if(p==='/mobile-film.js'&&override){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});fs.createReadStream(override).pipe(res);return;}
   let file=p.startsWith('/styles/')?path.join(ROOT,p):path.join(ROOT,'minitool',p);
   if(!fs.existsSync(file))file=path.join(ROOT,p);
   const ok=file.startsWith(ROOT)&&fs.existsSync(file)&&!fs.statSync(file).isDirectory();
   if(!ok){res.statusCode=404;res.end();return;}
   res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
   fs.createReadStream(file).pipe(res);
  });
  server.listen(port,'127.0.0.1',()=>resolve(server));
 });
}

const PAGE_FN=async()=>{
 /* 256 个确定性网格外色向量（固定伪随机，覆盖全色域） */
 const colors=[];
 for(let i=0;i<256;i++)colors.push([(i*73+41)%256,(i*151+97)%256,(i*211+13)%256]);
 const BLOCK=32,COLS=16,W=COLS*BLOCK,H=16*BLOCK;
 function gridCanvas(){
  const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');
  colors.forEach((rgb,i)=>{
   x.fillStyle='rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
   x.fillRect((i%COLS)*BLOCK,Math.floor(i/COLS)*BLOCK,BLOCK,BLOCK);
  });
  return c;
 }
 /* 与 selfCheckCore 完全一致的纯 JS 参考求值(含 2026-09-21 逐点 DIR) */
 function jsRef(style,rgb){
  const fp=style.film,axis=fp.logExposure,N=axis.length,lo=axis[0],span=axis[N-1]-lo;
  const bw=fp.bwCorrection;
  const bwv=Array.isArray(bw)?[bw[0],bw.length>1?bw[1]:bw[0],bw.length>2?bw[2]:bw[0]]:[bw,bw,bw];
  const raw=FilmifyMobileOptics.sampleTable(style.rawValues,style.rawSize,rgb[0]/255,rgb[1]/255,rgb[2]/255);
  const interpC=(table,ch,x)=>{
   const idx=(x-lo)/span*(N-1);
   const i0=Math.max(0,Math.min(N-2,Math.floor(idx)));
   const f=Math.max(0,Math.min(1,idx-i0));
   const cv=table[Math.min(ch,fp.channels-1)];
   return cv[i0]+(cv[i0+1]-cv[i0])*f;
  };
  const logv=[0,0,0];let d=[0,0,0];
  for(let ch=0;ch<3;ch++){
   logv[ch]=Math.log(Math.max(raw[ch]*style.rawScale[ch]*bwv[ch],0)+1e-10)/Math.LN10;
   d[ch]=interpC(fp.curves,ch,logv[ch]);
  }
  if(fp.dir&&fp.dir.active&&fp.correctedCurves&&fp.matrix){
   const v3=(a)=>[a[Math.min(0,fp.channels-1)],a[Math.min(1,fp.channels-1)],a[Math.min(fp.channels-1,2)]];
   const dK=v3(fp.donorK),dR=v3(fp.donorRef),rK=v3(fp.receiverK),rR=v3(fp.receiverRef),dM=v3(fp.densityMax);
   const donor=[0,0,0];
   for(let ch=0;ch<3;ch++)donor[ch]=fp.positive?dM[ch]-d[ch]:d[ch]*(dK[ch]+dR[ch])/(dK[ch]+d[ch]);
   const arrived=[0,0,0];
   for(let ch=0;ch<3;ch++)for(let k=0;k<fp.channels;k++)arrived[ch]+=fp.matrix[k][Math.min(ch,fp.channels-1)]*donor[k];
   for(let ch=0;ch<3;ch++){
    let corr=arrived[ch];
    if(fp.positive)corr=corr*(rK[ch]+rR[ch])/(rK[ch]+corr);
    d[ch]=interpC(fp.correctedCurves,ch,logv[ch]-corr);
   }
  }
  const t=[0,0,0];
  if(style.sharedPrint){
   /* 共享印相表镜像(2026-09-22 LUT 重构,与 selfCheckCore 同式):
      W 二次预变换(无 W=恒等) → 全局域 [-0.45,3.55] 钳位 */
   const W=style.preW,w=[0,0,0];
   for(let ch=0;ch<3;ch++){
    if(!W){w[ch]=d[ch];continue;}
    const f=[1,d[0],d[1],d[2],d[0]*d[0],d[1]*d[1],d[2]*d[2],d[0]*d[1],d[0]*d[2],d[1]*d[2]];
    let acc=0;for(let j=0;j<10;j++)acc+=W[ch*10+j]*f[j];
    w[ch]=acc;
   }
   for(let ch=0;ch<3;ch++)t[ch]=Math.max(0,Math.min(1,(w[ch]+0.45)*0.25));
  }else if(style.sharedScan){
   /* 共享直扫表镜像(2026-09-22 下午,与 selfCheckCore 同式):
      W 三次预变换(3x20,无 W=恒等) → 全局域 [-0.45,3.55] 钳位 */
   const W=style.preWC,w=[0,0,0];
   const f=[1,d[0],d[1],d[2],d[0]*d[0],d[1]*d[1],d[2]*d[2],d[0]*d[1],d[0]*d[2],d[1]*d[2],
            d[0]**3,d[1]**3,d[2]**3,d[0]*d[0]*d[1],d[0]*d[0]*d[2],d[1]*d[1]*d[0],d[1]*d[1]*d[2],
            d[2]*d[2]*d[0],d[2]*d[2]*d[1],d[0]*d[1]*d[2]];
   for(let ch=0;ch<3;ch++){
    if(!W){w[ch]=d[ch];continue;}
    let acc=0;for(let j=0;j<20;j++)acc+=W[ch*20+j]*f[j];
    w[ch]=acc;
   }
   for(let ch=0;ch<3;ch++)t[ch]=Math.max(0,Math.min(1,(w[ch]+0.45)*0.25));
  }else{
   for(let ch=0;ch<3;ch++){
    let tv=(d[ch]-style.densityLow[ch])/style.densitySpan[ch];
    if(fp.positive)tv=Math.sqrt(Math.max(0,Math.min(1,tv)));
    t[ch]=tv;
   }
  }
  const want=FilmifyMobileOptics.sampleTable(style.mobileValues,style.mobileSize,t[0],t[1],t[2]);
  return [Math.round(want[0]*255),Math.round(want[1]*255),Math.round(want[2]*255)];
 }
 async function renderStyle(styleId,paper){
  const c=gridCanvas();
  FilmifyEngine.setImage(c);
  const r=await FilmifyEngine.develop(styleId,null,{filmFormatMm:35,autoExposure:false,seed:7,optics:false,grain:false,scannerUSM:false,paper:paper||null,masterPNG:true});
  const bmp=await createImageBitmap(r.blob);
  const cc=document.createElement('canvas');cc.width=bmp.width;cc.height=bmp.height;
  const xx=cc.getContext('2d');xx.drawImage(bmp,0,0);
  const sx=bmp.width/W,sy=bmp.height/H;
  const got=[];
  colors.forEach((rgb,i)=>{
   const px=xx.getImageData(Math.round(((i%COLS)+0.5)*BLOCK*sx),Math.round((Math.floor(i/COLS)+0.5)*BLOCK*sy),1,1).data;
   got.push([px[0],px[1],px[2]]);
  });
  c.width=c.height=1;cc.width=cc.height=1;bmp.close();
  return {got:got,config:{lutNearest:!!(window.FILMIFY_DIAG&&FILMIFY_DIAG.caps&&!FILMIFY_DIAG.caps.floatLinear&&!FILMIFY_DIAG.caps.halfFloatLinear)}};
 }
 /* 印相胶卷走共享印相表、直扫反转片走共享直扫表(2026-09-22 下午):合成与
    engine.recipeFor/recipeForScan 同式的 recipe 供 jsRef 参考 */
 function recipeOf(styleId,paper){
  if(!paper){
   const sr=window.FILMIFY_SCANS&&window.FILMIFY_SCANS.direct_scan;
   if(sr&&sr.styles&&sr.styles.indexOf(styleId)>=0)
    return Object.assign({},FILMIFY_STYLES[styleId],{mobileValues:sr.values,mobileSize:sr.size,preWC:(sr.W||{})[styleId]||null,sharedScan:1});
   return FILMIFY_STYLES[styleId];
  }
  const print=FILMIFY_PRINTS[paper];
  return Object.assign({},FILMIFY_STYLES[styleId],{mobileValues:print.values,mobileSize:print.size,preW:(print.W||{})[styleId]||null,sharedPrint:1});
 }
 const out={};
 for(const [styleId,paper] of [['velvia',null],['portrait','kodak_portra_endura'],['trix',null]]){
  const r=await renderStyle(styleId,paper);
  const style=recipeOf(styleId,paper);
  let maxD=0,maxAt=-1,worst=null;
  colors.forEach((rgb,i)=>{
   const want=jsRef(style,rgb);
   for(let ch=0;ch<3;ch++){
    const d=Math.abs(r.got[i][ch]-want[ch]);
    if(d>maxD){maxD=d;maxAt=i;worst={rgb:rgb,got:r.got[i],want:want};}
   }
  });
  out[styleId]={maxD:maxD,maxAt:maxAt,worst:worst};
 }
 /* 整图数据留作跨路径 A/B：重跑 velvia 整张读回 */
 const c2=gridCanvas();FilmifyEngine.setImage(c2);
 const r2=await FilmifyEngine.develop('velvia',null,{filmFormatMm:35,autoExposure:false,seed:7,optics:false,grain:false,scannerUSM:false,masterPNG:true});
 const bmp2=await createImageBitmap(r2.blob);
 const cc2=document.createElement('canvas');cc2.width=bmp2.width;cc2.height=bmp2.height;
 const xx2=cc2.getContext('2d');xx2.drawImage(bmp2,0,0);
 const all=xx2.getImageData(0,0,cc2.width,cc2.height).data;
 c2.width=c2.height=1;cc2.width=cc2.height=1;bmp2.close();
 return {styles:out,pixels:Array.from(all),w:cc2.width||W,h:H};
};

async function run(port,override){
 const server=await serve(port,override);
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'load'});
  await page.waitForFunction(()=>typeof FilmifyEngine!=='undefined'&&typeof FILMIFY_STYLES!=='undefined');
  const r=await page.evaluate(PAGE_FN);
  if(errors.length)throw new Error('pageerror: '+errors.join(';'));
  return r;
 }finally{await browser.close();server.close();}
}

(async()=>{
 const TOL=5;
 const a=await run(8961,null);
 const b=await run(8962,OVERRIDE);
 fs.unlinkSync(OVERRIDE);
 let fail=false;
 for(const s of ['velvia','portrait','trix']){
  const line='默认路径 '+s+': maxΔ='+a.styles[s].maxD+(a.styles[s].maxD>TOL?' 最差 '+JSON.stringify(a.styles[s].worst):'');
  const line2='强制lutNearest '+s+': maxΔ='+b.styles[s].maxD+(b.styles[s].maxD>TOL?' 最差 '+JSON.stringify(b.styles[s].worst):'');
  console.log(line);console.log(line2);
  if(a.styles[s].maxD>TOL||b.styles[s].maxD>TOL)fail=true;
 }
 /* 两路径整图 A/B（velvia，dither 确定性，差异只可能来自 LUT 采样路径） */
 let maxAB=0;
 for(let i=0;i<a.pixels.length;i++){const d=Math.abs(a.pixels[i]-b.pixels[i]);if(d>maxAB)maxAB=d;}
 console.log('整图 A/B（默认 vs 强制lutNearest, velvia）: maxΔ='+maxAB);
 if(maxAB>2)fail=true;
 if(fail){console.log('FAIL lut-paths');process.exit(1);}
 console.log('PASS lut-paths: 两条 LUT 采样路径均与纯 JS 参考一致(≤'+TOL+'/255)，且互相逐像素一致(≤2)');
})().catch(e=>{try{fs.unlinkSync(OVERRIDE);}catch(_){}console.error(e);process.exit(1);});
