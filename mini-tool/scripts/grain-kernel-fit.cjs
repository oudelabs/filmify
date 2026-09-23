/* 13-tap FIR 颗粒核拟合(2026-09-21 颗粒质感升级)。
 *
 * 背景:mobile shader 原颗粒场 = 白噪声 A 与 3×3 二项平滑 S9 的混合,只能按
 * lag1 标定;实测(validation/grain-acf/baseline.json)native grainPlane 的
 * ACF 是「lag1≈0.55 高、lag2≈0.05 陡降、lag4 微负」的 blur+USM 指纹,而
 * S9 混合场在同样 lag1 下 lag2≈0.09,系统性偏高——颗粒观感偏「涂抹」而非
 * 「粒状」。本求解器逐档拟合一个小 FIR 核直接复刻 native ACF 形状:
 *
 *   核支撑(13 tap,对称): α 中心;β 轴向 ±1;γ 对角 ±1;δ 轴向 ±2(可为负)。
 *   n = K * A(白噪声),K 归一化到 Var(n)=1。
 *
 * 解析 ACF(白噪声 var=1,对称核):
 *   V  = α² + 4β² + 4γ² + 4δ²
 *   C1 = 2αβ + 4βγ + 2βδ      (lag1, x/y 同)
 *   C2 = β² + 2γ² + 2αδ       (lag2, x/y 同)
 *   CD = 2αγ + 2β²            ((1,1) 对角)
 *   C4 = δ²                   (lag4;≥0,native 微负达不到,只求逼近)
 * 拟合目标 (C1/V, C2/V, CD/V) → (r1, r2, rd),C4/V 以半权重纳入(压 δ 幅值,
 * 贴近 native lag4≈0)。δ<0 时 C2 被压到纯平滑核达不到的低值——这正是
 * blur+USM 的微型复刻。
 *
 * 偏斜变换(可选,仅当 native 偏度实质非零):m'=(m+λ(m²−1))/√(1+2λ²),
 * 对标准正态 m 有 skew(m')=(6λ+8λ³)/(1+2λ²)^1.5,方差恒 1。skewLambda 反解 λ。
 *
 * 纯函数,无依赖;node(calibrate-grain.cjs 烘焙)与测试共用。
 */
'use strict';

function acf13(k){
 const [a,b,g,d]=k;
 return {
  v:a*a+4*b*b+4*g*g+4*d*d,
  c1:2*a*b+4*b*g+2*b*d,
  c2:b*b+2*g*g+2*a*d,
  cd:2*a*g+2*b*b,
  c4:d*d,
 };
}

