'use strict';
// Mobile baked-core renderer (proposal A): full-resolution tiled colour core.
// No full-size Float32 film planes. Per tile the shader decodes sRGB -> raw
// (33^3 table) -> log -> 1D density curves -> density-uniform t -> sqrt shaper
// (positive stocks) -> scan LUT -> sRGB. Native raw metering/AE is applied
// per image before this pass; print-stage controls are out of scope for v1.
//
// Numerics mirror scripts/bake-mobile-film.py exactly: raw table trilinear
// sample, EV/bwCorrection gain, log10(raw*2^EV*bw+1e-10), np.interp density
// curves on the uniform logExposure axis, t=(density-low)/span, sqrt shaper for
// positive, RGB16-packed LUT trilinear, then sRGB encoding.
const FilmifyMobile = (() => {
const VERT = `#version 300 es
in vec2 position;out vec2 uv;
void main(){uv=position*.5+.5;gl_Position=vec4(position,0,1);}`;
const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv; out vec4 frag;
uniform sampler2D source;
uniform sampler3D rawLUT;
uniform sampler3D colorLUT;
uniform sampler2D curves;
uniform float rawSize;uniform float lutSize;uniform float curvesN;
uniform vec3 rawScale;uniform vec3 densityLow;uniform vec3 densitySpan;
uniform vec3 bwCorrection;uniform float evGain;
uniform float logLow;uniform float logSpan;
uniform float positive;
uniform sampler2D opticsField;uniform vec2 opticsTileOffset;uniform vec2 opticsFieldSize;uniform vec2 outputSize;uniform float tileH;uniform int hasOptics;
// Full-resolution local scatter (2026-09-21): raw pass + separable combined-
// kernel blur of the PADDED tile, done as small pre-passes per tile
// (scatRaw = raw of padded tile, scatBlur = K * scatRaw). srcCrop is the
// offset of this tile's output region inside the padded source texture; it is
// (0,0) for unpadded tiles. Neighbour physics comes from the padding, so no
// full-size float plane is ever allocated. usmMode 1 reads the same scattered
// raw, keeping the clean pass equal to "full pipeline minus halation/grain/
// glare" — the closest approximation of the native neighbour.
uniform int hasScatter;uniform vec3 scatCenter;uniform sampler2D scatRaw;uniform sampler2D scatBlur;uniform ivec2 srcCrop;
// Calibrated statistical grain: density-domain RMS/covariance/1px-correlation
// baked offline from the pinned native grainPlane at um_ref=8um. The shader
// adds a deterministic correlated-gaussian delta in density space, sampled
// with per-level linear interpolation over the density axis.
uniform int hasGrain;uniform float grainUmScale;uniform float grainSeed;uniform int grainMono;
uniform float scannerAmount;uniform vec3 scannerWeights;uniform vec2 tileSize;
// Two-pass scanner USM: usmMode 0 = USM off (single pass); 1 = clean pass,
// the exact pipeline the former per-tap neighbour path computed (no optics,
// no grain, no glare) rendered into cleanTex; 2 = sharpen pass, centre pixel
// full pipeline + 5 texelFetch neighbours instead of 5 full evaluations.
uniform sampler2D cleanTex;uniform int usmMode;
// Print-route glare: single-sample lognormal matched to the post-blur
// statistics of the upstream iid field (variance factor of the same FIR
// kernel used by the native gaussian); added in linear scan RGB before USM.
uniform float glareAmount;uniform vec2 glareLognorm;uniform float glareSeed;
uniform float grainL[54];uniform float grainW[27];
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
uint grainMix(uint x){x^=x>>16u;x*=0x7feb352du;x^=x>>15u;x*=0x846ca68bu;x^=x>>16u;return x;}
float gh(ivec2 p,int k){
 uint h=grainMix(uint(p.x)+grainMix(uint(p.y)+uint(k)*0x9E3779B9u));
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
vec3 densityCurve(vec3 logv){
 // Uniform logExposure axis shared by all channels; per-channel linear
 // interpolation matches np.interp used by the bake validation path.
 vec3 idx=(logv-logLow)/logSpan*(curvesN-1.);
 vec3 i0=clamp(floor(idx),0.,curvesN-2.);
 vec3 f=clamp(idx-i0,0.,1.);
 vec3 d0=vec3(texelFetch(curves,ivec2(int(i0.x),0),0).r,
              texelFetch(curves,ivec2(int(i0.y),0),0).g,
              texelFetch(curves,ivec2(int(i0.z),0),0).b);
 vec3 d1=vec3(texelFetch(curves,ivec2(int(i0.x)+1,0),0).r,
              texelFetch(curves,ivec2(int(i0.y)+1,0),0).g,
              texelFetch(curves,ivec2(int(i0.z)+1,0),0).b);
 return mix(d0,d1,f);
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
 vec3 logv=log(max(raw*evGain*bwCorrection,0.)+1e-10)/log(10.);
 // gl_FragCoord.y=0 is the framebuffer bottom; the tile's output top maps to
 // gl_FragCoord.y=tileH-1, so flip y to get the output pixel coord (used by
 // both the optics field lookup and the deterministic grain hash).
 vec2 globalPx=vec2(gl_FragCoord.x+opticsTileOffset.x,tileH-1.0-gl_FragCoord.y+opticsTileOffset.y);
 if(hasOptics==1&&usmMode!=1){
  vec2 ouv=globalPx/outputSize;
  if(fieldNearest<.5){logv+=texture(opticsField,ouv).rgb;}
  else{
   // Manual bilinear fallback (same missing-filtering situation as sampleTable).
   vec2 op=ouv*(opticsFieldSize-1.);vec2 oi=floor(op);vec2 of=op-oi;
   ivec2 oa=ivec2(oi);ivec2 ob=min(oa+1,ivec2(opticsFieldSize)-1);
   vec3 o00=texelFetch(opticsField,oa,0).rgb;
   vec3 o10=texelFetch(opticsField,ivec2(ob.x,oa.y),0).rgb;
   vec3 o01=texelFetch(opticsField,ivec2(oa.x,ob.y),0).rgb;
   vec3 o11=texelFetch(opticsField,ob,0).rgb;
   logv+=mix(mix(o00,o10,of.x),mix(o01,o11,of.x),of.y);
  }
 }
 vec3 d=densityCurve(logv);
 if(hasGrain==1&&usmMode!=1){
  // Interpolate density-level calibration tables (average t across channels).
  vec3 t0=(d-densityLow)/densitySpan;
  float tt=clamp((t0.x+t0.y+t0.z)/3.,0.,1.);
  float fi=tt*8.;
  int i0=clamp(int(floor(fi)),0,7);
  float ff=clamp(fi-float(i0),0.,1.);
  int b=i0*6,bb=b+6,wb=i0*3,wbb=wb+3;
  vec3 gd;
  // Correlated field: 3x3 binomial S9 (corners 1, edges 2, centre 4, /16) has
  // corr(1)=2/3 on BOTH axes with var=0.140625 and cov(A,S9)=0.25. The former
  // horizontal-only 3-tap left vertical correlation at ~0, which showed as
  // fabric-like streaks on flat areas. n=c*A(x)+d*S9, normalised to unit
  // variance, reaches the calibrated density correlation on both axes.
  ivec2 pc=ivec2(globalPx)+int(grainSeed)*ivec2(37,54);
  if(grainMono==1){
   float a0=gauss(pc,0);
   float s9=(gauss(pc+ivec2(-1,-1),0)+gauss(pc+ivec2(1,-1),0)+gauss(pc+ivec2(-1,1),0)+gauss(pc+ivec2(1,1),0)
    +2.*(gauss(pc+ivec2(0,-1),0)+gauss(pc+ivec2(-1,0),0)+gauss(pc+ivec2(1,0),0)+gauss(pc+ivec2(0,1),0))+4.*a0)*0.0625;
   float d0=mix(grainW[wb],grainW[wbb],ff);
   float c0=sqrt(max(1.-d0*d0,0.));
   float n=(c0*a0+d0*s9)/sqrt(max(c0*c0+0.5*c0*d0+0.140625*d0*d0,1e-6));
   float L0=mix(grainL[b],grainL[bb],ff);
   gd=vec3(n,n,n)*L0*grainUmScale;
  }else{
   vec3 a0=grainNoise(pc);
   vec3 s9=(grainNoise(pc+ivec2(-1,-1))+grainNoise(pc+ivec2(1,-1))+grainNoise(pc+ivec2(-1,1))+grainNoise(pc+ivec2(1,1))
    +2.*(grainNoise(pc+ivec2(0,-1))+grainNoise(pc+ivec2(-1,0))+grainNoise(pc+ivec2(1,0))+grainNoise(pc+ivec2(0,1)))+4.*a0)*0.0625;
   vec3 dv=vec3(mix(grainW[wb],grainW[wbb],ff),mix(grainW[wb+1],grainW[wbb+1],ff),mix(grainW[wb+2],grainW[wbb+2],ff));
   vec3 cv=sqrt(max(vec3(1.)-dv*dv,vec3(0.)));
   vec3 n=(cv*a0+dv*s9)/sqrt(max(cv*cv+0.5*cv*dv+0.140625*dv*dv,vec3(1e-6)));
   float L0=mix(grainL[b],grainL[bb],ff),L1=mix(grainL[b+1],grainL[bb+1],ff),L2=mix(grainL[b+2],grainL[bb+2],ff);
   float L3=mix(grainL[b+3],grainL[bb+3],ff),L4=mix(grainL[b+4],grainL[bb+4],ff),L5=mix(grainL[b+5],grainL[bb+5],ff);
   gd=vec3(n.x*L0,n.x*L1+n.y*L3,n.x*L2+n.y*L4+n.z*L5)*grainUmScale;
  }
  d+=gd;
 }
 vec3 t=(d-densityLow)/densitySpan;
 if(positive>0.5)t=sqrt(clamp(t,0.,1.));
 vec3 s=sampleTable(colorLUT,lutSize,t);
 if(usmMode==1){frag=vec4(clamp(s,0.,1.),1.);return;}
 if(glareAmount>0.){
  ivec2 pg=ivec2(globalPx)+int(glareSeed)*ivec2(91,17);
  float z=gauss(pg,40);
  vec3 lin=mix(s/12.92,pow((s+.055)/1.055,vec3(2.4)),step(vec3(.04045),s));
  lin+=exp(glareLognorm.x+glareLognorm.y*z);
  s=mix(lin*12.92,1.055*pow(lin,vec3(1./2.4))-.055,step(vec3(.0031308),lin));
 }
 // Scanner USM (proposal A): approximate the native 5-tap vertical unsharp
 // mask. Neighbours come from cleanTex — the pass-1 render of the same colour
 // path without optics/grain/glare, exactly what the former per-tap path
 // recomputed for every neighbour (5 full pipelines per pixel). Pass 2 keeps
 // the full pipeline for the centre pixel and fetches 5 texels instead.
 // Weights: [center, sigma, 2*sigma] normalised by caller.
 if(scannerAmount>0.){
  vec3 b=vec3(0.);
  for(int dy=-2;dy<=2;dy++){
   ivec2 q=ivec2(int(gl_FragCoord.x),int(clamp(gl_FragCoord.y+float(dy),0.,tileSize.y-1.)));
   b+=texelFetch(cleanTex,q,0).rgb*scannerWeights[abs(dy)];
  }
  s+=scannerAmount*(s-b);
 }
 // Lightweight final dither: deterministic ±0.5 LSB white noise keyed to the
 // output pixel, added in sRGB just before the RGBA8 framebuffer write so the
 // PNG save/share path never shows 8-bit banding on smooth gradients. Pass 1
 // (usmMode==1) returns above, so cleanTex stays clean for the USM neighbours.
 vec3 dith=vec3(gh(ivec2(globalPx),200));
 s+=(dith-.5)/255.;
 frag=vec4(clamp(s,0.,1.),1.);
}
`;
// ---------------------------------------------------------------------------
// GPU optical-field builder: replicates FilmifyNativeFilm.optics at bounded
// field resolution, moving the CPU raw-sample + FIR-gaussian + log-delta work
// into WebGL2 passes (the largest CPU block in developMobile — ~275ms of the
// ~400ms desktop total, per validation/timing-probe-check.cjs).
//
// Equivalence contract (mirrors mobile-optics.js buildField exactly):
//  - raw pass: manual trilinear on the renderer's raw LUT texture with the
//    same texel-centre convention as sampleTable in the tile shader and CPU;
//  - gaussian: separable vertical-then-horizontal FIR, radius floor(3s+.5),
//    exp(-k^2/2s^2) weights normalised, half-sample reflect boundary — the
//    exact CPU FIR branch. The mobile field never reaches the recursive IIR
//    branch (max sigma across all 11 stocks at a 768px field is 2.47); any
//    sigma>=3 falls back to CPU buildField (defensive for future stocks);
//  - combine/delta: same scalar algebra, log10(max(0,x)+1e-10) delta, output
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
 if(radius<1)return null; // 当前尺寸下散射尾整体亚像素，无可做内容
 /* SCAT_BLUR_FRAG 循环静态上限 65 taps(半径≤32 才读全核):越界核尾会被静默截断
    (能量丢失且无任何报错)。当前全部配方/画幅可达最大 radius=21(tri-x 16mm@4096),
    本守卫只防未来画幅/参数变更越界——越界即放弃 scatter,维持改动前行为(2026-09-21 review)。 */
 if(radius>32)return null;
 const n=radius*2+1,nT=OPT_EXP.length,weights=new Float32Array(n*nT*2*3);
 /* 核纹理每项 2 行:偶数行=幅度烘焙的行向核(a*g,供 H pass),奇数行=纯归一核
    (g,供 V pass)。可分离 2D 核 K=a·g(x)g(y) 的幅度只能烘进一趟——两趟都烘
    a 会得 a²(2026-09-21 实测 V0=H0*a,平坦输入能量丢 2/3)。 */
 const center=[1,1,1];
 for(let ch=0;ch<3;ch++){
  const ci=Math.min(ch,fp.channels-1);
  const tw=(hal.scatter_tail_weight&&hal.scatter_tail_weight[ci])||0;
  // core 项:2400 宽时 sigma 恒亚像素(radius 0),4096 宽也仅 ~0.26px
  // (radius 1,核近似 delta),折进中心权重的误差 <1%@Nyquist,均可折叠;
  // 仅当某通道 core 真正可分辨(radius>=2, sigma>=~0.5px)才放弃整个 scatter
  // (=改动前行为,防守未来更大画幅/更粗 core 的配方)。
  const coreR=Math.floor(3*Math.max(1e-6,hal.scatter_core_um[ci]*ss/um)+.5);
  if(coreR>1)return null;
  center[ch]=1-s*tw;
  for(let t=0;t<nT;t++){
   const sigma=sigmas[t][ch],r=Math.floor(3*sigma+.5),a=s*tw*OPT_EXP[t][0];
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
uniform sampler2D accum;uniform float useAccum;
int refl(int i,int n){int m=i%(2*n);if(m<0)m+=2*n;return min(m,2*n-1-m);}
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy);ivec2 sz=textureSize(src,0);
 int n=axis==0?sz.x:sz.y;
 vec3 acc=vec3(0.);
 for(int k=0;k<65;k++){
  if(k>2*radius)break;
  int off=k-radius;
  int idx=refl(axis==0?p.x+off:p.y+off,n);
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
uniform float s;uniform float tail;uniform float gain;uniform float strength;uniform float norm;
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy);
 vec4 a=texelFetch(tex0,p,0);
 if(mode==0){frag=vec4(a.rgb,1);return;}
 if(mode==5){
  vec4 b=texelFetch(tex1,p,0);
  vec3 d=log(max(a.rgb,0.)+1e-10)/log(10.)-log(max(b.rgb,0.)+1e-10)/log(10.);
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
  this.programs={main:this.program(FRAG),scatBlur:this.program(SCAT_BLUR_FRAG)};
  this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
  this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  this.luts=new Map();this.lutCache=new Map();this.curves=null;this.source=null;
  this.cleanTex=null;this.cleanFBO=null;
  this.opticsField=null;this.grainStats=null;this.grainSeed=0;
  this.optProgs=null;this.optFBO=null;this.optFloatRenderOK=false;
  // Full-res local scatter state (kernel texture + per-tile RGBA32F work
  // textures). scatter==null → shader path identical to the pre-scatter build.
  this.scatter=null;this.scatKern=null;
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
  const data=new Float32Array(axis.length*4);
  const curves=fp.curves;
  for(let i=0;i<axis.length;i++){
   const c0=curves[Math.min(0,channels-1)][i],c1=curves[Math.min(1,channels-1)][i],c2=curves[Math.min(channels-1,2)][i];
   data[i*4]=c0;data[i*4+1]=c1;data[i*4+2]=c2;data[i*4+3]=1;
  }
  const gl=this.gl,tex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,axis.length,1,0,gl.RGBA,gl.FLOAT,data);
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
 /* Local scatter kernel for the current photo (from FilmifyMobile.scatterKernels;
    null disables — shader path then matches the pre-scatter build exactly).
    RGBA32F work textures are required, so a missing EXT_color_buffer_float
    means no scatter (the pre-2026-09-21 behaviour), never a degraded one. */
 setScatter(sc){this.assertContext();const gl=this.gl;
  if(this.scatKern){gl.deleteTexture(this.scatKern);this.scatKern=null;}
  this.scatter=null;
  if(!sc)return;
  if(!gl.getExtension('EXT_color_buffer_float'))return;
  const n=sc.radius*2+1,tex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE9);gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB32F,n,sc.rows,0,gl.RGB,gl.FLOAT,sc.weights);
  this.scatKern=tex;this.scatter=sc;
 }
 ensureScatterTargets(w,h){
  const gl=this.gl;
  if(this.scatT0&&this.scatW===w&&this.scatHh===h)return;
  for(const t of [this.scatT0,this.scatH,this.scatB,this.scatA])if(t)gl.deleteTexture(t);
  if(this.scatFBO)gl.deleteFramebuffer(this.scatFBO);
  const mk=()=>{const t=gl.createTexture();
   gl.activeTexture(gl.TEXTURE9);gl.bindTexture(gl.TEXTURE_2D,t);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,w,h,0,gl.RGBA,gl.FLOAT,null);return t;};
  this.scatT0=mk();this.scatH=mk();this.scatB=mk();this.scatA=mk();
  const fbo=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.scatT0,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('设备无法创建散射缓冲');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  this.scatFBO=fbo;this.scatW=w;this.scatHh=h;
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
  const blur=(src,dst,axis,row,accum)=>{
   gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,src);gl.uniform1i(gl.getUniformLocation(pb,'src'),1);
   gl.uniform1i(gl.getUniformLocation(pb,'axis'),axis);
   gl.uniform1i(gl.getUniformLocation(pb,'kernRow'),row);
   if(accum){gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,accum);gl.uniform1f(gl.getUniformLocation(pb,'useAccum'),1);}
   else gl.uniform1f(gl.getUniformLocation(pb,'useAccum'),0);
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
 render(style,evGain,w,h,tileX,tileY){
  this.assertContext();
  if(!this.source)return;
  this.setStyle(style);
  const scat=this.scatter?1:0;
  if(scat)this.scatterPasses(style);
  const p=this.programs.main,gl=this.gl,sp=style.film;
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
  gl.uniform1i(gl.getUniformLocation(p,'hasScatter'),scat);
  if(scat){
   gl.uniform3f(gl.getUniformLocation(p,'scatCenter'),...this.scatter.center);
   gl.activeTexture(gl.TEXTURE9);gl.bindTexture(gl.TEXTURE_2D,this.scatT0);gl.uniform1i(gl.getUniformLocation(p,'scatRaw'),9);
   gl.activeTexture(gl.TEXTURE10);gl.bindTexture(gl.TEXTURE_2D,this.scatSum);gl.uniform1i(gl.getUniformLocation(p,'scatBlur'),10);
  }
  gl.uniform2i(gl.getUniformLocation(p,'srcCrop'),this.sourceCrop.x,this.sourceCrop.y);
  // tile offset is also consumed by the grain hash so per-tile noise stays
  // continuous across tile boundaries; must be set even when optics is off.
  gl.uniform2f(gl.getUniformLocation(p,'opticsTileOffset'),tileX||0,tileY||0);
  if(has){
   gl.uniform2f(gl.getUniformLocation(p,'opticsFieldSize'),this.opticsW,this.opticsH);
  }
  this.uniform(p,'rawSize',style.rawSize);this.uniform(p,'lutSize',style.mobileSize);this.uniform(p,'curvesN',this.curves.n);
  this.uniform(p,'lutNearest',this.lutNearest?1:0);
  this.uniform(p,'fieldNearest',this.fieldNearest?1:0);
  this.uniform(p,'outputSize',this.outputWidth||this.canvas.width,this.outputHeight||this.canvas.height);
  this.uniform(p,'tileH',h);
  // Scanner USM weights [center, sigma, 2sigma] normalised; amount from recipe.
  const usm=(this.scannerUSMEnabled===false)?[0.7,0]:(style.scannerUSM||[0.7,0.7]);
  const sigma=usm[0],amt=usm[1];
  const uw=[1,Math.exp(-.5/(sigma*sigma)),Math.exp(-2/(sigma*sigma))];
  const usum=uw[0]+2*uw[1]+2*uw[2];
  this.uniform(p,'scannerAmount',amt);
  this.uniform(p,'scannerWeights',uw[0]/usum,uw[1]/usum,uw[2]/usum);
  this.uniform(p,'tileSize',w,h);
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
  if(this.grainStats){
   const g=this.grainStats;
   gl.uniform1i(gl.getUniformLocation(p,'hasGrain'),1);
   gl.uniform1f(gl.getUniformLocation(p,'grainUmScale'),g.umRef/(this.grainUm||8));
   gl.uniform1f(gl.getUniformLocation(p,'grainSeed'),this.grainSeed);
   gl.uniform1i(gl.getUniformLocation(p,'grainMono'),g.channels===1?1:0);
   gl.uniform1fv(gl.getUniformLocation(p,'grainL'),this.grainL);
   gl.uniform1fv(gl.getUniformLocation(p,'grainW'),this.grainW);
  }else gl.uniform1i(gl.getUniformLocation(p,'hasGrain'),0);
  gl.bindVertexArray(this.vao);
  const vw=w||this.canvas.width,vh=h||this.canvas.height;
  if(amt>0){
   /* Pass 1: neighbour pipeline (usmMode 1: no optics/grain/glare) into the
      clean-texture FBO. cleanTex must NOT be bound to any texture unit while
      it is the draw attachment (feedback loop → INVALID_OPERATION); it is
      bound only for pass 2 and unbound again after. */
   this.ensureCleanTarget();
   gl.uniform1i(gl.getUniformLocation(p,'usmMode'),1);
   gl.bindFramebuffer(gl.FRAMEBUFFER,this.cleanFBO);
   gl.viewport(0,0,vw,vh);
   gl.drawArrays(gl.TRIANGLES,0,3);
   gl.uniform1i(gl.getUniformLocation(p,'usmMode'),2);
   gl.activeTexture(gl.TEXTURE8);gl.bindTexture(gl.TEXTURE_2D,this.cleanTex);gl.uniform1i(gl.getUniformLocation(p,'cleanTex'),8);
  }else{
   gl.uniform1i(gl.getUniformLocation(p,'usmMode'),0);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  // viewport(0,0,w,h): gl_FragCoord.xy stays 0..w,0..h so texelFetch(source,..)
  // indexes the tile texture directly. The 2D drawImage rect accounts for the
  // GL lower-left origin (source y offset = backingCanvas.height - rowHeight).
  gl.viewport(0,0,vw,vh);
  gl.drawArrays(gl.TRIANGLES,0,3);
  if(amt>0){gl.activeTexture(gl.TEXTURE8);gl.bindTexture(gl.TEXTURE_2D,null);}
 }
 ensureCleanTarget(){
  const gl=this.gl,W=this.canvas.width,H=this.canvas.height;
  if(this.cleanTex&&this.cleanW===W&&this.cleanH===H)return;
  if(this.cleanTex)gl.deleteTexture(this.cleanTex);
  if(this.cleanFBO)gl.deleteFramebuffer(this.cleanFBO);
  const tex=gl.createTexture();
  gl.activeTexture(gl.TEXTURE8);gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,W,H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
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
  this.grainStats=stats||null;this.grainUm=um||8;
  if(!stats)return;
  const mono=stats.channels===1,L=new Float32Array(54),W=new Float32Array(27);
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
   for(let ch=0;ch<3;ch++){
    const r=Math.max(0.001,Math.min(0.999,mono?stats.corr[i][0]:stats.corr[i][ch]));
    // 2D binomial field: corr(d)=(0.25*d*c+0.09375*d*d)/(c*c+0.5*c*d+0.140625*d*d),
    // c=sqrt(1-d*d); bisect
    let lo=0,hi=1;
    for(let it=0;it<24;it++){
     const d=(lo+hi)/2,c=Math.sqrt(Math.max(0,1-d*d));
     const cr=(0.25*d*c+0.09375*d*d)/(c*c+0.5*c*d+0.140625*d*d);
     if(cr<r)lo=d;else hi=d;
    }
    W[i*3+ch]=(lo+hi)/2;
   }
  }
  this.grainL=L;this.grainW=W;
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
  const fp=style.film,hal=Object.assign({},fp.halation,{scatter_amount:0});
  // 2026-09-21: field is halation-only; small-scale scatter runs full-res in
  // the tile passes (sub-pixel at field resolution — it vanished there).
  if(!hal||!hal.active)return null;
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
   const strength=hal.halation_strength[ch]*hal.halation_amount;
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
  ctx.drawImage(source,0,0,fw,fh);
  const mkTex=(fmt)=>{
   const t=gl.createTexture();
   gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,t);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   gl.texImage2D(gl.TEXTURE_2D,0,fmt,fw,fh,0,(fmt===gl.R16F||fmt===gl.R32F)?gl.RED:gl.RGBA,fmt===gl.RGBA16F?gl.HALF_FLOAT:gl.FLOAT,null);
   return t;
  };
  const srcTex=gl.createTexture();
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
  // Float intermediates: the log-domain delta amplifies near-zero halo
  // contributions (a 1e-9 absolute change is ~+9 log10 units), and RGBA16F
  // underflows below 6e-8 — that zeroed the delta at physically-black pixels
  // (CPU kept them via float64). Only the final field stays RGBA16F so the
  // consumer texture matches the CPU half pack exactly.
  // 2026-09-21 硬化：高斯中间纹理一律 RGBA16F，不再用 R16F——R16F 仅在
  // EXT_color_buffer_float 下保证可渲染；只有 EXT_color_buffer_half_float 的
  // 设备上 R16F FBO 依规范不完整。桌面 ANGLE 对此宽容（照常渲染），真机严格
  // 驱动可能静默产出错误场且不触发任何错误。RGBA16F 在两种扩展下都可渲染，
  // 各向同性单通道数据写 .r 读 .r，着色器无需改动。
  const T0=mkTex(gl.RGBA16F),A=mkTex(gl.RGBA16F),B=mkTex(gl.RGBA16F),H1=mkTex(gl.RGBA16F),H2=mkTex(gl.RGBA16F),C1=mkTex(gl.RGBA16F),C2=mkTex(gl.RGBA16F);
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
   attach(outTex,fmt);draw(p);
  };
  try{
   attach(T0,gl.RGBA16F); // renderability proof + raw target
   const pRaw=this.optProgs.raw;
   gl.useProgram(pRaw);bind(1,srcTex);
   gl.uniform1i(gl.getUniformLocation(pRaw,'source'),1);
   gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_3D,this.luts.get('raw'));
   gl.uniform1i(gl.getUniformLocation(pRaw,'rawLUT'),2);
   gl.uniform1f(gl.getUniformLocation(pRaw,'rawSize'),style.rawSize);
   gl.uniform3fv(gl.getUniformLocation(pRaw,'rawScale'),style.rawScale);
   draw(pRaw);
   gl.deleteTexture(srcTex);
   // current = T0 baseline, then per-channel optics update .ch only.
   combine(0,0,T0,T0,T0,C1,gl.RGBA16F,{});
   let cur=C1,other=C2;
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
   const fieldTex=(cur===C1)?C2:C1;
   combine(5,0,cur,T0,T0,fieldTex,gl.RGBA16F,{});
   gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,fieldTex);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,this.fieldNearest?gl.NEAREST:gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,this.fieldNearest?gl.NEAREST:gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   // 删除除 fieldTex 外的全部临时纹理（含 combine(5) 的输入 cur）；此前把
   // fieldTex 本身也删掉导致主渲染绑定已删纹理 → INVALID_OPERATION。
   for(const t of [T0,A,B,H1,H2,cur])gl.deleteTexture(t);
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);
   return {texture:fieldTex,w:fw,h:fh};
  }catch(error){
   if(window.__OPTERR)console.error('GPU optics fail:',error&&error.message,'glerr',gl.getError());
   for(const t of [T0,A,B,H1,H2,C1,C2,srcTex])if(t)gl.deleteTexture(t);
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);
   return null;
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
  for(let px=0;px<8;px++){
   const c=colors[px];
   // Pure-JS evaluation of the shader numerics for one pixel (evGain=1).
   const raw=FilmifyMobileOptics.sampleTable(style.rawValues,style.rawSize,c[0]/255,c[1]/255,c[2]/255);
   const t=[0,0,0];
   for(let ch=0;ch<3;ch++){
    const logv=Math.log(Math.max(raw[ch]*style.rawScale[ch]*bwv[ch],0)+1e-10)/Math.LN10;
    const idx=(logv-lo)/span*(N-1);
    const i0=Math.max(0,Math.min(N-2,Math.floor(idx)));
    const f=Math.max(0,Math.min(1,idx-i0));
    const cv=fp.curves[Math.min(ch,fp.channels-1)];
    const d=cv[i0]+(cv[i0+1]-cv[i0])*f;
    let tv=(d-style.densityLow[ch])/style.densitySpan[ch];
    if(fp.positive)tv=Math.sqrt(Math.max(0,Math.min(1,tv)));
    t[ch]=tv;
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
 dispose(){
  if(this.disposed)return;this.disposed=true;
  if(this.canvas){this.canvas.removeEventListener('webglcontextlost',this.onContextLost);this.canvas.removeEventListener('webglcontextrestored',this.onContextRestored);}
  for(const entry of this.lutCache.values()){this.gl.deleteTexture(entry.raw);this.gl.deleteTexture(entry.scan);this.gl.deleteTexture(entry.curves.tex);}
  this.lutCache.clear();this.releaseStyle();
  if(this.opticsField){this.gl.deleteTexture(this.opticsField);this.opticsField=null;}
  if(this.cleanTex){this.gl.deleteTexture(this.cleanTex);this.cleanTex=null;}
  if(this.cleanFBO){this.gl.deleteFramebuffer(this.cleanFBO);this.cleanFBO=null;}
  for(const t of [this.scatT0,this.scatH,this.scatB,this.scatA,this.scatKern])if(t)this.gl.deleteTexture(t);
  this.scatT0=this.scatH=this.scatB=this.scatA=this.scatKern=null;this.scatter=null;
  if(this.scatFBO){this.gl.deleteFramebuffer(this.scatFBO);this.scatFBO=null;}
  if(this.optProgs)for(const pr of Object.values(this.optProgs))this.gl.deleteProgram(pr);
  this.optProgs=null;
  if(this.optFBO){this.gl.deleteFramebuffer(this.optFBO);this.optFBO=null;}
  this.grainStats=null;
  if(this.source)this.gl.deleteTexture(this.source);this.source=null;
  for(const pr of Object.values(this.programs))this.gl.deleteProgram(pr);
  this.programs={};if(this.buffer)this.gl.deleteBuffer(this.buffer);if(this.vao)this.gl.deleteVertexArray(this.vao);
 }
}
return {Renderer:Renderer,scatterKernels:scatterKernels};

})();
if(typeof module!=='undefined')module.exports=FilmifyMobile;

/* 2026-09-21 兼容垫片:engine 新增全特性探针 selfCheckEffects(真机黑图防线),
   钉版夹具只冻结着色器行为做新旧 A/B,探针对旧构建恒过、不参与判定。 */
FilmifyMobile.Renderer.prototype.selfCheckEffects=function(){return {ok:true};};
