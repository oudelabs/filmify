// Statistical grain calibration for the mobile proposal-A runtime.
// Runs the pinned native grainPlane (density-domain multilayer Halide +
// micro-structure + blur + multiplicative USM) on uniform density patches
// at a representative pixel size (um_ref = 8 um, ~12MP full-frame), then
// records per-stock density-level tables: visible RMS, channel covariance
// and 1px spatial correlation. These are the calibration targets the mobile
// shader grain must match (mean bias ~0, RMS +-15%, cov +-20%, corr +-20%).
// Writes styles/grain-stats.js (window.FILMIFY_GRAIN_STATS=...) + a debug
// copy in validation/grain-stats/.
// After rebuilding this 8um anchor, rerun calibrate-grain-scales.py and
// calibrate-grain-scales.cjs to restore the physical-scale calibration.
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json'};
const PORT=8124;
const server=http.createServer((req,res)=>{
 let p=decodeURIComponent(req.url.split('?')[0]);
 if(p==='/')p='/index.html';
 let file;
 if(p.startsWith('/styles/'))file=path.join(ROOT,p);
 else if(p.startsWith('/assets/'))file=path.join(ROOT,'minitool',p);
 else file=path.join(ROOT,'minitool',p);
 if(!fs.existsSync(file))file=path.join(ROOT,p);
 if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
 fs.createReadStream(file).pipe(res);
});
(async()=>{
 await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+PORT+'/validation/grain-calib-page.html');
  await page.waitForFunction(()=>typeof FilmifyNativeFilm!=='undefined'&&typeof FILMIFY_STYLES!=='undefined');
  const stats=await page.evaluate(async()=>{
   const fpKeys=Object.keys(FILMIFY_STYLES);
   const S=256,UM_REF=8,STEPS=9,seeds=[11,22,33,44]; // 4 seeds per level for stable stats
   const out={};
   for(const key of fpKeys){
    const style=FILMIFY_STYLES[key],fp=style.film;
    if(!fp.grain||!fp.grain.active){out[key]=null;continue;}
    const ch=fp.channels,N=S*S;
    const dMin=fp.densityMin,dMax=fp.densityMax;
    const rms=[],cov=[],corr=[],tlevels=[];
    const corr2=[],diag=[],corr4=[],skew=[],kurt=[];
    for(let s=0;s<STEPS;s++){
     const t=(s+.5)/STEPS;
     const plane=new Float32Array(N),work=[new Float32Array(N),new Float32Array(N),new Float32Array(N)];
     for(let c=0;c<ch;c++)for(let i=0;i<N;i++)plane[i]=dMin[c]+t*(dMax[c]-dMin[c]);
     for(let c=0;c<ch;c++){
      const p=new Float32Array(N),w=[new Float32Array(N),new Float32Array(N),new Float32Array(N)];
      p.set(plane);
      FilmifyNativeFilm.grainPlane(p,S,S,UM_REF,fp,c,w,seeds[s],null);
      // Accumulate across seeds: sum samples, sumsq, cross sums, lag-1 sums.
      for(let i=0;i<N;i++)plane[i]=p[i];
     }
     // Combine 4 seeds into one patch for stats (independent fields).
     const all=new Float32Array(ch*N*seeds.length);
     for(let k=0;k<seeds.length;k++){
      const w=[new Float32Array(N),new Float32Array(N),new Float32Array(N)];
      for(let c=0;c<ch;c++){
       const p=new Float32Array(N);
       for(let i=0;i<N;i++)p[i]=dMin[c]+t*(dMax[c]-dMin[c]);
       FilmifyNativeFilm.grainPlane(p,S,S,UM_REF,fp,c,w,seeds[k],null);
       all.set(p,c*N*seeds.length+k*N);
      }
     }
     // Stats over all samples.
     const mu=new Array(ch).fill(0);
     const M=N*seeds.length;
     for(let c=0;c<ch;c++){let s=0;for(let i=0;i<M;i++)s+=all[c*M+i];mu[c]=s/M;}
     const vr=new Array(ch).fill(0),cv=Array.from({length:ch},()=>new Array(ch).fill(0));
     for(let c=0;c<ch;c++)for(let d=c;d<ch;d++){
      let s=0;for(let i=0;i<M;i++)s+=(all[c*M+i]-mu[c])*(all[d*M+i]-mu[d]);
      if(c===d)vr[c]=s/M;
      cv[c][d]=s/M;cv[d][c]=s/M;
     }
     const sig=vr.map(v=>Math.sqrt(v));
     const co=[];for(let c=0;c<ch;c++)for(let d=c;d<ch;d++)co.push(cv[c][d]);
     // 1px spatial correlation (x->x+1) per channel, excluding the last column.
     const cor=[];for(let c=0;c<ch;c++){
      let a=0,b=0,bb=0;for(let y=0;y<S;y++)for(let x=0;x<S-1;x++){const i=y*S+x;const d0=all[c*M+i]-mu[c],d1=all[c*M+i+1]-mu[c];a+=d0*d1;b+=d0*d0;bb+=d1*d1;}
      cor.push(a/Math.sqrt(b*bb));
     }
     /* 核拟合扩展测量(2026-09-21 颗粒质感):native 场的 lag2/lag4 轴向相关、
        (1,1) 对角相关、偏度、峰度——逐 seed 场计算后平均(每场 S×S 独立)。
        这些是 13-tap FIR 核逐档拟合的目标:native ACF 呈「lag1 高、lag2 陡降、
        lag4 微负」的 blur+USM 指纹,单靠 lag1 标定的 S9 场 lag2 系统性偏高。 */
     const cor2=[],cor4=[],dg=[],sk=[],ku=[];
     for(let c=0;c<ch;c++){
      let a2=0,a4=0,ad=0,ask=0,aku=0;
      for(let k=0;k<seeds.length;k++){
       const base=c*M+k*N;
       let m=0;for(let i=0;i<N;i++)m+=all[base+i];m/=N;
       let v=0,s2=0,s4=0,sd=0,m3=0,m4=0;
       for(let y=0;y<S;y++)for(let x=0;x<S;x++){
        const i=y*S+x,d0=all[base+i]-m;v+=d0*d0;
        if(x+2<S)s2+=d0*(all[base+i+2]-m);
        if(x+4<S)s4+=d0*(all[base+i+4]-m);
        if(x+1<S&&y+1<S)sd+=d0*(all[base+i+S+1]-m);
        m3+=d0*d0*d0;m4+=d0*d0*d0*d0;
       }
       if(v>0){a2+=s2/v;a4+=s4/v;ad+=sd/v;const vn=v/N;ask+=(m3/N)/(vn*Math.sqrt(vn));aku+=(m4/N)/(vn*vn)-3;}
      }
      cor2.push(a2/seeds.length);cor4.push(a4/seeds.length);dg.push(ad/seeds.length);
      sk.push(ask/seeds.length);ku.push(aku/seeds.length);
     }
     tlevels.push(t);rms.push(sig);cov.push(co);corr.push(cor);
     corr2.push(cor2);diag.push(dg);corr4.push(cor4);skew.push(sk);kurt.push(ku);
    }
    out[key]={channels:ch,umRef:UM_REF,positive:!!fp.positive,t:tlevels,rms:rms,cov:cov,corr:corr,
     corr2:corr2,corr4:corr4,diag:diag,skew:skew,kurt:kurt};
   }
   return out;
  });
  const dir=path.join(ROOT,'validation','grain-stats');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'grain-stats-debug.json'),JSON.stringify(stats,null,1));
  /* 核拟合(2026-09-21 颗粒质感):由实测 (corr,corr2,diag,corr4) 逐档逐通道
     反解 13-tap FIR 核 + 由 skew 反解偏斜 λ,一并烘进发行表。shader 侧只需
     查表加权求和,不做任何运行时求解。 */
  const {fitStock}=require('./grain-kernel-fit.cjs');
  for(const k of Object.keys(stats)){
   const s=stats[k];if(!s)continue;
   const f=fitStock(s);
   s.kern=f.kern;s.skewL=f.skewL;
   console.log('fit',k,'maxErr',f.fitErr,'bin4 kern ch0:',f.kern[4][0].map(v=>v.toFixed(3)).join(','),'skewL ch0:',f.skewL.map(r=>r[0]).join('/'));
  }
  // Compact production module.
  const js='window.FILMIFY_GRAIN_STATS='+JSON.stringify(stats,(_k,v)=>typeof v==='number'&&!Number.isInteger(v)?Math.round(v*1e6)/1e6:v,0)+';\n';
  fs.writeFileSync(path.join(ROOT,'styles','grain-stats.js'),js);
  console.log('calibrated stocks:',Object.keys(stats).length,'bytes:',js.length,'errors:',errors.length);
  for(const k of Object.keys(stats)){const s=stats[k];if(!s)continue;
   console.log(k,'ch',s.channels,'t0',s.t[0],'rms0',s.rms[0].map(x=>x.toFixed(4)).join('/'),'corr0',s.corr[0].map(x=>x.toFixed(3)).join('/'));}
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error('FAIL',e.message);process.exitCode=1;});