/* 阻尼最小二乘(4 参数,数值 Jacobian),多起点取最优。 */
function fitKernel(r1,r2,rd,r4){
 const tgt=[r1,r2,rd,Math.max(r4||0,0)]; // lag4 目标截到 0:δ² 非负,微负不可达
 const w=[1,1,1,0.5];
 function resid(k){
  const s=acf13(k);if(!(s.v>1e-12))return [1e3,1e3,1e3,1e3];
  return [w[0]*(s.c1/s.v-tgt[0]),w[1]*(s.c2/s.v-tgt[1]),w[2]*(s.cd/s.v-tgt[2]),w[3]*(s.c4/s.v-tgt[3])];
 }
 function cost(k){const r=resid(k);return r[0]*r[0]+r[1]*r[1]+r[2]*r[2]+r[3]*r[3];}
 const starts=[[1,0.35,0.12,-0.06],[1,0.5,0.25,0.05],[1,0.2,0.05,-0.12],[0.6,0.5,0.3,-0.1]];
 let best=null,bestC=1e18;
 for(const s0 of starts){
  let k=s0.slice();
  for(let it=0;it<300;it++){
   const r=resid(k),eps=1e-6,J=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
   for(let p=0;p<4;p++){
    const kp=k.slice();kp[p]+=eps;const rp=resid(kp);
    for(let q=0;q<4;q++)J[q][p]=(rp[q]-r[q])/eps;
   }
   // 解 (JᵀJ + λI) Δ = −Jᵀr,4×4 高斯消元
   const A=[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]];
   const lam=1e-4;
   for(let i=0;i<4;i++){for(let j=0;j<4;j++){let s=0;for(let q=0;q<4;q++)s+=J[q][i]*J[q][j];A[i][j]=s+(i===j?lam:0);}
    let b=0;for(let q=0;q<4;q++)b-=J[q][i]*r[q];A[i][4]=b;}
   for(let col=0;col<4;col++){
    let piv=col;for(let row=col+1;row<4;row++)if(Math.abs(A[row][col])>Math.abs(A[piv][col]))piv=row;
    if(Math.abs(A[piv][col])<1e-12)continue;
    const tmp=A[col];A[col]=A[piv];A[piv]=tmp;
    for(let row=0;row<4;row++){if(row===col)continue;const f=A[row][col]/A[col][col];
     for(let cc=col;cc<5;cc++)A[row][cc]-=f*A[col][cc];}
   }
   const dk=[0,0,0,0];
   for(let i=0;i<4;i++)if(Math.abs(A[i][i])>1e-12)dk[i]=A[i][4]/A[i][i];
   let step=1;
   for(let halve=0;halve<20;halve++){
    const kn=k.map((v,i)=>v+step*dk[i]);
    if(cost(kn)<cost(k)){k=kn;break;}
    step*=0.5;
   }
   if(Math.max(...dk.map(Math.abs))<1e-9)break;
  }
  const c=cost(k);
  if(c<bestC){bestC=c;best=k;}
 }
 // 归一化到 Var=1
 const s=acf13(best),n=Math.sqrt(s.v);
 const kn=best.map(v=>v/n);
 const ach=acf13(kn); // v===1
 return {k:kn.map(v=>Math.round(v*1e6)/1e6),
  achieved:{lag1:ach.c1,lag2:ach.c2,diag:ach.cd,lag4:ach.c4},
  target:{lag1:tgt[0],lag2:tgt[1],diag:tgt[2],lag4:tgt[3]},
  maxErr:Math.max(Math.abs(ach.c1-tgt[0]),Math.abs(ach.c2-tgt[1]),Math.abs(ach.cd-tgt[2]))};
}

/* skew 反解:目标偏度 g1 → λ;|g1|<0.05 视为噪声,返回 0(不动场)。 */
function skewLambda(g1){
 if(!Number.isFinite(g1)||Math.abs(g1)<0.05)return 0;
 const f=l=>(6*l+8*l*l*l)/Math.pow(1+2*l*l,1.5);
 let lo=-0.6,hi=0.6;
 if(g1>0){lo=0;}else{hi=0;}
 for(let i=0;i<40;i++){const m=(lo+hi)/2;if(f(m)<g1)lo=m;else hi=m;}
 return Math.round((lo+hi)/2*1e6)/1e6;
}

/* 整款胶片:stats = calibrate-grain 输出(含 corr/corr2/diag/corr4/skew)。
   返回 {kern:[9][ch][4], skewL:[9][ch], fitErr:max}。mono(channels=1)用 ch0。 */
function fitStock(stats){
 const ch=stats.channels===1?1:3,kern=[],skewL=[];
 let fitErr=0;
 for(let i=0;i<9;i++){
  const rowK=[],rowS=[];
  for(let c=0;c<ch;c++){
   const r=fitKernel(stats.corr[i][c],stats.corr2[i][c],stats.diag[i][c],stats.corr4[i][c]);
   rowK.push(r.k);rowS.push(skewLambda(stats.skew[i][c]));
   if(r.maxErr>fitErr)fitErr=r.maxErr;
  }
  kern.push(rowK);skewL.push(rowS);
 }
 return {kern:kern,skewL:skewL,fitErr:Math.round(fitErr*1e4)/1e4};
}

if(typeof module!=='undefined'&&module.exports)module.exports={acf13,fitKernel,skewLambda,fitStock};
