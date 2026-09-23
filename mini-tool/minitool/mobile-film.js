'use strict';
// Mobile baked-core renderer (proposal A): full-resolution tiled colour core.
// No full-size Float32 film planes. Per tile the shader decodes sRGB -> raw
// (33^3 table) -> log -> 1D density curves -> density-uniform t -> sqrt shaper
// (positive stocks) -> scan LUT -> sRGB. Native raw metering/AE is applied
// per image before this pass; print-stage controls are out of scope for v1.
//
// Numerics mirror scripts/bake-mobile-film.py exactly: raw table trilinear
// sample, EV/bwCorrection gain, additive optics glow (2026-09-22 起线性加性),
// log10(gained+1e-10), np.interp density
// curves on the uniform logExposure axis, t=(density-low)/span, sqrt shaper for
// positive, RGB16-packed LUT trilinear, then sRGB encoding.
const FilmifyMobile = (() => {
const VERT = `#version 300 es
in vec2 position;out vec2 uv;
void main(){uv=position*.5+.5;gl_Position=vec4(position,0,1);}`;
const FRAG = `#version 300 es
precision highp float;
/* 2026-09-21 真机黑图根因(小米/Adreno 830 / Chrome 147 WebView):GLSL ES 3.00
   片元着色器 int/uint 默认精度是 mediump——grainMix/glare/dither 的 32 位
   整数 hash(0x7feb352d 等常量、x^=x>>16u)在 16 位 mediump uint 下是未定义
   行为,该驱动把整个 hash 折叠成恒 0 → gh()=0 → gauss()=sqrt(-2·log 0)=+Inf
   → glare 段 lin=+Inf → 成片全黑(glare 在所有彩色配方默认开启,alpha 不变
   所以是黑不是透明);grain 加性 NaN/Inf、dither 恒 0 同源。自检全部关
   glare/grain 所以一直绿。显式 highp int/uint 后真机逐像素 hash 恢复正常
   (探针 device-cdp9/10/11);桌面 uint 本就 32 位,此改动桌面行为不变。 */
precision highp int;
precision highp sampler3D;
in vec2 uv; out vec4 frag;
uniform sampler2D source;
uniform sampler3D rawLUT;
uniform sampler3D colorLUT;
uniform sampler2D curves;
uniform float rawSize;uniform float lutSize;uniform float curvesN;
uniform vec3 rawScale;uniform vec3 densityLow;uniform vec3 densitySpan;
uniform vec3 bwCorrection;uniform float evGain;uniform vec3 opticsTransmission;
uniform float logLow;uniform float logSpan;
uniform float positive;
uniform sampler2D opticsField;uniform vec2 opticsTileOffset;uniform vec2 opticsFieldSize;uniform vec2 outputSize;uniform float tileH;uniform int hasOptics;
// Full-resolution local scatter (2026-09-21): raw pass + separable combined-
// kernel blur of the PADDED tile, done as small pre-passes per tile
// (scatRaw = raw of padded tile, scatBlur = K * scatRaw). srcCrop is the
// offset of this tile's output region inside the padded source texture; it is
// (0,0) for unpadded tiles. Neighbour physics comes from the padding, so no
// full-size float plane is ever allocated. The scanner reads the complete
// padded colour result, including optics, grain and glare.
uniform int hasScatter;uniform vec3 scatCenter;uniform sampler2D scatRaw;uniform sampler2D scatBlur;uniform ivec2 srcCrop;
// DIR couplers: donor=非修正密度经 donor() 变换; spatial diffusion runs
// between the arrival matrix and receiver, with the pointwise path as fallback.
// arrived[ch]=Σ_k matrix[k][ch]·donor[k],负片直用、正片过 receiver 变换,
// 最终密度 = correctedCurves(logv - correction)。dirMk = matrix 第 k 行
// (donor 通道 k → 三个 receiver 通道),B&W 按 ci 复制、k>=channels 置零。
uniform int hasSpatialDir;uniform sampler2D dirCoreTex;uniform sampler2D dirTailTex;uniform float dirTailWeight;uniform float dirFieldScale;uniform ivec2 dirFieldSize;
uniform int dirActive;uniform vec3 dirM0;uniform vec3 dirM1;uniform vec3 dirM2;
uniform vec3 dirDonorK;uniform vec3 dirDonorRef;
uniform vec3 dirReceiverK;uniform vec3 dirReceiverRef;uniform vec3 dirDensityMax;
/* 共享密度域印相表（2026-09-22 LUT 重构,docs/shared-lut-design.md）:
   sharedPrint=1 时 colorLUT 是印相载体的全局域 [-0.45,3.55] 裸 printscan 表,
   坐标 = W(d_post) 经 3x10 二次预变换(逐特征 vec3 系数,preWj=(Rj,Gj,Bj))。
   旧逐组合表把 DIR 烘进表内、坐标为 pre-DIR 密度,与本 shader 的逐点 DIR
   叠加成双重 DIR(饱和色 max>100/255,validation/shared-lut/double-dir-probe.py);
   新链路上 DIR 只在 shader 应用一次。sharedPrint=0=反转片直扫旧路径
   (逐款表 + per-film densityLow/Span + sqrt shaper)。 */
uniform int sharedPrint;
uniform vec3 preW0;uniform vec3 preW1;uniform vec3 preW2;uniform vec3 preW3;uniform vec3 preW4;
uniform vec3 preW5;uniform vec3 preW6;uniform vec3 preW7;uniform vec3 preW8;uniform vec3 preW9;
/* 共享直扫表(2026-09-22 下午):sharedScan=1 时 colorLUT 是基准反转片(Velvia)
   全局域 [-0.45,3.55] 裸 scan 表,坐标 = 3x20 三次预变换 W(d_post)(逐特征 vec3
   系数)。与 sharedPrint 同 semantics——DIR 只在 shader 应用一次;现状逐款直扫表
   同样把 DIR 烘进表内(ab-scan 实测对上游 p99 33-43),本分支即根治。
   sharedScan=0 且 sharedPrint=0=trix 逐款表旧路径(per-film low/span+sqrt)。 */
uniform int sharedScan;
uniform vec3 preWC0;uniform vec3 preWC1;uniform vec3 preWC2;uniform vec3 preWC3;uniform vec3 preWC4;
uniform vec3 preWC5;uniform vec3 preWC6;uniform vec3 preWC7;uniform vec3 preWC8;uniform vec3 preWC9;
uniform vec3 preWC10;uniform vec3 preWC11;uniform vec3 preWC12;uniform vec3 preWC13;uniform vec3 preWC14;
uniform vec3 preWC15;uniform vec3 preWC16;uniform vec3 preWC17;uniform vec3 preWC18;uniform vec3 preWC19;
// Calibrated statistical grain: density-domain RMS/covariance baked offline
// from the pinned native grainPlane at um_ref=8um, spatial structure fitted
// per density bin to a 13-tap FIR kernel (2026-09-21 质感升级). Native's ACF
// is "high lag1, sharply dropping lag2, slightly negative lag4" — the
// blur+USM fingerprint of its grain finalization; the former white+S9 mix
// could match lag1 only and overshot lag2 ~2x (soft smeared look). The
// kernel's negative +-2 ring (delta<0) reproduces the suppressed tail.
// Per-channel optional skew lambda replicates the measured amplitude
// asymmetry (shadow bins of fast stocks). All parameters baked per bin per
// channel by scripts/calibrate-grain.cjs + grain-kernel-fit.cjs.
uniform int hasGrain;uniform float grainUmScale;uniform float grainSeed;uniform int grainMono;
// USM intermediate contains the complete linear scan RGB, before encoding.
// RGBA8 fallback stores encoded RGB to preserve shadow precision.
uniform int usmMode;uniform int scanPacked;
uniform vec3 grainLow;uniform vec3 grainSpan;uniform vec2 grainAxis;
// Print-route glare: single-sample lognormal matched to the post-blur
// statistics of the upstream iid field (variance factor of the same FIR
// kernel used by the native gaussian); added in linear scan RGB before USM.
uniform float glareAmount;uniform vec2 glareLognorm;uniform float glareSeed;
// Grain calibration tables live in a 9x6 RGBA32F texture read with texelFetch:
// dynamically-indexed uniform arrays (the former grainL[54]/grainW[27]) read
// back garbage on some Android GPUs — 2026-09-21 velvia fluorescent false
// colour on a real device, desktop unaffected. texelFetch on float textures
// is core WebGL2 (no filtering extension needed) and matches the curves table.
// Rows: 0=(L0..L3) 1=(L4,L5) Cholesky amplitude; 2/3/4 = per-channel 13-tap
// kernel (alpha,beta,gamma,delta); 5=(skew lambda per channel).
uniform sampler2D grainTab;
// 1 when the GPU lacks float/half-float LINEAR filtering: LUTs switch to
// NEAREST and sampleTable does manual trilinear via texelFetch (core WebGL2).
uniform float lutNearest;
// 1 when the GPU lacks half-float LINEAR (OES_texture_half_float_linear):
// the RGBA16F optics field switches to NEAREST + manual bilinear. Kept
// separate from lutNearest — float32 LUT filtering (OES_texture_float_linear)
// says nothing about half-float filtering, and a LINEAR-param RGBA16F texture
// without the extension is incomplete (strict drivers sample it as black).
uniform float fieldNearest;
// Wellons lowbias32 integer hash: uniform and aperiodic on the pixel lattice
// (verified spectrally clean against a white-noise baseline). The former
// sin/fract hash produced a visible regular weave on flat areas, and a PCG2D
// variant still showed a spectral spike at this lattice size.
/* uint 不能出现在默认精度声明里(ES 3.00 语法不允许),逐声明显式 highp:
   上面 precision highp int 管 ivec2 坐标与 int 形参,这里管 hash 链本身。 */
highp uint grainMix(highp uint x){x^=x>>16u;x*=0x7feb352du;x^=x>>15u;x*=0x846ca68bu;x^=x>>16u;return x;}
float gh(ivec2 p,int k){
 highp uint hx=uint(p.x),hy=uint(p.y),hk=uint(k);
 highp uint h=grainMix(hx+grainMix(hy+hk*0x9E3779B9u));
 return (float(h>>8u)+.5)/16777216.;
}
float gauss(ivec2 p,int k){float a=gh(p,k),b=gh(p,k+1);return sqrt(-2.*log(a))*cos(6.28318530718*b);}
vec3 grainNoise(ivec2 p){return vec3(gauss(p,0),gauss(p,2),gauss(p,4));}
vec3 sampleTable(sampler3D lut,float size,vec3 coord){
 coord=clamp(coord,0.,1.);
 if(lutNearest<.5)return texture(lut,(coord*(size-1.)+.5)/size).rgb;
 // Manual trilinear fallback: hardware LINEAR on float textures is unavailable
 // (missing OES_texture_float_linear AND OES_texture_half_float_linear), which
 // would otherwise make the texture incomplete and sample as black — leaving
 // the un-removed negative mask as a uniform red/orange output.
 vec3 p=coord*(size-1.);vec3 i0=floor(p);vec3 f=p-i0;
 ivec3 a=ivec3(i0);ivec3 b=min(a+1,int(size)-1);
 vec3 c000=texelFetch(lut,ivec3(a.x,a.y,a.z),0).rgb;
 vec3 c100=texelFetch(lut,ivec3(b.x,a.y,a.z),0).rgb;
 vec3 c010=texelFetch(lut,ivec3(a.x,b.y,a.z),0).rgb;
 vec3 c110=texelFetch(lut,ivec3(b.x,b.y,a.z),0).rgb;
 vec3 c001=texelFetch(lut,ivec3(a.x,a.y,b.z),0).rgb;
 vec3 c101=texelFetch(lut,ivec3(b.x,a.y,b.z),0).rgb;
 vec3 c011=texelFetch(lut,ivec3(a.x,b.y,b.z),0).rgb;
 vec3 c111=texelFetch(lut,ivec3(b.x,b.y,b.z),0).rgb;
 return mix(mix(mix(c000,c100,f.x),mix(c010,c110,f.x),f.y),mix(mix(c001,c101,f.x),mix(c011,c111,f.x),f.y),f.z);
}
// row0 = 显影曲线(donor 端),row1 = correctedCurves(DIR receiver 端);
// 数学相同,仅曲线表不同。
vec3 densityCurveRow(vec3 logv,int row){
 // Uniform logExposure axis shared by all channels; per-channel linear
 // interpolation matches np.interp used by the bake validation path.
 vec3 idx=(logv-logLow)/logSpan*(curvesN-1.);
 vec3 i0=clamp(floor(idx),0.,curvesN-2.);
 vec3 f=clamp(idx-i0,0.,1.);
 vec3 d0=vec3(texelFetch(curves,ivec2(int(i0.x),row),0).r,
              texelFetch(curves,ivec2(int(i0.y),row),0).g,
              texelFetch(curves,ivec2(int(i0.z),row),0).b);
 vec3 d1=vec3(texelFetch(curves,ivec2(int(i0.x)+1,row),0).r,
              texelFetch(curves,ivec2(int(i0.y)+1,row),0).g,
              texelFetch(curves,ivec2(int(i0.z)+1,row),0).b);
 return mix(d0,d1,f);
}
vec3 densityCurve(vec3 logv){
 return densityCurveRow(logv,0);
}
void main(){
 // The raw table stores encoded-sRGB input coordinates (grid 0..1 encoded);
 // the scan table stores encoded scanner sRGB, so both are consumed and
 // written without CCTF conversion in this core.
 vec3 raw;
 if(hasScatter==1){
  // 散射后 raw = (1-s*tw)*中心 raw(core 项已折进中心) + 逐项精确累加的模糊。
  ivec2 cp=ivec2(gl_FragCoord.xy)+srcCrop;
  raw=scatCenter*texelFetch(scatRaw,cp,0).rgb+texelFetch(scatBlur,cp,0).rgb;
 }else{
  vec3 srgb=texelFetch(source,ivec2(gl_FragCoord.xy)+srcCrop,0).rgb;
  raw=sampleTable(rawLUT,rawSize,srgb)*rawScale;
 }
 vec3 gained=raw*opticsTransmission*evGain*bwCorrection;
 // gl_FragCoord.y=0 is the framebuffer bottom; the tile's output top maps to
 // gl_FragCoord.y=tileH-1, so flip y to get the output pixel coord (used by
 // both the optics field lookup and the deterministic grain hash).
 vec2 globalPx=vec2(gl_FragCoord.x+opticsTileOffset.x,tileH-1.0-gl_FragCoord.y+opticsTileOffset.y);
 if(hasOptics==1){
  /* 光学场=线性加性辉光(2026-09-22 起,原为 log10 增量——暗像素上爆炸成
     橙色火星)。曝光增益对辉光同样缩放(线性模糊与增益可交换),在取 log
     之前加回,与 native 线性域 halation 语义一致。 */
  vec2 ouv=globalPx/outputSize;
  vec3 glow;
  if(fieldNearest<.5){glow=texture(opticsField,ouv).rgb;}
  else{
   // Manual bilinear fallback (same missing-filtering situation as sampleTable).
   vec2 op=ouv*(opticsFieldSize-1.);vec2 oi=floor(op);vec2 of=op-oi;
   ivec2 oa=ivec2(oi);ivec2 ob=min(oa+1,ivec2(opticsFieldSize)-1);
   vec3 o00=texelFetch(opticsField,oa,0).rgb;
   vec3 o10=texelFetch(opticsField,ivec2(ob.x,oa.y),0).rgb;
   vec3 o01=texelFetch(opticsField,ivec2(oa.x,ob.y),0).rgb;
   vec3 o11=texelFetch(opticsField,ob,0).rgb;
   glow=mix(mix(o00,o10,of.x),mix(o01,o11,of.x),of.y);
  }
  gained+=glow*evGain*bwCorrection;
 }
 vec3 logv=log(max(gained,0.)+1e-10)/log(10.);
 vec3 d=densityCurve(logv);
 if(dirActive==1){
  // DIR: donor uses uncorrected density; receiver uses corrected curves.
  vec3 donor=positive>.5?dirDensityMax-d:d*(dirDonorK+dirDonorRef)/(dirDonorK+d);
  vec3 arrived=donor.x*dirM0+donor.y*dirM1+donor.z*dirM2;
  if(usmMode==3){frag=vec4(arrived,1.);return;}
  if(hasSpatialDir==1){
   vec3 core=texelFetch(dirCoreTex,ivec2(gl_FragCoord.xy)+srcCrop,0).rgb;
   // Field row zero is image top; average concentration BEFORE downsampling.
   // Legacy optics uses y-.5; DIR bins are true image pixel centres (y+.5).
   vec2 q=(globalPx+vec2(0.,1.))/dirFieldScale-.5;ivec2 a=ivec2(floor(q));vec2 f=fract(q);
   ivec2 lo=ivec2(0),hi=dirFieldSize-1;
   vec3 t00=texelFetch(dirTailTex,clamp(a,lo,hi),0).rgb;
   vec3 t10=texelFetch(dirTailTex,clamp(a+ivec2(1,0),lo,hi),0).rgb;
   vec3 t01=texelFetch(dirTailTex,clamp(a+ivec2(0,1),lo,hi),0).rgb;
   vec3 t11=texelFetch(dirTailTex,clamp(a+1,lo,hi),0).rgb;
   arrived=(1.-dirTailWeight)*core+dirTailWeight*mix(mix(t00,t10,f.x),mix(t01,t11,f.x),f.y);
  }
  vec3 corr=arrived;
  if(positive>.5)corr=arrived*(dirReceiverK+dirReceiverRef)/(dirReceiverK+arrived);
  d=densityCurveRow(logv-corr,1);
 }
 if(hasGrain==1){
  /* Per-channel density-level bin selection (2026-09-21 色彩状态落地):每通道按自身
     密度 t 选自己的标定档,替代原三通道平均 tt 共享一档。原平均档在饱和色区系统性
     错配颗粒幅度(native 颗粒 std 随密度递减,平均把它拉平:主通道高估 +10..62%、
     两个低密通道低估 -13..-24%,最差 v3500t 蓝 84%);逐通道档对 native 边际误差
     ~0.4%(validation/grain-colorstate/report.json)。表数据与 Cholesky 混合不变,
     只是每通道的行分量从各自的 bin 取;texelFetch 6→14 次,9×3 纹理全在缓存,可忽略。 */
  vec3 t0=(d-grainLow)/grainSpan;
  vec3 fi=clamp((t0-grainAxis.x)/grainAxis.y,0.,8.);
  ivec3 i0=clamp(ivec3(floor(fi)),ivec3(0),ivec3(7));
  vec3 ff=clamp(fi-vec3(i0),0.,1.);
  vec3 gd;
  // Table fetch: column i0_c (clamped 0..7, so +1 is always valid). Rows:
  // 0=(L0..L3), 1=(L4,L5,_,_) amplitude; 2/3/4 = per-channel kernel
  // (alpha,beta,gamma,delta); 5=(skew lambda R,G,B). Each channel's row
  // components come from its own bin column pair, mixed with that channel's ff.
  vec4 r0R=mix(texelFetch(grainTab,ivec2(i0.x,0),0),texelFetch(grainTab,ivec2(i0.x+1,0),0),ff.x);
  vec4 r0G=mix(texelFetch(grainTab,ivec2(i0.y,0),0),texelFetch(grainTab,ivec2(i0.y+1,0),0),ff.y);
  vec4 r0B=mix(texelFetch(grainTab,ivec2(i0.z,0),0),texelFetch(grainTab,ivec2(i0.z+1,0),0),ff.z);
  vec4 r1R=mix(texelFetch(grainTab,ivec2(i0.x,1),0),texelFetch(grainTab,ivec2(i0.x+1,1),0),ff.x);
  vec4 r1G=mix(texelFetch(grainTab,ivec2(i0.y,1),0),texelFetch(grainTab,ivec2(i0.y+1,1),0),ff.y);
  vec4 r1B=mix(texelFetch(grainTab,ivec2(i0.z,1),0),texelFetch(grainTab,ivec2(i0.z+1,1),0),ff.z);
  /* 13-tap FIR 核场(2026-09-21 质感升级):n = K*A,K=(α 中心,β 轴向±1,
     γ 对角±1,δ 轴向±2),逐档逐通道拟合 native 实测 (lag1,lag2,diag(1,1)),
     方差恒 1。δ 可为负——复刻 native blur+USM 收尾的 ACF 指纹(lag1 高、
     lag2 陡降、lag4 微负);原白噪声+S9 混合只能标定 lag1,lag2 系统性
     偏高 ~2×,观感偏涂抹。对角项 γ 保证 (1,1) 相关非零(纯十字核会给
     对角零相关,与 native 各向同性不符)。noise 场跨通道仍独立(k 偏移),
     跨通道耦合照旧由 Cholesky 提供。 */
  vec4 kR=mix(texelFetch(grainTab,ivec2(i0.x,2),0),texelFetch(grainTab,ivec2(i0.x+1,2),0),ff.x);
  vec4 kG=mix(texelFetch(grainTab,ivec2(i0.y,3),0),texelFetch(grainTab,ivec2(i0.y+1,3),0),ff.y);
  vec4 kB=mix(texelFetch(grainTab,ivec2(i0.z,4),0),texelFetch(grainTab,ivec2(i0.z+1,4),0),ff.z);
  vec3 lam=vec3(
   mix(texelFetch(grainTab,ivec2(i0.x,5),0).r,texelFetch(grainTab,ivec2(i0.x+1,5),0).r,ff.x),
   mix(texelFetch(grainTab,ivec2(i0.y,5),0).g,texelFetch(grainTab,ivec2(i0.y+1,5),0).g,ff.y),
   mix(texelFetch(grainTab,ivec2(i0.z,5),0).b,texelFetch(grainTab,ivec2(i0.z+1,5),0).b,ff.z));
  ivec2 pc=ivec2(globalPx)+int(grainSeed)*ivec2(37,54);
  if(grainMono==1){
   vec4 kk=kR; // mono: channel-0 kernel(stats 只有单通道)
   float n=kk.x*gauss(pc,0)
    +kk.y*(gauss(pc+ivec2(1,0),0)+gauss(pc-ivec2(1,0),0)+gauss(pc+ivec2(0,1),0)+gauss(pc-ivec2(0,1),0))
    +kk.z*(gauss(pc+ivec2(1,1),0)+gauss(pc+ivec2(-1,1),0)+gauss(pc+ivec2(1,-1),0)+gauss(pc+ivec2(-1,-1),0))
    +kk.w*(gauss(pc+ivec2(2,0),0)+gauss(pc-ivec2(2,0),0)+gauss(pc+ivec2(0,2),0)+gauss(pc-ivec2(0,2),0));
   if(lam.x!=0.)n=(n+lam.x*(n*n-1.))/sqrt(1.+2.*lam.x*lam.x);
   float L0=r0R.x;
   gd=vec3(n,n,n)*L0*grainUmScale;
  }else{
   // 逐通道核加权:同一 13 位置 vec3 噪声场,各通道用各自的 (α,β,γ,δ)。
   vec3 wA=vec3(kR.x,kG.x,kB.x),wB=vec3(kR.y,kG.y,kB.y);
   vec3 wC=vec3(kR.z,kG.z,kB.z),wD=vec3(kR.w,kG.w,kB.w);
   vec3 n=wA*grainNoise(pc)
    +wB*(grainNoise(pc+ivec2(1,0))+grainNoise(pc-ivec2(1,0))+grainNoise(pc+ivec2(0,1))+grainNoise(pc-ivec2(0,1)))
    +wC*(grainNoise(pc+ivec2(1,1))+grainNoise(pc+ivec2(-1,1))+grainNoise(pc+ivec2(1,-1))+grainNoise(pc+ivec2(-1,-1)))
    +wD*(grainNoise(pc+ivec2(2,0))+grainNoise(pc-ivec2(2,0))+grainNoise(pc+ivec2(0,2))+grainNoise(pc-ivec2(0,2)));
   // Cholesky rows follow each channel's own bin: R row from bin_R, G row from
   // bin_G, B row from bin_B — per-channel marginal std is then exact; cross-
   // channel terms become cross-bin products (mixed-state approximation, the
   // measured cross-corr lives in the colorstate report).
   float L0=r0R.x;
   float L1=r0G.y,L3=r0G.w;
   float L2=r0B.z,L4=r1B.x,L5=r1B.y;
   gd=vec3(n.x*L0,n.x*L1+n.y*L3,n.x*L2+n.y*L4+n.z*L5);
   /* 偏斜变换(逐通道边际,λ 由 native 实测偏度反解,λ=0 时恒等):对标准化
      边际 m 做 m'=(m+λ(m²−1))/√(1+2λ²),方差恒 1、偏度=(6λ+8λ³)/(1+2λ²)^1.5。
      native 颗粒幅度分布在暗部档轻微右偏(trix bin0 偏度 0.38),高斯场复刻
      不了的不对称尾巴由这里补。 */
   vec3 sig=vec3(L0,sqrt(L1*L1+L3*L3),sqrt(L2*L2+L4*L4+L5*L5));
   if(lam.x!=0.||lam.y!=0.||lam.z!=0.){
    vec3 m=gd/max(sig,vec3(1e-9));
    m=(m+lam*(m*m-vec3(1.)))/sqrt(vec3(1.)+2.*lam*lam);
    gd=m*sig;
   }
   gd*=grainUmScale;
  }
  d+=gd;
 }
 vec3 t;
 if(sharedPrint==1){
  // W 预变换(恒等时 preW1/2/3=单位行,其余 0)→ 全局共享密度域坐标
  vec3 w=preW0+preW1*d.x+preW2*d.y+preW3*d.z
        +preW4*(d.x*d.x)+preW5*(d.y*d.y)+preW6*(d.z*d.z)
        +preW7*(d.x*d.y)+preW8*(d.x*d.z)+preW9*(d.y*d.z);
  t=clamp((w+0.45)*0.25,vec3(0.),vec3(1.));
 }else if(sharedScan==1){
  // 三次 W(3x20,特征序与 validation/shared-lut fit 的 feats20 一致):
  // [1,r,g,b,r²,g²,b²,rg,rb,gb,r³,g³,b³,r²g,r²b,g²r,g²b,b²r,b²g,rgb]
  vec3 d2=d*d,d3=d2*d;
  vec3 w=preWC0+preWC1*d.x+preWC2*d.y+preWC3*d.z
        +preWC4*d2.x+preWC5*d2.y+preWC6*d2.z
        +preWC7*(d.x*d.y)+preWC8*(d.x*d.z)+preWC9*(d.y*d.z)
        +preWC10*d3.x+preWC11*d3.y+preWC12*d3.z
        +preWC13*(d2.x*d.y)+preWC14*(d2.x*d.z)+preWC15*(d2.y*d.x)+preWC16*(d2.y*d.z)
        +preWC17*(d2.z*d.x)+preWC18*(d2.z*d.y)+preWC19*(d.x*d.y*d.z);
  t=clamp((w+0.45)*0.25,vec3(0.),vec3(1.));
 }else{
  t=(d-densityLow)/densitySpan;
  if(positive>0.5)t=sqrt(clamp(t,0.,1.));
 }
 vec3 s=sampleTable(colorLUT,lutSize,t);
 vec3 lin=mix(s/12.92,pow(max((s+.055)/1.055,0.),vec3(2.4)),step(vec3(.04045),s));
 if(glareAmount>0.){
  ivec2 pg=ivec2(globalPx)+int(glareSeed)*ivec2(91,17);
  lin+=exp(glareLognorm.x+glareLognorm.y*gauss(pg,40));
 }
 if(usmMode==1){
  frag=vec4(scanPacked==1?mix(lin*12.92,1.055*pow(max(lin,0.),vec3(1./2.4))-.055,step(vec3(.0031308),lin)):lin,1.);
  return;
 }
 if(glareAmount>0.)s=mix(lin*12.92,1.055*pow(max(lin,0.),vec3(1./2.4))-.055,step(vec3(.0031308),lin));
 // Lightweight final dither: deterministic ±0.5 LSB white noise keyed to the
 // output pixel, added in sRGB just before the RGBA8 framebuffer write so the
 // PNG save/share path never shows 8-bit banding on smooth gradients.
 // The intermediate pass returns above: dither is applied exactly once.
 vec3 dith=vec3(gh(ivec2(globalPx),200));
 s+=(dith-.5)/255.;
 frag=vec4(clamp(s,0.,1.),1.);
}
`;
// Complete 2-D Gaussian USM in linear RGB. All neighbours are read from one
// colour evaluation; the separable product is 25 cheap texture reads at sigma .7.
const SCAN_FRAG=`#version 300 es
precision highp float;precision highp int;
out vec4 frag;
uniform sampler2D scanRGB;uniform ivec2 scanSize;uniform ivec2 scanCrop;
uniform vec3 scanWeights;uniform float scanAmount;uniform int scanPacked;
uniform vec2 scanOffset;uniform float scanHeight;
int reflectScan(int p,int n){int k=((p%(2*n))+2*n)%(2*n);return min(k,2*n-1-k);}
vec3 readScan(ivec2 q){
 q=ivec2(reflectScan(q.x,scanSize.x),reflectScan(q.y,scanSize.y));
 vec3 s=texelFetch(scanRGB,q,0).rgb;
 return scanPacked==1?mix(s/12.92,pow(max((s+.055)/1.055,0.),vec3(2.4)),step(vec3(.04045),s)):s;
}
uint scanHash(uint x){x^=x>>16u;x*=0x7feb352du;x^=x>>15u;x*=0x846ca68bu;x^=x>>16u;return x;}
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy)+scanCrop;vec3 b=vec3(0.);
 for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){
  float wx=x==0?scanWeights.x:(abs(x)==1?scanWeights.y:scanWeights.z);
  float wy=y==0?scanWeights.x:(abs(y)==1?scanWeights.y:scanWeights.z);
  b+=readScan(p+ivec2(x,y))*wx*wy;
 }
 vec3 c=readScan(p),lin=max(c+scanAmount*(c-b),0.);
 vec3 s=mix(lin*12.92,1.055*pow(lin,vec3(1./2.4))-.055,step(vec3(.0031308),lin));
 ivec2 gp=ivec2(vec2(gl_FragCoord.x,scanHeight-1.-gl_FragCoord.y)+scanOffset);
 uint hh=scanHash(uint(gp.x)+scanHash(uint(gp.y)+uint(200)*0x9E3779B9u));
 float noise=(float(hh>>8u)+.5)/16777216.;
 frag=vec4(clamp(s+(noise-.5)/255.,0.,1.),1.);
}
`;
// ---------------------------------------------------------------------------
// GPU optical-field builder: replicates FilmifyNativeFilm.optics at bounded
// field resolution, moving the CPU raw-sample + FIR-gaussian + additive-glow
// work into WebGL2 passes (the largest CPU block in developMobile — ~275ms of
// the ~400ms desktop total, per validation/timing-probe-check.cjs).
//
// Equivalence contract (mirrors mobile-optics.js buildField exactly):
//  - raw pass: manual trilinear on the renderer's raw LUT texture with the
//    same texel-centre convention as sampleTable in the tile shader and CPU;
//  - gaussian: separable vertical-then-horizontal FIR, radius floor(3s+.5),
//    exp(-k^2/2s^2) weights normalised, half-sample reflect boundary — the
//    exact CPU FIR branch. The mobile field never reaches the recursive IIR
//    branch (max sigma across all 11 stocks at a 768px field is 2.47); any
//    sigma>=3 falls back to CPU buildField (defensive for future stocks);
//  - combine/delta: same scalar algebra, linear additive glow (after−before,
//    2026-09-22 起;原 log10 增量在暗像素爆炸), output
//    RGBA16F row 0 = source top, identical layout to the CPU half pack.
// Half-float FBO rendering needs EXT_color_buffer_float (or the WebGL1 half
// float ext); without it (or any GL failure) buildOpticsGPU returns null and
// the engine keeps the CPU path — never a silent degradation of the field.
const OPT_EXP=[[.1633,.5360],[.6496,1.5236],[.1870,2.7684]];
function optKernel(sigma){
 const radius=Math.floor(3*sigma+.5);
 const w=new Float32Array(15);
 if(radius<=0){w[7]=1;return {radius:0,weights:w};}
 let total=0;
 for(let k=-radius;k<=radius;k++){const a=Math.exp(-.5*k*k/(sigma*sigma));w[k+7]=a;total+=a;}
 for(let k=0;k<15;k++)w[k]/=total;
 return {radius:radius,weights:w};
}
// 2026-09-21: small-scale scatter moved OUT of the field into full-resolution
// tile passes (field pixels are ~46um, scatter sigma 2-27um is sub-pixel there
// and vanished). The GPU field builder therefore zeroes scatter_amount.
// v2 (exact per-term): the native scatter PSF is a WEIGHTED SUM of gaussians
// with different sigmas, which is NOT separable as one kernel — a combined
// single kernel puts sum_i!=j wi*wj (here ~66%) of its energy into anisotropic
// cross terms G_i(x)G_j(y) the native PSF does not have (measured: 1px checker
// over-blurred ~2x vs native, validation/scatter-gap). Scatter therefore runs
// as one separable pair per exponential term, accumulated exactly; the core
// term (sigma<=0.3px at every supported size) folds into the centre delta.
// Term kernels are per-channel (scatter_tail_um/weight differ per channel),
// packed as an RGB32F (2R+1) x (2*nTerms) texture: even rows carry the
// amplitude-baked kernel (H pass), odd rows the unit-sum kernel (V pass) —
// baking the amplitude into both passes would square it (measured a² energy
// loss on flat input, validation/scatter-debug).
function scatterKernels(style,um){
 const fp=style.film,hal=fp.halation;
 if(!hal||!hal.active)return null;
 const s=hal.scatter_amount||0;
 if(s<=0)return null;
 const ss=hal.scatter_spatial_scale||1;
 let radius=0;
 const sigmas=[]; // [term][ch]
 for(const [a,r] of OPT_EXP){
  const row=[];
  for(let ch=0;ch<3;ch++){
   const ci=Math.min(ch,fp.channels-1);
   const sigma=Math.max(1e-6,hal.scatter_tail_um[ci]*ss/um)*r;
   row.push(sigma);radius=Math.max(radius,Math.floor(3*sigma+.5));
  }
  sigmas.push(row);
 }
 // The core is not always sub-pixel: Tri-X at 16 mm / 4096 px has sigma
 // ~0.56 px. Keep it as a separate Gaussian term instead of disabling the
 // entire scatter stage as the old core-radius guard did.
 const coreSigmas=[0,1,2].map(ch=>Math.max(1e-6,hal.scatter_core_um[Math.min(ch,fp.channels-1)]*ss/um));
 const coreResolved=coreSigmas.some(sigma=>Math.floor(3*sigma+.5)>1);
 if(coreResolved){sigmas.unshift(coreSigmas);for(const sigma of coreSigmas)radius=Math.max(radius,Math.floor(3*sigma+.5));}
 if(radius<1)return null; // 当前尺寸下散射尾整体亚像素，无可做内容
 /* SCAT_BLUR_FRAG 循环静态上限 65 taps(半径≤32 才读全核):越界核尾会被静默截断
    (能量丢失且无任何报错)。当前全部配方/画幅可达最大 radius=21(tri-x 16mm@4096),
    本守卫只防未来画幅/参数变更越界——越界即放弃 scatter,维持改动前行为(2026-09-21 review)。 */
 if(radius>32)return null;
 const n=radius*2+1,nT=sigmas.length,weights=new Float32Array(n*nT*2*3);
 /* 核纹理每项 2 行:偶数行=幅度烘焙的行向核(a*g,供 H pass),奇数行=纯归一核
    (g,供 V pass)。可分离 2D 核 K=a·g(x)g(y) 的幅度只能烘进一趟——两趟都烘
    a 会得 a²(2026-09-21 实测 V0=H0*a,平坦输入能量丢 2/3)。 */
 const center=[1,1,1];
 for(let ch=0;ch<3;ch++){
  const ci=Math.min(ch,fp.channels-1);
  const tw=(hal.scatter_tail_weight&&hal.scatter_tail_weight[ci])||0;
  // Unresolved core remains folded into the centre; a resolved core has its
  // own separable pass with amplitude s*(1-tail), matching native optics.
  center[ch]=coreResolved?1-s:1-s*tw;
  for(let t=0;t<nT;t++){
   const sigma=sigmas[t][ch],r=Math.floor(3*sigma+.5);
   const a=coreResolved&&t===0?s*(1-tw):s*tw*OPT_EXP[t-(coreResolved?1:0)][0];
   const hRow=2*t,vRow=2*t+1;
   if(r<=0){weights[(hRow*n+radius)*3+ch]+=a;weights[(vRow*n+radius)*3+ch]+=1;continue;}
   let total=0;const g=new Float64Array(2*r+1);
   for(let k=-r;k<=r;k++){const v=Math.exp(-.5*k*k/(sigma*sigma));g[k+r]=v;total+=v;}
   for(let k=-r;k<=r;k++){
    weights[(hRow*n+radius+k)*3+ch]+=a*g[k+r]/total;
    weights[(vRow*n+radius+k)*3+ch]+=g[k+r]/total;
   }
  }
 }
 return {radius:radius,weights:weights,terms:nT,rows:nT*2,center:center};
}
const DIR_DOWN_FRAG=`#version 300 es
precision highp float;precision highp int;
out vec4 frag;uniform sampler2D src;uniform ivec2 imageSize;uniform ivec2 sourceOrigin;uniform int sourceHeight;uniform int scale;
void main(){
 ivec2 first=ivec2(gl_FragCoord.xy)*scale;vec3 sum=vec3(0.);float n=0.;
 for(int y=0;y<16;y++){if(y>=scale)break;for(int x=0;x<16;x++){if(x>=scale)break;
  ivec2 p=first+ivec2(x,y);if(p.x>=imageSize.x||p.y>=imageSize.y)continue;
  ivec2 local=p-sourceOrigin;local.y=sourceHeight-1-local.y;
  sum+=texelFetch(src,local,0).rgb;n+=1.;
 }}frag=vec4(sum/max(n,1.),1.);
}`;
// Same separable Gaussian mixture as native: amplitude is applied only once.
function dirKernel(sigma,amplitude){
 const radius=Math.floor(3*sigma+.5),n=2*radius+1,weights=new Float32Array(n*2*3);let sum=0;
 for(let k=-radius;k<=radius;k++)sum+=sigma>0?Math.exp(-.5*k*k/(sigma*sigma)):1;
 for(let k=-radius;k<=radius;k++){const v=(sigma>0?Math.exp(-.5*k*k/(sigma*sigma)):1)/sum;
  for(let ch=0;ch<3;ch++){weights[(k+radius)*3+ch]=v*amplitude;weights[(n+k+radius)*3+ch]=v;}}
 return {radius:radius,weights:weights,clampEdges:sigma>=3};
}
const OPT_RAW_FRAG=`#version 300 es
precision highp float;precision highp sampler3D;
in vec2 uv;out vec4 frag;
uniform sampler2D source;uniform sampler3D rawLUT;uniform float rawSize;uniform vec3 rawScale;
vec3 sampleTable(sampler3D lut,float size,vec3 coord){
 coord=clamp(coord,0.,1.);
 vec3 p=coord*(size-1.);vec3 i0=floor(p);vec3 f=p-i0;
 ivec3 a=ivec3(i0);ivec3 b=min(a+1,ivec3(int(size)-1));
 vec3 c000=texelFetch(lut,ivec3(a.x,a.y,a.z),0).rgb;
 vec3 c100=texelFetch(lut,ivec3(b.x,a.y,a.z),0).rgb;
 vec3 c010=texelFetch(lut,ivec3(a.x,b.y,a.z),0).rgb;
 vec3 c110=texelFetch(lut,ivec3(b.x,b.y,a.z),0).rgb;
 vec3 c001=texelFetch(lut,ivec3(a.x,a.y,b.z),0).rgb;
 vec3 c101=texelFetch(lut,ivec3(b.x,a.y,b.z),0).rgb;
 vec3 c011=texelFetch(lut,ivec3(a.x,b.y,b.z),0).rgb;
 vec3 c111=texelFetch(lut,ivec3(b.x,b.y,b.z),0).rgb;
 return mix(mix(mix(c000,c100,f.x),mix(c010,c110,f.x),f.y),mix(mix(c001,c101,f.x),mix(c011,c111,f.x),f.y),f.z);
}
void main(){vec3 srgb=texelFetch(source,ivec2(gl_FragCoord.xy),0).rgb;frag=vec4(sampleTable(rawLUT,rawSize,srgb)*rawScale,1);}
`;
const SCAT_BLUR_FRAG=`#version 300 es
precision highp float;
in vec2 uv;out vec4 frag;
uniform sampler2D src;uniform sampler2D kern;uniform int radius;uniform int axis;uniform int kernRow;
uniform sampler2D accum;uniform float useAccum;uniform int clampEdges;
int refl(int i,int n){int m=i%(2*n);if(m<0)m+=2*n;return min(m,2*n-1-m);}
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy);ivec2 sz=textureSize(src,0);
 int n=axis==0?sz.x:sz.y;
 vec3 acc=vec3(0.);
 for(int k=0;k<65;k++){
  if(k>2*radius)break;
  int off=k-radius;
  int raw=axis==0?p.x+off:p.y+off;
  int idx=clampEdges==1?clamp(raw,0,n-1):refl(raw,n);
  ivec2 q=axis==0?ivec2(idx,p.y):ivec2(p.x,idx);
  vec3 w=texelFetch(kern,ivec2(k,kernRow),0).rgb;
  acc+=w*texelFetch(src,q,0).rgb;
 }
 if(useAccum>.5)acc+=texelFetch(accum,p,0).rgb;
 frag=vec4(acc,1.);
}
`;
const OPT_GAUSS_FRAG=`#version 300 es
precision highp float;
in vec2 uv;out vec4 frag;
uniform sampler2D src;uniform int axis;uniform int channel;uniform float uW[15];
int refl(int i,int n){int m=i%(2*n);if(m<0)m+=2*n;return min(m,2*n-1-m);}
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy);ivec2 sz=textureSize(src,0);int n=axis==0?sz.y:sz.x;
 float acc=0.;
 for(int k=-7;k<=7;k++){
  int idx=refl(axis==0?p.y+k:p.x+k,n);
  ivec2 q=axis==0?ivec2(p.x,idx):ivec2(idx,p.y);
  vec4 v=texelFetch(src,q,0);
  float val=channel==0?v.r:(channel==1?v.g:v.b);
  acc+=uW[k+7]*val;
 }
 frag=vec4(acc,0,0,1);
}
`;
const OPT_GAUSS_R_FRAG=`#version 300 es
precision highp float;
in vec2 uv;out vec4 frag;
uniform sampler2D src;uniform int axis;uniform float uW[15];
int refl(int i,int n){int m=i%(2*n);if(m<0)m+=2*n;return min(m,2*n-1-m);}
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy);ivec2 sz=textureSize(src,0);int n=axis==0?sz.y:sz.x;
 float acc=0.;
 for(int k=-7;k<=7;k++){
  int idx=refl(axis==0?p.y+k:p.x+k,n);
  ivec2 q=axis==0?ivec2(p.x,idx):ivec2(idx,p.y);
  acc+=uW[k+7]*texelFetch(src,q,0).r;
 }
 frag=vec4(acc,0,0,1);
}
`;
const OPT_COMBINE_FRAG=`#version 300 es
precision highp float;
in vec2 uv;out vec4 frag;
uniform sampler2D tex0;uniform sampler2D tex1;uniform sampler2D tex2;
uniform int mode;uniform int channel;
uniform float s;uniform float tail;uniform float gain;uniform float strength;uniform float norm;uniform vec3 transmission;
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy);
 vec4 a=texelFetch(tex0,p,0);
 if(mode==0){frag=vec4(a.rgb,1);return;}
 if(mode==5){
  vec4 b=texelFetch(tex1,p,0);
  // 线性加性辉光(after−before):与 CPU buildField 同式;原 log10 差在
  // 近零暗像素上爆炸(+6~8 个数量级),2026-09-22 改线性差根治暗部火星。
  vec3 d=a.rgb-transmission*b.rgb;
  frag=vec4(d,1);return;
 }
 vec4 g=texelFetch(tex1,p,0);
 float acc;
 if(mode==1){
  vec4 c=texelFetch(tex2,p,0);
  float tv=channel==0?a.r:(channel==1?a.g:a.b);
  // Gaussian textures carry the single channel in .r (RGBA16F since 2026-09-21).
  float gv=g.r;
  acc=(1.-s)*tv+s*(1.-tail)*gv;
  frag=channel==0?vec4(acc,c.g,c.b,1.):(channel==1?vec4(c.r,acc,c.b,1.):vec4(c.r,c.g,acc,1.));
  return;
 }
 if(mode==2){
  float cv=channel==0?a.r:(channel==1?a.g:a.b);
  float gv=g.r;
  acc=cv+gain*gv;
  frag=channel==0?vec4(acc,a.g,a.b,1.):(channel==1?vec4(a.r,acc,a.b,1.):vec4(a.r,a.g,acc,1.));
  return;
 }
 if(mode==3){frag=vec4(a.r+gain*g.r,0,0,1);return;}
 if(mode==4){
  float cv=channel==0?a.r:(channel==1?a.g:a.b);
  acc=(cv+strength*g.r)/norm;
  frag=channel==0?vec4(acc,a.g,a.b,1.):(channel==1?vec4(a.r,acc,a.b,1.):vec4(a.r,a.g,acc,1.));
  return;
 }
 frag=vec4(a.rgb,1);
}
`;
// Two complex transforms packed into RG/BA: source and the exact sampled PSF.
// Radix-2 DIT, bit reversal on input; inverse is normalised at each stage.
const DIFF_INIT_FRAG=`#version 300 es
precision highp float;precision highp int;precision highp sampler2D;
out vec4 frag;
uniform sampler2D src;uniform sampler2D kernel;
uniform ivec2 size;uniform ivec2 fftSize;uniform int radius;uniform int channel;uniform int multiply;
int reverseIndex(int v,int n){int r=0;for(int k=1;k<n;k*=2){r=r*2+(v&1);v>>=1;}return r;}
int mirror(int i,int n){if(n<=1)return 0;int period=2*n-2;int k=((i%period)+period)%period;return min(k,period-k);}
void main(){
 ivec2 q=ivec2(gl_FragCoord.xy);q=ivec2(reverseIndex(q.x,fftSize.x),reverseIndex(q.y,fftSize.y));
 if(multiply==1){vec4 v=texelFetch(src,q,0);frag=vec4(v.x*v.z-v.y*v.w,v.x*v.w+v.y*v.z,0,0);return;}
 float a=0.,b=0.;
 if(all(lessThan(q,size+2*radius))){ivec2 v=ivec2(mirror(q.x-radius,size.x),mirror(q.y-radius,size.y));a=texelFetch(src,v,0)[channel];}
 ivec2 k=ivec2(q.x>fftSize.x/2?q.x-fftSize.x:q.x,q.y>fftSize.y/2?q.y-fftSize.y:q.y);
 if(all(lessThanEqual(abs(k),ivec2(radius))))b=texelFetch(kernel,k+radius,0).r;
 frag=vec4(a,0,b,0);
}`;
const DIFF_FFT_FRAG=`#version 300 es
precision highp float;precision highp int;precision highp sampler2D;
out vec4 frag;uniform sampler2D src;uniform int axis;uniform int span;uniform int inverse;
vec2 mul(vec2 a,vec2 b){return vec2(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
void main(){
 ivec2 q=ivec2(gl_FragCoord.xy);int v=axis==0?q.x:q.y;int halfSpan=span/2,j=v%halfSpan;
 int base=(v/span)*span+j;ivec2 a=q,b=q;if(axis==0){a.x=base;b.x=base+halfSpan;}else{a.y=base;b.y=base+halfSpan;}
 float angle=6.283185307179586*float(j)/float(span)*(inverse==1?1.:-1.);vec2 w=vec2(cos(angle),sin(angle));
 vec4 av=texelFetch(src,a,0),bv=texelFetch(src,b,0);vec4 t=vec4(mul(bv.xy,w),mul(bv.zw,w));
 frag=(av+(v%span<halfSpan?t:-t))*(inverse==1?.5:1.);
}`;
const DIFF_OUT_FRAG=`#version 300 es
precision highp float;precision highp int;precision highp sampler2D;
out vec4 frag;uniform sampler2D src;uniform sampler2D convolved;uniform int radius;uniform int channel;uniform float amount;
void main(){ivec2 q=ivec2(gl_FragCoord.xy);vec4 v=texelFetch(src,q,0);v[channel]=mix(v[channel],texelFetch(convolved,q+radius,0).r,amount);frag=vec4(v.rgb,1.);}
`;
// The particle-cloud blur changes with um/px, so grain is not simply 1/um
// times an 8um noise field. These uniform-patch measurements come from the
// pinned native model, without photographs or per-scene adjustments. Keep the
// original 8um table exact; interpolate physical-scale corrections in log um.
function grainAtScale(stats,um){
 if(!stats||!stats.physicalScales||um===stats.umRef)return stats;
 const rows=stats.physicalScales;
 let hi=0;while(hi<rows.length-1&&rows[hi].um<um)hi++;
 const lo=Math.max(0,hi-1),a=rows[lo],b=rows[hi];
 const t=lo===hi?0:Math.max(0,Math.min(1,Math.log(um/a.um)/Math.log(b.um/a.um)));
 const mix=(x,y)=>Array.isArray(x)?x.map((v,i)=>mix(v,y[i])):x+(y-x)*t;
 const scale=mix(a.rmsScale,b.rmsScale),channels=stats.channels;
 const cov=stats.cov.map((row,i)=>{
  const out=[];let j=0;
  for(let c=0;c<channels;c++)for(let d=c;d<channels;d++)out.push(row[j++]*scale[i][c]*scale[i][d]);
  return out;
 });
 return Object.assign({},stats,{cov:cov,kern:mix(a.kern,b.kern),skewL:mix(a.skewL,b.skewL)});
}
class Renderer {
 constructor(canvas,{forcePacked=false}={}){
  this.canvas=canvas;
  const gl=this.gl=canvas.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:true});
  if(!gl)throw new Error('此设备暂不支持 WebGL2 移动色彩核心');
  this.lutFloat32=!!gl.getExtension('OES_texture_float_linear');
  this.halfFloatLinear=!!gl.getExtension('OES_texture_half_float_linear');
  // LINEAR filtering on half-float textures needs its own extension; without
  // BOTH extensions the LUTs would be incomplete (sample as black) — fall back
  // to NEAREST + manual trilinear/bilinear in the shader (lutNearest uniform).
  this.lutNearest=!this.lutFloat32&&!this.halfFloatLinear;
  // The optics field is RGBA16F regardless of the LUT path: its LINEAR filter
  // requires half-float LINEAR specifically. Strict drivers treat a LINEAR
  // RGBA16F texture without the extension as incomplete (samples black) —
  // ANGLE/Metal is lenient and filters anyway, which masked this on desktop.
  this.fieldNearest=!this.halfFloatLinear;
  // Device fingerprint for real-device diagnostics (surfaced via timings and
  // window.FILMIFY_DIAG; also embedded in self-check failure reports).
  try{
   const dbg=gl.getExtension('WEBGL_debug_renderer_info');
   this.caps={renderer:dbg?String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)):'unknown',
    floatLinear:this.lutFloat32,halfFloatLinear:this.halfFloatLinear,
    colorBufferFloat:!!gl.getExtension('EXT_color_buffer_float'),
    colorBufferHalfFloat:!!gl.getExtension('EXT_color_buffer_half_float')};
  }catch(error){this.caps={renderer:'unknown'};}
  this.programs={main:this.program(FRAG),scatBlur:this.program(SCAT_BLUR_FRAG),scanner:this.program(SCAN_FRAG)};
  this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
  this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  this.luts=new Map();this.lutCache=new Map();this.curves=null;this.source=null;
  this.cleanTex=null;this.cleanFBO=null;
  this.opticsField=null;this.grainStats=null;this.grainSeed=0;this.grainTex=null;
  this.optProgs=null;this.optFBO=null;this.optFloatRenderOK=false;
  // Full-res local scatter state (kernel texture + per-tile RGBA32F work
  // textures). scatter==null → shader path identical to the pre-scatter build.
  this.scatter=null;this.scatKern=null;
  this.spatialDir=null;this.dirBuffers={};this.dirFBO=null;this.dirDownProgram=null;this.dirKernelTex=null;this.dirMs=0;
  this.forceNoDir=false; // options.dir===false 时由 engine 置位(A/B 对照)
  this.scatT0=null;this.scatH=null;this.scatB=null;this.scatA=null;this.scatFBO=null;this.scatW=0;this.scatHh=0;
  this.sourceW=0;this.sourceH=0;this.sourceCrop={x:0,y:0};
  this.contextLost=false;
  this.onContextLost=event=>{event.preventDefault();this.contextLost=true;};
  this.onContextRestored=()=>{this.contextLost=true;};
  canvas.addEventListener('webglcontextlost',this.onContextLost);
  canvas.addEventListener('webglcontextrestored',this.onContextRestored);
  gl.disable(gl.DITHER);
 }
 assertContext(){if(this.contextLost||this.gl.isContextLost())throw new Error('图像处理资源已释放，请重试');}
 program(fragment){
  const gl=this.gl,p=gl.createProgram();
  for(const [type,src] of [[gl.VERTEX_SHADER,VERT],[gl.FRAGMENT_SHADER,fragment]]){
   const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
   if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));
   gl.attachShader(p,s);gl.deleteShader(s);
  }
  gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
  return p;
 }
 uniform(p,n,...v){const gl=this.gl,loc=gl.getUniformLocation(p,n);if(v.length===2)gl.uniform2f(loc,...v);else if(v.length===3)gl.uniform3f(loc,...v);else gl.uniform1f(loc,v[0]);}
 textureParams(target){const gl=this.gl;gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}
 make3D(values,size){
  const gl=this.gl,tex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_3D,tex);this.textureParams(gl.TEXTURE_3D);
  if(this.lutNearest){gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);}
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  gl.texImage3D(gl.TEXTURE_3D,0,this.lutFloat32?gl.RGB32F:gl.RGB16F,size,size,size,0,gl.RGB,gl.FLOAT,values);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
  return tex;
 }
 makeCurves(style){
  const fp=style.film,channels=fp.channels;
  const axis=fp.logExposure,last=axis.length-1;
  let lo=axis[0],hi=axis[last];
  if(lo>=hi){const s=JSON.stringify(axis);throw new Error('logExposure 轴无效 '+s);}
  /* 两行:row0 = 显影曲线(非修正,donor 端),row1 = correctedCurves(DIR 修正
     后,receiver 端)。无 correctedCurves 时 row1 复刻 row0(=DIR 关)。 */
  const curves=fp.curves,corrected=fp.correctedCurves||fp.curves;
  const ci0=Math.min(0,channels-1),ci1=Math.min(1,channels-1),ci2=Math.min(channels-1,2);
  const data=new Float32Array(axis.length*4*2);
  for(let i=0;i<axis.length;i++){
   data[i*4]=curves[ci0][i];data[i*4+1]=curves[ci1][i];data[i*4+2]=curves[ci2][i];data[i*4+3]=1;
   const o=(axis.length+i)*4;
   data[o]=corrected[ci0][i];data[o+1]=corrected[ci1][i];data[o+2]=corrected[ci2][i];data[o+3]=1;
  }
  const gl=this.gl,tex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,axis.length,2,0,gl.RGBA,gl.FLOAT,data);
  return {tex:tex,n:axis.length,low:lo,span:hi-lo};
 }
 setStyle(style){
  this.assertContext();
  if(this.style===style)return;
  /* LUT/curve textures cached per style for the session: switching recipes
     rebinds instead of delete+re-upload (the renderer now outlives one develop). */
  let entry=this.lutCache.get(style);
  if(!entry){
   const values=style.mobileValues;
   if(!values)throw new Error('移动端色彩资源未加载');
   const raw=style.rawValues;
   if(!raw)throw new Error('raw 色彩资源未加载');
   entry={raw:this.make3D(raw,style.rawSize),scan:this.make3D(values,style.mobileSize),curves:this.makeCurves(style)};
   this.lutCache.set(style,entry);
  }
  this.style=style;
  this.luts.set('raw',entry.raw);this.luts.set('scan',entry.scan);this.curves=entry.curves;
 }
 releaseStyle(){this.luts.clear();this.curves=null;this.style=null;}
 setSource(tileCanvas,crop){this.assertContext();const gl=this.gl;
  if(this.source)gl.deleteTexture(this.source);
  this.source=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.source);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,tileCanvas);
  // Restore default: FLIP_Y must not leak into later float uploads (RGBA32F
  // curve textures fail with INVALID_OPERATION while it is set).
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  this.sourceW=tileCanvas.width;this.sourceH=tileCanvas.height;
  this.sourceCrop=crop||{x:0,y:0};
 }
 /* setSource 的类型化数组变体（真机黑图修复第二级兜底）：部分 WebView 从
    canvas 元素上传大尺寸纹理会采到全黑（GPU→GPU SharedImage 路径坏），改走
    CPU 像素上传绕开。UNPACK_FLIP_Y_WEBGL 对类型化数组同样生效，语义一致。 */
 setSourcePixels(pixels,w,h,crop){this.assertContext();const gl=this.gl;
  if(this.source)gl.deleteTexture(this.source);
  this.source=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.source);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  this.sourceW=w;this.sourceH=h;
  this.sourceCrop=crop||{x:0,y:0};
 }
 /* Prefer RGBA32F scatter targets; half-float-only devices can still perform
    the same passes in RGBA16F. Do not mistake absence of 32-bit rendering for
    absence of all floating-point rendering. Report the unsupported path. */
 setScatter(sc){this.assertContext();const gl=this.gl;
  if(this.scatKern){gl.deleteTexture(this.scatKern);this.scatKern=null;}
  this.scatter=null;
  this.scatterMode='off';
  if(!sc)return;
  this.scatterHalf=!this.caps.colorBufferFloat&&this.caps.colorBufferHalfFloat;
  if(!this.caps.colorBufferFloat&&!this.scatterHalf){this.scatterMode='unavailable';return;}
  const n=sc.radius*2+1,tex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE9);gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB32F,n,sc.rows,0,gl.RGB,gl.FLOAT,sc.weights);
  this.scatKern=tex;this.scatter=sc;
  this.scatterMode=this.scatterHalf?'float16':'float32';
 }
 ensureScatterTargets(w,h){
  const gl=this.gl;
  if(this.scatT0&&this.scatW===w&&this.scatHh===h&&this.scatTargetHalf===this.scatterHalf)return;
  for(const t of [this.scatT0,this.scatH,this.scatB,this.scatA])if(t)gl.deleteTexture(t);
  if(this.scatFBO)gl.deleteFramebuffer(this.scatFBO);
  const mk=()=>{const t=gl.createTexture();
   gl.activeTexture(gl.TEXTURE9);gl.bindTexture(gl.TEXTURE_2D,t);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   gl.texImage2D(gl.TEXTURE_2D,0,this.scatterHalf?gl.RGBA16F:gl.RGBA32F,w,h,0,gl.RGBA,this.scatterHalf?gl.HALF_FLOAT:gl.FLOAT,null);return t;};
  this.scatT0=mk();this.scatH=mk();this.scatB=mk();this.scatA=mk();
  const fbo=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.scatT0,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('设备无法创建散射缓冲');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  this.scatFBO=fbo;this.scatW=w;this.scatHh=h;
  this.scatTargetHalf=this.scatterHalf;
 }
 /* Per-tile scatter pre-passes: raw(padded tile) -> per exponential term
    (H blur, then V blur accumulated via ping-pong — no float blending needed).
    Exact separable-per-term replica of the native scatter; the combined
    single-kernel shortcut was measured to over-blur (cross terms, see
    scatterKernels note). The live sum texture is left in this.scatSum. */
 scatterPasses(style){
  const gl=this.gl,w=this.sourceW,h=this.sourceH;
  this.ensureScatterTargets(w,h);
  this.ensureOpticsPrograms();
  const FBO=this.scatFBO;
  const attach=(t)=>{gl.bindFramebuffer(gl.FRAMEBUFFER,FBO);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);};
  const draw=(prog)=>{gl.useProgram(prog);gl.bindVertexArray(this.vao);gl.viewport(0,0,w,h);gl.drawArrays(gl.TRIANGLES,0,3);
   // Unbind the FBO after each pass (next pass samples what we just wrote —
   // same feedback-loop rule as the optics field builder).
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);};
  const pr=this.optProgs.raw;
  gl.useProgram(pr);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.source);gl.uniform1i(gl.getUniformLocation(pr,'source'),1);
  gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_3D,this.luts.get('raw'));gl.uniform1i(gl.getUniformLocation(pr,'rawLUT'),2);
  gl.uniform1f(gl.getUniformLocation(pr,'rawSize'),style.rawSize);
  gl.uniform3fv(gl.getUniformLocation(pr,'rawScale'),style.rawScale);
  attach(this.scatT0);draw(pr);
  const pb=this.programs.scatBlur;
  gl.useProgram(pb);
  gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,this.scatKern);gl.uniform1i(gl.getUniformLocation(pb,'kern'),2);
  gl.activeTexture(gl.TEXTURE3);gl.uniform1i(gl.getUniformLocation(pb,'accum'),3);
  gl.uniform1i(gl.getUniformLocation(pb,'radius'),this.scatter.radius);
  gl.uniform1i(gl.getUniformLocation(pb,'clampEdges'),0);
  const blur=(src,dst,axis,row,accum)=>{
   gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,src);gl.uniform1i(gl.getUniformLocation(pb,'src'),1);
   gl.uniform1i(gl.getUniformLocation(pb,'axis'),axis);
   gl.uniform1i(gl.getUniformLocation(pb,'kernRow'),row);
   if(accum){gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,accum);gl.uniform1f(gl.getUniformLocation(pb,'useAccum'),1);}
   else {
    // Rebind even when useAccum=0: Adreno rejects a sampler still pointing
    // at this pass's render target (four-term scatter leaves that binding).
    gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,src);
    gl.uniform1f(gl.getUniformLocation(pb,'useAccum'),0);
   }
   attach(dst);draw(pb);
  };
  let acc=null;
  for(let t=0;t<this.scatter.terms;t++){
   blur(this.scatT0,this.scatH,0,2*t,null);      // 偶数行:幅度烘焙核
   const dst=(acc===this.scatB)?this.scatA:this.scatB;
   blur(this.scatH,dst,1,2*t+1,acc);             // 奇数行:纯归一核(幅度只烘一趟)
   acc=dst;
  }
  this.scatSum=acc;
 }
 // Spatial DIR owns bounded tile/field targets only, released after each photo.
 beginSpatialDir(style,um,W,H,enabled){
  this.endSpatialDir();this.dirMs=0;this.dirPeakBytes=0;
  const fp=style.film,p=fp.dir;
  this.dirMode=enabled?'inactive':'off';
  if(!enabled||this.forceNoDir||!p||!p.active||!fp.correctedCurves||!(p.diffusion_size_um>0))return 0;
  if(!this.caps.colorBufferFloat&&!this.caps.colorBufferHalfFloat){this.dirMode='unavailable';return 0;}
  const radius=Math.floor(3*p.diffusion_size_um/um+.5);
  // Bound both FIR loop radius and box-filter footprint for supported inputs.
  const edge=Math.max(1,Math.min(512,Math.floor(30*(um*Math.max(W,H))/(3*2.7684*Math.max(p.diffusion_tail_um,1e-6)))));
  const scale=Math.max(1,Math.ceil(Math.max(W,H)/edge));
  if(radius>32||scale>16){this.dirMode='out-of-range';return 0;}
  this.spatialDir={radius:radius,scale:scale,w:Math.ceil(W/scale),h:Math.ceil(H/scale),W:W,H:H,um:um,
   core:dirKernel(p.diffusion_size_um/um,1),tailWeight:p.diffusion_tail_weight||0,tailUm:p.diffusion_tail_um,ready:false};
  this.dirMode=this.caps.colorBufferFloat?'float32':'float16';
  this.dirFBO=this.gl.createFramebuffer();
  this.dirTarget('field',this.spatialDir.w,this.spatialDir.h);
  return radius;
 }
 dirTarget(key,w,h){
  const gl=this.gl,old=this.dirBuffers[key];if(old&&old.w===w&&old.h===h)return old.tex;
  if(old)gl.deleteTexture(old.tex);
  const tex=gl.createTexture();gl.activeTexture(gl.TEXTURE12);gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,this.caps.colorBufferFloat?gl.RGBA32F:gl.RGBA16F,w,h,0,gl.RGBA,this.caps.colorBufferFloat?gl.FLOAT:gl.HALF_FLOAT,null);
  this.dirBuffers[key]={tex:tex,w:w,h:h};
  let bytes=0;for(const name of Object.keys(this.dirBuffers)){const b=this.dirBuffers[name];bytes+=b.w*b.h*(this.caps.colorBufferFloat?16:8);}
  this.dirPeakBytes=Math.max(this.dirPeakBytes||0,bytes);return tex;
 }
 dirAttach(tex,w,h){
  const gl=this.gl;gl.bindFramebuffer(gl.FRAMEBUFFER,this.dirFBO);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('设备无法创建空间显影缓冲');
  gl.viewport(0,0,w,h);gl.bindVertexArray(this.vao);
 }
 dirBlur(src,dst,w,h,kernel,axis,row,accum){
  const gl=this.gl,p=this.programs.scatBlur;
  if(!this.dirKernelTex)this.dirKernelTex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,this.dirKernelTex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB32F,2*kernel.radius+1,2,0,gl.RGB,gl.FLOAT,kernel.weights);
  gl.useProgram(p);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,src);gl.uniform1i(gl.getUniformLocation(p,'src'),1);
  gl.uniform1i(gl.getUniformLocation(p,'kern'),2);gl.uniform1i(gl.getUniformLocation(p,'radius'),kernel.radius);
  gl.uniform1i(gl.getUniformLocation(p,'axis'),axis);gl.uniform1i(gl.getUniformLocation(p,'kernRow'),row);
  gl.uniform1i(gl.getUniformLocation(p,'clampEdges'),kernel.clampEdges?1:0);
  gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,accum||src);gl.uniform1i(gl.getUniformLocation(p,'accum'),3);gl.uniform1f(gl.getUniformLocation(p,'useAccum'),accum?1:0);
  this.dirAttach(dst,w,h);gl.drawArrays(gl.TRIANGLES,0,3);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
 }
 accumulateDirField(x,y,w,h){
  const d=this.spatialDir,gl=this.gl;
  if(!this.dirDownProgram)this.dirDownProgram=this.program(DIR_DOWN_FRAG);
  const p=this.dirDownProgram;gl.useProgram(p);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.dirBuffers.source.tex);
  gl.uniform1i(gl.getUniformLocation(p,'src'),1);gl.uniform2i(gl.getUniformLocation(p,'imageSize'),d.W,d.H);
  gl.uniform2i(gl.getUniformLocation(p,'sourceOrigin'),x-this.sourceCrop.x,y-(this.sourceH-this.sourceCrop.y-h));
  gl.uniform1i(gl.getUniformLocation(p,'sourceHeight'),this.sourceH);gl.uniform1i(gl.getUniformLocation(p,'scale'),d.scale);
  this.dirAttach(this.dirBuffers.field.tex,d.w,d.h);
  gl.viewport(x/d.scale,y/d.scale,Math.ceil(w/d.scale),Math.ceil(h/d.scale));gl.drawArrays(gl.TRIANGLES,0,3);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
 }
 async finishDirField(cancelled){
  const d=this.spatialDir,gl=this.gl;
  const source=this.dirBuffers.field.tex,H=this.dirTarget('fieldH',d.w,d.h),A=this.dirTarget('fieldA',d.w,d.h),B=this.dirTarget('fieldB',d.w,d.h);
  let acc=null;
  for(const term of OPT_EXP){
   if(cancelled&&cancelled())throw new Error('已取消');await filmifyYield();
   const k=dirKernel(d.tailUm/(d.um*d.scale)*term[1],term[0]);
   k.clampEdges=d.tailUm/d.um*term[1]>=3;
   if(k.radius>32)throw new Error('空间显影核超出设备预算');
   this.dirBlur(source,H,d.w,d.h,k,1,0,null);
   const dst=acc===A?B:A;this.dirBlur(H,dst,d.w,d.h,k,0,1,acc);acc=dst;
  }
  d.tail=acc;d.ready=true;
  for(const key of ['field','fieldH',acc===A?'fieldB':'fieldA']){gl.deleteTexture(this.dirBuffers[key].tex);delete this.dirBuffers[key];}
 }
 endSpatialDir(){
  const gl=this.gl;
  if(this.dirBuffers)for(const key of Object.keys(this.dirBuffers))gl.deleteTexture(this.dirBuffers[key].tex);
  this.dirBuffers={};this.spatialDir=null;
  if(this.dirFBO)gl.deleteFramebuffer(this.dirFBO);this.dirFBO=null;
  if(this.dirKernelTex)gl.deleteTexture(this.dirKernelTex);this.dirKernelTex=null;
 }
 render(style,evGain,w,h,tileX,tileY,dirOnly){
  this.assertContext();
  if(!this.source)return;
  this.setStyle(style);
  const scat=this.scatter?1:0;
  if(scat){
   /* scatter 段计时(真机探针,与五段埋点同为 CPU 侧墙钟:GL 提交+同步等待,
      不含驱动异步执行尾;engine 在 tile 循环前把 scatterMs 清零) */
   const tSc=performance.now();
   this.scatterPasses(style);
   this.scatterMs=(this.scatterMs||0)+performance.now()-tSc;
  }
  const p=this.programs.main,gl=this.gl,sp=style.film;
  /* Scanner USM weights [center, sigma, 2sigma] normalised; amount from recipe. */
  const usm=(this.scannerUSMEnabled===false)?[0.7,0]:(style.scannerUSM||[0.7,0.7]);
  const sigma=usm[0],amt=usm[1];
  const uw=[1,Math.exp(-.5/(sigma*sigma)),Math.exp(-2/(sigma*sigma))];
  const usum=uw[0]+2*uw[1]+2*uw[2];
  /* 2026-09-21 真机防线（Adreno 830 / Chrome 147 WebView 黑图·假色）：同一 program
     连发两个 draw 时，该驱动会丢失/错位早前写入的 uniform（表现为 USM 双 pass +
     DIR 开时 R 通道读零、蓝调/黑白假色；自检在污染会话中间歇失败，干净会话全过）。
     防线：每个 draw 前把全部纹理绑定与 uniform 完整重发一遍，不依赖跨 draw 状态
     保持；USM pass 间补 gl.flush 强制 TBDR 把 cleanFBO 结果冲出 tile 内存。 */
  const setup=(mode)=>{
   gl.useProgram(p);
   gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.source);gl.uniform1i(gl.getUniformLocation(p,'source'),0);
   gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_3D,this.luts.get('raw'));gl.uniform1i(gl.getUniformLocation(p,'rawLUT'),4);
   gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_3D,this.luts.get('scan'));gl.uniform1i(gl.getUniformLocation(p,'colorLUT'),5);
   gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,this.curves.tex);gl.uniform1i(gl.getUniformLocation(p,'curves'),6);
   const has=this.opticsField?1:0;
   if(has){
    gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,this.opticsField);gl.uniform1i(gl.getUniformLocation(p,'opticsField'),7);
   }
   gl.uniform1i(gl.getUniformLocation(p,'hasOptics'),has);
   this.uniform(p,'opticsTransmission',...(has?this.opticsTransmission:[1,1,1]));
   gl.uniform1i(gl.getUniformLocation(p,'hasScatter'),scat);
   if(scat){
    gl.uniform3f(gl.getUniformLocation(p,'scatCenter'),...this.scatter.center);
    gl.activeTexture(gl.TEXTURE9);gl.bindTexture(gl.TEXTURE_2D,this.scatT0);gl.uniform1i(gl.getUniformLocation(p,'scatRaw'),9);
    gl.activeTexture(gl.TEXTURE10);gl.bindTexture(gl.TEXTURE_2D,this.scatSum);gl.uniform1i(gl.getUniformLocation(p,'scatBlur'),10);
   }
   gl.uniform2i(gl.getUniformLocation(p,'srcCrop'),(mode===1||mode===3)?0:this.sourceCrop.x,(mode===1||mode===3)?0:this.sourceCrop.y);
   // tile offset is also consumed by the grain hash so per-tile noise stays
   // continuous across tile boundaries; must be set even when optics is off.
   gl.uniform2f(gl.getUniformLocation(p,'opticsTileOffset'),(tileX||0)-((mode===1||mode===3)?this.sourceCrop.x:0),(tileY||0)-((mode===1||mode===3)?this.sourceH-this.sourceCrop.y-h:0));
   if(has){
    gl.uniform2f(gl.getUniformLocation(p,'opticsFieldSize'),this.opticsW,this.opticsH);
   }
   this.uniform(p,'rawSize',style.rawSize);this.uniform(p,'lutSize',style.mobileSize);this.uniform(p,'curvesN',this.curves.n);
   this.uniform(p,'lutNearest',this.lutNearest?1:0);
   this.uniform(p,'fieldNearest',this.fieldNearest?1:0);
   this.uniform(p,'outputSize',this.outputWidth||this.canvas.width,this.outputHeight||this.canvas.height);
   this.uniform(p,'tileH',(mode===1||mode===3)?this.sourceH:h);
   gl.uniform1i(gl.getUniformLocation(p,'usmMode'),mode);
   gl.uniform1i(gl.getUniformLocation(p,'scanPacked'),this.scanPacked?1:0);
   const glare=style.glare;
   if(this.glareEnabled!==false&&glare&&glare.percent>0){
    const mean=glare.percent/100;let varFactor=1;
    if(glare.blur>0){
     const radius=Math.floor(3*glare.blur+.5);let total=0,s2=0;
     for(let k=-radius;k<=radius;k++)total+=Math.exp(-.5*k*k/(glare.blur*glare.blur));
     for(let k=-radius;k<=radius;k++){const wgt=Math.exp(-.5*k*k/(glare.blur*glare.blur))/total;s2+=wgt*wgt;}
     varFactor=s2*s2;
    }
    const std=glare.roughness*mean*Math.sqrt(varFactor);
    const gs=Math.sqrt(Math.log(1+(std/mean)*(std/mean)));
    this.uniform(p,'glareAmount',1);this.uniform(p,'glareLognorm',Math.log(mean)-gs*gs/2,gs);
   }else this.uniform(p,'glareAmount',0);
   this.uniform(p,'glareSeed',this.grainSeed||0);
   this.uniform(p,'rawScale',...style.rawScale);this.uniform(p,'densityLow',...style.densityLow);this.uniform(p,'densitySpan',...style.densitySpan);
   const bw=sp.bwCorrection;
   const bwv=Array.isArray(bw)?[bw[0],bw.length>1?bw[1]:bw[0],bw.length>2?bw[2]:bw[0]]:[bw,bw,bw];
   this.uniform(p,'bwCorrection',...bwv);this.uniform(p,'evGain',evGain);
   this.uniform(p,'logLow',this.curves.low);this.uniform(p,'logSpan',this.curves.span);
   this.uniform(p,'positive',sp.positive?1:0);
   /* 逐点 DIR uniforms:按 channels 复制到 vec3(B&W 单通道复制三份);
      correctedCurves 缺失(未重烘的包)时静默按 DIR 关渲染。 */
   const dr=sp.dir;
   const dirOn=dr&&dr.active&&sp.correctedCurves&&sp.matrix&&!this.forceNoDir?1:0;
   gl.uniform1i(gl.getUniformLocation(p,'dirActive'),dirOn);
   const spatial=this.spatialDir&&this.spatialDir.ready&&mode!==3&&dirOn;
   gl.uniform1i(gl.getUniformLocation(p,'hasSpatialDir'),spatial?1:0);
   gl.activeTexture(gl.TEXTURE12);gl.bindTexture(gl.TEXTURE_2D,spatial?this.dirBuffers.core.tex:null);gl.uniform1i(gl.getUniformLocation(p,'dirCoreTex'),12);
   gl.activeTexture(gl.TEXTURE13);gl.bindTexture(gl.TEXTURE_2D,spatial?this.spatialDir.tail:null);gl.uniform1i(gl.getUniformLocation(p,'dirTailTex'),13);
   if(spatial){const d=this.spatialDir;gl.uniform1f(gl.getUniformLocation(p,'dirTailWeight'),d.tailWeight);gl.uniform1f(gl.getUniformLocation(p,'dirFieldScale'),d.scale);gl.uniform2i(gl.getUniformLocation(p,'dirFieldSize'),d.w,d.h);}

   if(dirOn){
    const chs=sp.channels,v3=(a)=>[a[Math.min(0,chs-1)],a[Math.min(1,chs-1)],a[Math.min(chs-1,2)]];
    const mRow=(k)=>k<chs?[sp.matrix[k][Math.min(0,chs-1)],sp.matrix[k][Math.min(1,chs-1)],sp.matrix[k][Math.min(chs-1,2)]]:[0,0,0];
    this.uniform(p,'dirM0',...mRow(0));this.uniform(p,'dirM1',...mRow(1));this.uniform(p,'dirM2',...mRow(2));
    this.uniform(p,'dirDonorK',...v3(sp.donorK));this.uniform(p,'dirDonorRef',...v3(sp.donorRef));
    this.uniform(p,'dirReceiverK',...v3(sp.receiverK));this.uniform(p,'dirReceiverRef',...v3(sp.receiverRef));
    this.uniform(p,'dirDensityMax',...v3(sp.densityMax));
   }
   /* 共享印相表(2026-09-22):sharedPrint=1 时 colorLUT=印相载体全局域表,
      preW=[30] 行主序 3x10 二次预变换(preWj 取每特征一行三通道系数),
      缺失(基准胶卷/黑白印片)=恒等。旧逐组合路径(sharedPrint=0)不受影响。 */
   gl.uniform1i(gl.getUniformLocation(p,'sharedPrint'),style.sharedPrint?1:0);
   const preW=style.preW;
   for(let j=0;j<10;j++){
    const v=preW?[preW[j],preW[10+j],preW[20+j]]
      :(j===1?[1,0,0]:j===2?[0,1,0]:j===3?[0,0,1]:[0,0,0]);
    this.uniform(p,'preW'+j,...v);
   }
   /* 共享直扫表(2026-09-22 下午):sharedScan=1 时 colorLUT=基准反转片全局域表,
      preWC=[60] 行主序 3x20 三次预变换,缺失(基准 Velvia)=恒等。 */
   gl.uniform1i(gl.getUniformLocation(p,'sharedScan'),style.sharedScan?1:0);
   const preWC=style.preWC;
   for(let j=0;j<20;j++){
    const v=preWC?[preWC[j],preWC[20+j],preWC[40+j]]
      :(j===1?[1,0,0]:j===2?[0,1,0]:j===3?[0,0,1]:[0,0,0]);
    this.uniform(p,'preWC'+j,...v);
   }
   if(this.grainStats){
    const g=this.grainStats,expand=a=>[a[0],a[Math.min(1,a.length-1)],a[Math.min(2,a.length-1)]];
    this.uniform(p,'grainLow',...expand(sp.densityMin));
    this.uniform(p,'grainSpan',...expand(sp.densityMax.map((v,k)=>v-sp.densityMin[k])));
    this.uniform(p,'grainAxis',g.t[0],(g.t[8]-g.t[0])/8);
    gl.uniform1i(gl.getUniformLocation(p,'hasGrain'),1);
    gl.uniform1f(gl.getUniformLocation(p,'grainUmScale'),g.umRef/(this.grainUm||8));
    gl.uniform1f(gl.getUniformLocation(p,'grainSeed'),this.grainSeed);
    gl.uniform1i(gl.getUniformLocation(p,'grainMono'),g.channels===1?1:0);
    gl.activeTexture(gl.TEXTURE11);gl.bindTexture(gl.TEXTURE_2D,this.grainTex);gl.uniform1i(gl.getUniformLocation(p,'grainTab'),11);
   }else gl.uniform1i(gl.getUniformLocation(p,'hasGrain'),0);
  };
  gl.bindVertexArray(this.vao);
  const vw=w||this.canvas.width,vh=h||this.canvas.height;
  if(this.spatialDir){
   const tDir=performance.now(),W=this.sourceW,H=this.sourceH;
   const src=this.dirTarget('source',W,H);
   setup(3);this.dirAttach(src,W,H);gl.drawArrays(gl.TRIANGLES,0,3);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.flush();
   if(dirOnly){this.accumulateDirField(tileX,tileY,w,h);this.dirMs+=performance.now()-tDir;return;}
   const hor=this.dirTarget('horizontal',W,H),core=this.dirTarget('core',W,H);
   this.dirBlur(src,hor,W,H,this.spatialDir.core,1,0,null);
   this.dirBlur(hor,core,W,H,this.spatialDir.core,0,1,null);
   this.dirMs+=performance.now()-tDir;
  }
  if(amt>0){
   this.ensureCleanTarget(this.sourceW,this.sourceH);
   setup(1);
   gl.bindFramebuffer(gl.FRAMEBUFFER,this.cleanFBO);
   gl.viewport(0,0,this.sourceW,this.sourceH);
   gl.drawArrays(gl.TRIANGLES,0,3);gl.flush();
   const q=this.programs.scanner;
   gl.useProgram(q);
   gl.activeTexture(gl.TEXTURE8);gl.bindTexture(gl.TEXTURE_2D,this.cleanTex);
   gl.uniform1i(gl.getUniformLocation(q,'scanRGB'),8);
   gl.uniform2i(gl.getUniformLocation(q,'scanSize'),this.sourceW,this.sourceH);
   gl.uniform2i(gl.getUniformLocation(q,'scanCrop'),this.sourceCrop.x,this.sourceCrop.y);
   gl.uniform1i(gl.getUniformLocation(q,'scanPacked'),this.scanPacked?1:0);
   this.uniform(q,'scanWeights',uw[0]/usum,uw[1]/usum,uw[2]/usum);
   this.uniform(q,'scanAmount',amt);this.uniform(q,'scanOffset',tileX||0,tileY||0);this.uniform(q,'scanHeight',h);
  }else setup(0);
  gl.bindFramebuffer(gl.FRAMEBUFFER,this.outFBO||null);
  // viewport(0,0,w,h): gl_FragCoord.xy stays 0..w,0..h so texelFetch(source,..)
  // indexes the tile texture directly. The 2D drawImage rect accounts for the
  // GL lower-left origin (source y offset = backingCanvas.height - rowHeight).
  gl.viewport(0,0,vw,vh);
  gl.drawArrays(gl.TRIANGLES,0,3);
  if(amt>0){gl.activeTexture(gl.TEXTURE8);gl.bindTexture(gl.TEXTURE_2D,null);}
 }
 /* 2026-09-21 真机黑图修复（小红书 WebView / Adreno 830）：部分设备渲染到
    canvas 默认帧缓冲结果为全零（同渲染进 RGBA8 FBO 数值正确）。outFBO 模式
    下最终 pass 改渲染进本 FBO，由引擎 readPixels 取出——完全绕开画布背缓冲
    与 drawImage 快照两条已证实不可靠的路径。 */
 ensureOutTarget(){
  const gl=this.gl,W=this.canvas.width,H=this.canvas.height;
  if(this.outTex&&this.outW===W&&this.outH===H)return;
  if(this.outTex)gl.deleteTexture(this.outTex);
  if(this.outFBO)gl.deleteFramebuffer(this.outFBO);
  const tex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE8);gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,W,H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  const fbo=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('设备无法创建输出缓冲');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.bindTexture(gl.TEXTURE_2D,null);
  this.outTex=tex;this.outFBO=fbo;this.outW=W;this.outH=H;
 }
 /* outFBO 模式开关：开启后 render() 最终 pass 落入 FBO 而非画布。 */
 setOutputFBO(on){
  const gl=this.gl;
  if(on){this.ensureOutTarget();}
  else if(this.outFBO){gl.deleteTexture(this.outTex);gl.deleteFramebuffer(this.outFBO);this.outTex=this.outFBO=null;this.outW=this.outH=0;}
 }
 ensureCleanTarget(W,H){
  const gl=this.gl;
  if(this.cleanTex&&this.cleanW===W&&this.cleanH===H)return;
  if(this.cleanTex)gl.deleteTexture(this.cleanTex);
  if(this.cleanFBO)gl.deleteFramebuffer(this.cleanFBO);
  const tex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE8);gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  this.scanPacked=!(this.caps.colorBufferFloat||this.caps.colorBufferHalfFloat);
  gl.texImage2D(gl.TEXTURE_2D,0,this.scanPacked?gl.RGBA8:gl.RGBA16F,W,H,0,gl.RGBA,this.scanPacked?gl.UNSIGNED_BYTE:gl.HALF_FLOAT,null);
  const fbo=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('设备无法创建锐化缓冲');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  this.cleanTex=tex;this.cleanFBO=fbo;this.cleanW=W;this.cleanH=H;
 }
 setOptics(field){
  this.assertContext();
  const gl=this.gl;
  if(this.opticsField){gl.deleteTexture(this.opticsField);this.opticsField=null;}
  this.opticsTransmission=field&&field.transmission?field.transmission:[1,1,1];
  if(!field)return;
  if(field.texture){this.opticsField=field.texture;this.opticsW=field.w;this.opticsH=field.h;return;}
  const tex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,this.fieldNearest?gl.NEAREST:gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,this.fieldNearest?gl.NEAREST:gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,field.w,field.h,0,gl.RGBA,gl.HALF_FLOAT,field.data);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
  this.opticsField=tex;this.opticsW=field.w;this.opticsH=field.h;
 }
 setGrain(stats,um){
  this.assertContext();
  stats=grainAtScale(stats,um||8);
  this.grainStats=stats||null;this.grainUm=um||8;
  if(!stats)return;
  const mono=stats.channels===1,L=new Float32Array(54);
  for(let i=0;i<9;i++){
   const c=stats.cov[i];
   let l0,l1,l2,l3,l4,l5;
   if(mono){l0=Math.sqrt(Math.max(c[0],0));l1=l2=l3=l4=l5=0;}
   else{
    l0=Math.sqrt(Math.max(c[0],0));
    l1=c[1]/l0;l2=c[2]/l0;
    const d11=c[3]-l1*l1;l3=Math.sqrt(Math.max(d11,0));
    l4=d11>0?(c[4]-l2*l1)/l3:0;
    const d22=c[5]-l2*l2-l4*l4;l5=Math.sqrt(Math.max(d22,0));
   }
   L[i*6]=l0;L[i*6+1]=l1;L[i*6+2]=l2;L[i*6+3]=l3;L[i*6+4]=l4;L[i*6+5]=l5;
  }
  /* 13-tap 核(α,β,γ,δ)与偏斜 λ 由 calibrate-grain.cjs 离线拟合烘进
     stats.kern/stats.skewL(逐档逐通道)。旧数据文件无 kern 时回退到
     等效 S9 混合核:c·δ0+d·[0.25,0.125,0.0625,0] 归一化(行为与旧模型一致)。 */
  const s9fallback=(i,ch)=>{
   const r=Math.max(0.001,Math.min(0.999,mono?stats.corr[i][0]:stats.corr[i][ch]));
   let lo=0,hi=1;
   for(let it=0;it<24;it++){
    const d=(lo+hi)/2,c=Math.sqrt(Math.max(0,1-d*d));
    const cr=(0.25*d*c+0.09375*d*d)/(c*c+0.5*c*d+0.140625*d*d);
    if(cr<r)lo=d;else hi=d;
   }
   const d=(lo+hi)/2,c=Math.sqrt(Math.max(0,1-d*d));
   const k=[c+d*0.25,d*0.125,d*0.0625,0];
   const n=Math.hypot(...k.map((v,j)=>v*Math.sqrt([1,4,4,0][j])));
   return k.map(v=>v/n);
  };
  /* 标定表装进 9×6 RGBA32F 纹理(texelFetch 精确读,无需任何过滤扩展):
     列=i0(0..8);行0=(L0..L3),行1=(L4,L5,_,_),行2/3/4=逐通道核
     (α,β,γ,δ),行5=(λR,λG,λB,_)。
     替代 uniform 数组动态索引——部分 Android GPU 在该路径读垃圾值(2026-09-21 假色)。 */
  const gl=this.gl;
  const tab=new Float32Array(9*6*4);
  for(let i=0;i<9;i++){
   tab[i*4]=L[i*6];tab[i*4+1]=L[i*6+1];tab[i*4+2]=L[i*6+2];tab[i*4+3]=L[i*6+3];
   tab[(9+i)*4]=L[i*6+4];tab[(9+i)*4+1]=L[i*6+5];
   for(let ch=0;ch<3;ch++){
    const k=(stats.kern&&stats.kern[i]&&stats.kern[i][Math.min(ch,mono?0:ch)])||s9fallback(i,ch);
    const row=(18+ch*9+i)*4;
    tab[row]=k[0];tab[row+1]=k[1];tab[row+2]=k[2];tab[row+3]=k[3];
    tab[(45+i)*4+ch]=(stats.skewL&&stats.skewL[i]&&stats.skewL[i][Math.min(ch,mono?0:ch)])||0;
   }
  }
  if(!this.grainTex)this.grainTex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE11);gl.bindTexture(gl.TEXTURE_2D,this.grainTex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,9,6,0,gl.RGBA,gl.FLOAT,tab);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
 }
 // Float32 FFT is required: unnormalised spectra can overflow half floats.
 // The two 1024² RGBA32F ping-pong surfaces peak at 32 MiB and are always freed.
 async diffuseGPU(src,out,w,h,um,ch,opts){
  const gl=this.gl,owned=[];let fbo=null,sync=null;
  const check=()=>{this.assertContext();if(opts.cancelled&&opts.cancelled())throw new Error('已取消');};
  try{
   check();if(!this.caps.colorBufferFloat)throw new Error('GPU FFT needs float32 rendering');
   if(!this.diffProgs)this.diffProgs={};
   for(const [name,frag] of [['init',DIFF_INIT_FRAG],['fft',DIFF_FFT_FRAG],['out',DIFF_OUT_FRAG]])if(!this.diffProgs[name])this.diffProgs[name]=this.program(frag);
   const kernel=await FilmifyMobileOptics.diffusionPSFAsync(w,h,um,ch,opts.cancelled),r=kernel.radius;
   let W=1,H=1;while(W<w+2*r)W*=2;while(H<h+2*r)H*=2;
   if(W>1024||H>1024||W>gl.getParameter(gl.MAX_TEXTURE_SIZE)||H>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw new Error('GPU FFT memory budget');
   const make=(width,height,fmt,data)=>{const t=gl.createTexture();owned.push(t);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,t);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,fmt,width,height,0,fmt===gl.R32F?gl.RED:gl.RGBA,gl.FLOAT,data);return t;};
   let a=make(W,H,gl.RGBA32F,null),b=make(W,H,gl.RGBA32F,null);
   const k=make(2*r+1,2*r+1,gl.R32F,kernel.data);
   this.diffusionPeakBytes=Math.max(this.diffusionPeakBytes||0,2*W*H*16+kernel.data.byteLength);
   fbo=gl.createFramebuffer();
   const bind=(p,name,unit,t)=>{gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);gl.uniform1i(gl.getUniformLocation(p,name),unit);};
   const draw=(p,t,width,height)=>{check();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('GPU FFT framebuffer');
    gl.bindVertexArray(this.vao);gl.viewport(0,0,width,height);gl.drawArrays(gl.TRIANGLES,0,3);gl.bindFramebuffer(gl.FRAMEBUFFER,null);};
   const init=(input,target,multiply)=>{const p=this.diffProgs.init;gl.useProgram(p);bind(p,'src',1,input);bind(p,'kernel',2,k);
    gl.uniform2i(gl.getUniformLocation(p,'size'),w,h);gl.uniform2i(gl.getUniformLocation(p,'fftSize'),W,H);
    gl.uniform1i(gl.getUniformLocation(p,'radius'),r);gl.uniform1i(gl.getUniformLocation(p,'channel'),ch);gl.uniform1i(gl.getUniformLocation(p,'multiply'),multiply);draw(p,target,W,H);};
   const fft=async inverse=>{let passes=0;for(let axis=0;axis<2;axis++)for(let span=2;span<=(axis===0?W:H);span*=2){
    const p=this.diffProgs.fft;gl.useProgram(p);bind(p,'src',1,a);gl.uniform1i(gl.getUniformLocation(p,'axis'),axis);gl.uniform1i(gl.getUniformLocation(p,'span'),span);gl.uniform1i(gl.getUniformLocation(p,'inverse'),inverse);
    draw(p,b,W,H);const t=a;a=b;b=t;
    if(++passes%4===0){gl.flush();await filmifyYield();check();}
   }};
   init(src,a,0);await fft(0);init(a,b,1);{const t=a;a=b;b=t;}await fft(1);
   const p=this.diffProgs.out,amount=FilmifyMobileOptics.diffusionStrength(opts.diffusion);
   gl.useProgram(p);bind(p,'src',1,src);bind(p,'convolved',2,a);gl.uniform1i(gl.getUniformLocation(p,'radius'),r);gl.uniform1i(gl.getUniformLocation(p,'channel'),ch);gl.uniform1f(gl.getUniformLocation(p,'amount'),amount);draw(p,out,w,h);
   sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);if(!sync)throw new Error('GPU FFT fence');gl.flush();
   const deadline=performance.now()+10000;
   for(;;){check();const status=gl.clientWaitSync(sync,0,0);if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)break;
    if(status===gl.WAIT_FAILED||performance.now()>deadline)throw new Error('GPU FFT timeout');await filmifyYield();}
   if(gl.getError()!==gl.NO_ERROR)throw new Error('GPU FFT rendering failed');
   return 1-amount+amount*kernel.data[r*(2*r+1)+r];
  }finally{if(sync)gl.deleteSync(sync);gl.bindFramebuffer(gl.FRAMEBUFFER,null);if(fbo)gl.deleteFramebuffer(fbo);for(const t of owned)gl.deleteTexture(t);}
 }
 ensureOpticsPrograms(){
  if(this.optProgs)return;
  const gl=this.gl;
  this.optFBO=gl.createFramebuffer();
  this.optProgs={
   raw:this.program(OPT_RAW_FRAG),
   gauss:this.program(OPT_GAUSS_FRAG),
   gaussR:this.program(OPT_GAUSS_R_FRAG),
   combine:this.program(OPT_COMBINE_FRAG)
  };
 }
 /* GPU optical delta field for one image+stock. Returns {texture,w,h} (an
    RGBA16F texture owned by the renderer, row 0 = source top) or null when
    the GPU path is unavailable / out of scope (halation off, missing float
    render extension, a sigma>=3 kernel, or any GL failure) — the caller then
    runs the CPU buildField, so a GPU failure never degrades the field. */
 async buildOpticsGPU(source,style,field,opts){
  this.assertContext();
  const gl=this.gl;
  if(!this.optFloatRenderOK){
   const ext=gl.getExtension('EXT_color_buffer_float')||gl.getExtension('EXT_color_buffer_half_float');
   if(!ext)return null;
   this.optFloatRenderOK=true;
  }
  opts=opts||{};const diffusion=opts.diffusion>0;
  if(diffusion&&!this.caps.colorBufferFloat){try{window.FILMIFY_DIAG.gpuOpticsFallback='GPU FFT requires float32 rendering';}catch(ignored){}return null;}
  const fp=style.film,hal=Object.assign({},fp.halation,{scatter_amount:0});
  // 2026-09-21: field is halation-only; small-scale scatter runs full-res in
  // the tile passes (sub-pixel at field resolution — it vanished there).
  if(!hal.active&&!diffusion)return null;
  if(!style.rawValues||!this.luts.get('raw'))return null;
  const channels=fp.channels;
  const sw=source.naturalWidth||source.width,sh=source.naturalHeight||source.height;
  if(!sw||!sh||field<=0)return null;
  const longEdge=Math.max(sw,sh),scale=field/longEdge;
  const fw=Math.max(2,Math.round(sw*scale)),fh=Math.max(2,Math.round(sh*scale));
  const fieldUm=((opts&&opts.filmFormatMm)||fp.cameraFilmFormatMm||35)*1000/field;
  const s=hal.scatter_amount||0,ss=hal.scatter_spatial_scale||1,hs=hal.halation_spatial_scale||1;
  const nB=hal.halation_n_bounces||0,decay=hal.halation_bounce_decay||0;
  // Per-channel kernel lists; IIR (sigma>=3) is not replicated on GPU.
  const chans=[];
  for(let ch=0;ch<channels;ch++){
   const kernels=[];
   if(s>0){
    kernels.push({k:'core',sigma:Math.max(1e-6,hal.scatter_core_um[ch]*ss/fieldUm)});
    for(const [a,r] of OPT_EXP)kernels.push({k:'tail',sigma:Math.max(1e-6,hal.scatter_tail_um[ch]*ss/fieldUm)*r,a:a});
   }
   const strength=hal.active&&opts.halation!==false?hal.halation_strength[ch]*hal.halation_amount:0;
   if(strength>0){
    let total=0;for(let i=0;i<nB;i++)total+=Math.pow(decay,i);
    for(let k=1;k<=nB;k++)kernels.push({k:'hal',sigma:hal.halation_first_sigma_um[ch]*hs*Math.sqrt(k)/fieldUm,w:Math.pow(decay,k-1)/total});
   }
   for(const k of kernels)if(k.sigma>=3)return null;
   chans.push({kernels:kernels,strength:strength,norm:hal.halation_renormalize?1+strength:1,
    tail:(hal.scatter_tail_weight&&hal.scatter_tail_weight[ch])||0});
  }
  this.ensureOpticsPrograms();
  // Downsample to field size — identical draw to CPU buildField.
  const c=document.createElement('canvas');c.width=fw;c.height=fh;
  const ctx=c.getContext('2d',{colorSpace:'srgb'});
  const owned=[];let kept=null;
  const mkTex=(fmt)=>{
   const t=gl.createTexture();owned.push(t);
   gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,t);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   gl.texImage2D(gl.TEXTURE_2D,0,fmt,fw,fh,0,(fmt===gl.R16F||fmt===gl.R32F)?gl.RED:gl.RGBA,fmt===gl.RGBA16F?gl.HALF_FLOAT:gl.FLOAT,null);
   return t;
  };
  const srcTex=gl.createTexture();owned.push(srcTex);
  try{
  if(!ctx)throw new Error('GPU optics source canvas unavailable');
  ctx.drawImage(source,0,0,fw,fh);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,srcTex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  const cs=gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,c);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,cs);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
  c.width=c.height=1;
  // FFT input and halation following diffusion retain float32. Halation-only
  // still supports RGBA16F on half-float-only devices. The exported additive
  // field remains RGBA16F on both paths for the existing tile consumer.
  const fmt=diffusion?gl.RGBA32F:gl.RGBA16F;
  const T0=mkTex(fmt),A=mkTex(fmt),B=mkTex(fmt),H1=mkTex(fmt),H2=mkTex(fmt),C1=mkTex(fmt),C2=mkTex(fmt);
  const transmission=[1,1,1];
  const FBO=this.optFBO;
  // (debug readback hooks removed; validation uses its own FLOAT readback —
  // readPixels(HALF_FLOAT) on RGBA16F returns INVALID_OPERATION on this ANGLE)
  const attach=(t,fmt)=>{gl.bindFramebuffer(gl.FRAMEBUFFER,FBO);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
   if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('GPU 光学场缓冲不完整');};
  const bind=(u,t)=>{gl.activeTexture(gl.TEXTURE0+u);gl.bindTexture(gl.TEXTURE_2D,t);};
  const draw=(prog)=>{gl.useProgram(prog);gl.bindVertexArray(this.vao);gl.viewport(0,0,fw,fh);gl.drawArrays(gl.TRIANGLES,0,3);
   // Unbind the FBO right after each pass: the next pass samples the texture we
   // just wrote (e.g. gauss horizontal reads the vertical output). Keeping it
   // attached makes the same texture both bound and a draw attachment → feedback
   // loop → INVALID_OPERATION (glError 1282, seen in dist smoke).
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);};
  const gauss=(sigma,ch,inTex)=>{
   const k=optKernel(sigma),p=this.optProgs.gauss,pR=this.optProgs.gaussR;
   gl.useProgram(p);bind(1,inTex);
   gl.uniform1i(gl.getUniformLocation(p,'src'),1);
   gl.uniform1i(gl.getUniformLocation(p,'axis'),0);
   gl.uniform1i(gl.getUniformLocation(p,'channel'),ch);
   gl.uniform1fv(gl.getUniformLocation(p,'uW'),k.weights);
   attach(A,gl.RGBA16F);draw(p);
   gl.useProgram(pR);bind(1,A);
   gl.uniform1i(gl.getUniformLocation(pR,'src'),1);
   gl.uniform1i(gl.getUniformLocation(pR,'axis'),1);
   gl.uniform1fv(gl.getUniformLocation(pR,'uW'),k.weights);
   attach(B,gl.RGBA16F);draw(pR);
   return B;
  };
  const combine=(mode,ch,tex0,tex1,tex2,outTex,fmt,sc)=>{
   const p=this.optProgs.combine;
   gl.useProgram(p);bind(1,tex0);bind(2,tex1);bind(3,tex2||tex0);
   gl.uniform1i(gl.getUniformLocation(p,'tex0'),1);
   gl.uniform1i(gl.getUniformLocation(p,'tex1'),2);
   gl.uniform1i(gl.getUniformLocation(p,'tex2'),3);
   gl.uniform1i(gl.getUniformLocation(p,'mode'),mode);
   gl.uniform1i(gl.getUniformLocation(p,'channel'),ch);
   gl.uniform1f(gl.getUniformLocation(p,'s'),sc.s||0);
   gl.uniform1f(gl.getUniformLocation(p,'tail'),sc.tail||0);
   gl.uniform1f(gl.getUniformLocation(p,'gain'),sc.gain||0);
   gl.uniform1f(gl.getUniformLocation(p,'strength'),sc.strength||0);
   gl.uniform1f(gl.getUniformLocation(p,'norm'),sc.norm||1);
   gl.uniform3fv(gl.getUniformLocation(p,'transmission'),transmission);
   attach(outTex,fmt);draw(p);
  };
   attach(T0,gl.RGBA16F); // renderability proof + raw target
   const pRaw=this.optProgs.raw;
   gl.useProgram(pRaw);bind(1,srcTex);
   gl.uniform1i(gl.getUniformLocation(pRaw,'source'),1);
   gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_3D,this.luts.get('raw'));
   gl.uniform1i(gl.getUniformLocation(pRaw,'rawLUT'),2);
   gl.uniform1f(gl.getUniformLocation(pRaw,'rawSize'),style.rawSize);
   gl.uniform3fv(gl.getUniformLocation(pRaw,'rawScale'),style.rawScale);
   draw(pRaw);

   // current = T0 baseline, then per-channel optics update .ch only.
   combine(0,0,T0,T0,T0,C1,gl.RGBA16F,{});
   let cur=C1,other=C2;
   this.diffusionPeakBytes=0;this.opticsPeakBytes=fw*fh*(7*(diffusion?16:8)+4);
   if(diffusion)for(let ch=0;ch<channels;ch++){
    transmission[ch]=await this.diffuseGPU(cur,other,fw,fh,fieldUm,ch,opts);
    const t=cur;cur=other;other=t;
   }
   this.opticsPeakBytes+=this.diffusionPeakBytes;
   for(let ch=0;ch<channels;ch++){
    const cc=chans[ch];
    if(s>0){
     const core=cc.kernels.find(k=>k.k==='core');
     const G=gauss(core.sigma,ch,T0);
     combine(1,ch,T0,G,cur,other,gl.RGBA16F,{s:s,tail:cc.tail});
     let tmp=cur;cur=other;other=tmp;
     for(const k of cc.kernels){
      if(k.k!=='tail')continue;
      const Gt=gauss(k.sigma,ch,T0);
      combine(2,ch,cur,Gt,T0,other,gl.RGBA16F,{gain:s*cc.tail*k.a});
      tmp=cur;cur=other;other=tmp;
     }
    }
    if(cc.strength>0){
     let H=H1;
     attach(H,gl.RGBA16F);
     gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
     for(const k of cc.kernels){
      if(k.k!=='hal')continue;
      const G=gauss(k.sigma,ch,cur);
      const Hout=(H===H1)?H2:H1;
      combine(3,ch,H,G,T0,Hout,gl.RGBA16F,{gain:k.w});
      H=Hout;
     }
     combine(4,ch,cur,H,T0,other,gl.RGBA16F,{strength:cc.strength,norm:cc.norm});
     const tmp=cur;cur=other;other=tmp;
    }
   }
   this.opticsPeakBytes=Math.max(this.opticsPeakBytes,fw*fh*(7*(diffusion?16:8)+8+4));
   const fieldTex=mkTex(gl.RGBA16F);
   combine(5,0,cur,T0,T0,fieldTex,gl.RGBA16F,{});
   gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,fieldTex);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,this.fieldNearest?gl.NEAREST:gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,this.fieldNearest?gl.NEAREST:gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   if(gl.getError()!==gl.NO_ERROR)throw new Error('GPU optics rendering failed');
   kept=fieldTex;
   return {texture:fieldTex,w:fw,h:fh,transmission:transmission,diffusionGPU:diffusion};
  }catch(error){
   if(opts.cancelled&&opts.cancelled())throw error;
   try{window.FILMIFY_DIAG.gpuOpticsFallback=String(error.message||error);}catch(ignored){}
   if(window.__OPTERR)console.error('GPU optics fail:',error&&error.message,'glerr',gl.getError());
   return null;
  }finally{
   c.width=c.height=1;gl.bindFramebuffer(gl.FRAMEBUFFER,null);
   for(const t of owned)if(t!==kept)gl.deleteTexture(t);
  }
 }

 /* Read back an RGBA16F field texture as float32 (row 0 = texture row 0 =
    source top). Returns Float32Array(w*h*4) or null on any GL failure.
    readPixels must use gl.FLOAT: HALF_FLOAT readback of RGBA16F raises
    INVALID_OPERATION on ANGLE and leaves the buffer zeroed. */
 readFieldPixels(field){
  const gl=this.gl;
  const fbo=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,field.texture,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);return null;
  }
  const out=new Float32Array(field.w*field.h*4);
  gl.readPixels(0,0,field.w,field.h,gl.RGBA,gl.FLOAT,out);
  const err=gl.getError();
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);
  return err===gl.NO_ERROR?out:null;
 }
 /* Colour-core self-check (2026-09-21, added after a real Android device
    rendered velvia as cyan/green false colour while desktop passed every
    gate). Renders 8 known sRGB pixels through the REAL shader path (source
    upload → raw LUT → curves → scan LUT → dither → RGBA8 framebuffer) with
    optics/grain/USM/glare off, reads the framebuffer back, and compares
    against a pure-JS evaluation of the same numerics (sampleTable is shared
    with FilmifyMobileOptics). A driver that silently breaks any of those
    stages fails loudly here instead of shipping a psychedelic photo.
    Tolerance 5/255 covers 8-bit rounding + ±0.5 LSB dither + RGB16F LUT
    rounding; real corruption is off by 100+/255.
    Caller contract: run before setOptics for the photo (opticsField null). */
 selfCheckCore(style){
  const gl=this.gl;
  const colors=[[0,0,0],[255,255,255],[128,128,128],[200,60,40],[40,160,60],[40,80,190],[220,190,160],[30,40,60]];
  const tile=document.createElement('canvas');tile.width=8;tile.height=2;
  const tctx=tile.getContext('2d');
  for(let y=0;y<2;y++)for(let x=0;x<8;x++){
   tctx.fillStyle='rgb('+colors[x][0]+','+colors[x][1]+','+colors[x][2]+')';
   tctx.fillRect(x,y,1,1);
  }
  const saved={grain:this.grainStats,grainUm:this.grainUm,usm:this.scannerUSMEnabled,seed:this.grainSeed,glare:this.glareEnabled,scat:this.scatter};
  let got=null,err=0;
  try{
   this.grainStats=null;this.scannerUSMEnabled=false;this.grainSeed=0;this.glareEnabled=false;this.scatter=null;
   this.setSource(tile);
   this.render(style,1,8,2,0,0);
   got=new Uint8Array(8*4);
   gl.readPixels(0,0,8,1,gl.RGBA,gl.UNSIGNED_BYTE,got);
   err=gl.getError();
  }catch(error){return {ok:false,detail:'exception:'+(error&&error.message)};}
  finally{
   this.grainStats=saved.grain;this.grainUm=saved.grainUm;this.scannerUSMEnabled=saved.usm;this.grainSeed=saved.seed;this.glareEnabled=saved.glare;this.scatter=saved.scat;
   tile.width=tile.height=1;
  }
  if(err!==gl.NO_ERROR)return {ok:false,detail:'glError='+err};
  if(!got)return {ok:false,detail:'no-readback'};
  const fp=style.film,axis=fp.logExposure,N=axis.length,lo=axis[0],span=axis[N-1]-lo;
  const bw=fp.bwCorrection;
  const bwv=Array.isArray(bw)?[bw[0],bw.length>1?bw[1]:bw[0],bw.length>2?bw[2]:bw[0]]:[bw,bw,bw];
  const TOL=5;
  const dirOn=fp.dir&&fp.dir.active&&fp.correctedCurves&&fp.matrix;
  const interpC=(table,ch,x)=>{
   const idx=(x-lo)/span*(N-1);
   const i0=Math.max(0,Math.min(N-2,Math.floor(idx)));
   const f=Math.max(0,Math.min(1,idx-i0));
   const cv=table[Math.min(ch,fp.channels-1)];
   return cv[i0]+(cv[i0+1]-cv[i0])*f;
  };
  const v3=(a)=>[a[Math.min(0,fp.channels-1)],a[Math.min(1,fp.channels-1)],a[Math.min(fp.channels-1,2)]];
  for(let px=0;px<8;px++){
   const c=colors[px];
   // Pure-JS evaluation of the shader numerics for one pixel (evGain=1).
   const raw=FilmifyMobileOptics.sampleTable(style.rawValues,style.rawSize,c[0]/255,c[1]/255,c[2]/255);
   const logv=[0,0,0];let d=[0,0,0];
   for(let ch=0;ch<3;ch++){
    logv[ch]=Math.log(Math.max(raw[ch]*style.rawScale[ch]*bwv[ch],0)+1e-10)/Math.LN10;
    d[ch]=interpC(fp.curves,ch,logv[ch]);
   }
   if(dirOn){
    // 逐点 DIR 镜像(native dir()):donor→matrix→correction→correctedCurves
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
    // 共享印相表镜像:W 二次预变换 + 全局域 [-0.45,3.55](与 shader 同式)
    const W=style.preW; // [30] 行主序 3x10 或 null=恒等
    const w=[0,0,0];
    for(let ch=0;ch<3;ch++){
     if(!W){w[ch]=d[ch];continue;}
     const f=[1,d[0],d[1],d[2],d[0]*d[0],d[1]*d[1],d[2]*d[2],d[0]*d[1],d[0]*d[2],d[1]*d[2]];
     let acc=0;for(let j=0;j<10;j++)acc+=W[ch*10+j]*f[j];
     w[ch]=acc;
    }
    for(let ch=0;ch<3;ch++)t[ch]=Math.max(0,Math.min(1,(w[ch]+0.45)*0.25));
   }else if(style.sharedScan){
    // 共享直扫表镜像:W 三次预变换(3x20,与 shader preWC 同序)+ 全局域
    const W=style.preWC; // [60] 行主序 3x20 或 null=恒等(基准 Velvia)
    const f=[1,d[0],d[1],d[2],d[0]*d[0],d[1]*d[1],d[2]*d[2],d[0]*d[1],d[0]*d[2],d[1]*d[2],
             d[0]**3,d[1]**3,d[2]**3,d[0]*d[0]*d[1],d[0]*d[0]*d[2],d[1]*d[1]*d[0],d[1]*d[1]*d[2],
             d[2]*d[2]*d[0],d[2]*d[2]*d[1],d[0]*d[1]*d[2]];
    const w=[0,0,0];
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
   for(let ch=0;ch<3;ch++){
    const w=Math.round(want[ch]*255),g=got[px*4+ch];
    if(Math.abs(g-w)>TOL){
     return {ok:false,detail:'px'+px+'.'+'RGB'[ch]+' got '+g+' want '+w};
    }
   }
  }
  return {ok:true};
 }
 /* 全特性探针（2026-09-21 真机黑图教训）：selfCheckCore 为隔离变量显式关掉
    grain/glare/USM——而这些阶段在真机驱动上静默出错（mediump uint 折叠整数
    hash → glare 段加 +Inf → 整帧全黑）时核心自检照样全绿，黑图直接到用户
    手里。本探针用调用方已就位的真实配置（grain/glare/USM 按配方默认全开，
    scatter/光学场临时摘除以隔离已知有各自守卫的阶段）渲染同一 8 像素，
    只断言「画面活着」：最亮像素三通道和落在 (24,756) 开区间——全零
    （NaN→0）或全 255（Inf）都拦截。不比对参考值：颗粒/眩光带随机性，
    防的是整帧暴毙而非回归精度。由 engine 在完整配置就位后、每款配方首次
    显影时调用一次。 */
 selfCheckEffects(style){
  const gl=this.gl;
  const colors=[[0,0,0],[255,255,255],[128,128,128],[200,60,40],[40,160,60],[40,80,190],[220,190,160],[30,40,60]];
  const tile=document.createElement('canvas');tile.width=8;tile.height=2;
  const tctx=tile.getContext('2d');
  for(let y=0;y<2;y++)for(let x=0;x<8;x++){
   tctx.fillStyle='rgb('+colors[x][0]+','+colors[x][1]+','+colors[x][2]+')';
   tctx.fillRect(x,y,1,1);
  }
  const saved={scat:this.scatter,opt:this.opticsField};
  let got=null,err=0;
  try{
   this.scatter=null;this.opticsField=null;
   this.setSource(tile);
   this.render(style,1,8,2,0,0);
   got=new Uint8Array(8*4);
   gl.readPixels(0,0,8,1,gl.RGBA,gl.UNSIGNED_BYTE,got);
   err=gl.getError();
  }catch(error){return {ok:false,detail:'effects exception:'+(error&&error.message)};}
  finally{
   this.scatter=saved.scat;this.opticsField=saved.opt;
   tile.width=tile.height=1;
  }
  if(err!==gl.NO_ERROR)return {ok:false,detail:'effects glError='+err};
  /* 均匀性判定：故障模式是整帧 +Inf/NaN（8 像素全灭/全爆），单个像素合法
     极值（如 trix 白点可达 255）不拦截——故死帧看最亮像素、爆帧看最暗像素。 */
  let mx=0,mn=765;
  for(let i=0;i<8;i++){const l=got[i*4]+got[i*4+1]+got[i*4+2];if(l>mx)mx=l;if(l<mn)mn=l;}
  if(mx<=24)return {ok:false,detail:'effects frame dead, max='+mx};
  if(mn>=756)return {ok:false,detail:'effects frame blown, min='+mn};
  return {ok:true,max:mx,min:mn};
 }
 dispose(){
  if(this.disposed)return;this.disposed=true;
  this.endSpatialDir();if(this.dirDownProgram)this.gl.deleteProgram(this.dirDownProgram);this.dirDownProgram=null;
  if(this.canvas){this.canvas.removeEventListener('webglcontextlost',this.onContextLost);this.canvas.removeEventListener('webglcontextrestored',this.onContextRestored);}
  for(const entry of this.lutCache.values()){this.gl.deleteTexture(entry.raw);this.gl.deleteTexture(entry.scan);this.gl.deleteTexture(entry.curves.tex);}
  this.lutCache.clear();this.releaseStyle();
  if(this.opticsField){this.gl.deleteTexture(this.opticsField);this.opticsField=null;}
  if(this.cleanTex){this.gl.deleteTexture(this.cleanTex);this.cleanTex=null;}
  if(this.cleanFBO){this.gl.deleteFramebuffer(this.cleanFBO);this.cleanFBO=null;}
  if(this.outTex){this.gl.deleteTexture(this.outTex);this.outTex=null;}
  if(this.outFBO){this.gl.deleteFramebuffer(this.outFBO);this.outFBO=null;}
  for(const t of [this.scatT0,this.scatH,this.scatB,this.scatA,this.scatKern])if(t)this.gl.deleteTexture(t);
  this.scatT0=this.scatH=this.scatB=this.scatA=this.scatKern=null;this.scatter=null;
  if(this.scatFBO){this.gl.deleteFramebuffer(this.scatFBO);this.scatFBO=null;}
  if(this.optProgs)for(const pr of Object.values(this.optProgs))this.gl.deleteProgram(pr);
  this.optProgs=null;
  if(this.diffProgs)for(const pr of Object.values(this.diffProgs))this.gl.deleteProgram(pr);this.diffProgs=null;
  if(this.optFBO){this.gl.deleteFramebuffer(this.optFBO);this.optFBO=null;}
  this.grainStats=null;
  if(this.grainTex){this.gl.deleteTexture(this.grainTex);this.grainTex=null;}
  if(this.source)this.gl.deleteTexture(this.source);this.source=null;
  for(const pr of Object.values(this.programs))this.gl.deleteProgram(pr);
  this.programs={};if(this.buffer)this.gl.deleteBuffer(this.buffer);if(this.vao)this.gl.deleteVertexArray(this.vao);
 }
}
return {Renderer:Renderer,scatterKernels:scatterKernels,grainAtScale:grainAtScale};

})();
if(typeof module!=='undefined')module.exports=FilmifyMobile;
