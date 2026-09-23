'use strict';
// Full-size still processing. Preview budgets never change exported dimensions.
// Mobile styles (proposal A baked core) render through FilmifyMobile with no
// full-size Float32 planes; native styles keep the spatial film pipeline.
const FilmifyEngine=(()=>{
if(typeof window!=='undefined'&&window.FILMIFY_MOBILE)for(const key in window.FILMIFY_MOBILE)Object.assign(FILMIFY_STYLES[key],window.FILMIFY_MOBILE[key]);
let canvas=null,renderer=null,currentImage=null,slowTier=false;
/* 2026-09-21 真机防线（Android 假色事故）：色彩核心自检按款式各跑一次；
   GPU 光学场在首次构建后与 CPU 场逐值对照，不一致即整场弃用并锁定 CPU 路径
   （驱动级静默错误不会在 checkFramebufferStatus/getError 上留痕，只能数值对照）。 */
let fieldCrossChecked=false,diffusionCrossChecked=false,gpuOpticsBroken=false;
/* 2026-09-21 真机黑图修复（小红书 WebView / Adreno 830）：输出路径模式。
   0=未探针（首个 tile 三级探针后锁定）/ 1=drawImage 快照（健康设备默认）/
   2=终渲 FBO+readPixels（画布背缓冲与快照路径双坏时升级）/
   3=换 CPU 像素上传+FBO（连 canvas 元素纹理上传也坏时）。
   各级输出数值逐字节等价（validation/composite-fallback-check.cjs 桌面锁死）。 */
let compositeMode=0;
/* 2026-09-21 真机黑图修复 v3（同一 WebView 病灶的输入侧）：canvas→canvas
   drawImage 在病灶设备上同样出全黑（GPU 背衬 2D 画布间的 SharedImage 拷贝），
   tile 构建改探针门控：tileCpu=0 未探针 / 1 drawImage 正常 / 2 坏→putImageData
   （getImageData/putImageData 是纯 CPU 路径，不经过病灶 SharedImage）。 */
let tileCpu=0;
let tileGL=null,gctx=null; // FBO 合成中介画布（首次升级时分配，会话复用）
/* 桌面 A/B 验证开关：localStorage filmify.forceReadPixelsComposite=1 强制 L2、
   filmify.forcePixelUpload=1 强制 L3、filmify.forceTileCpu=1 强制 tile CPU 构建
   （验证各级逐字节等价用）；正式流量不设置。 */
function forceReadPixelsComposite(){try{return typeof localStorage!=='undefined'&&localStorage.getItem('filmify.forceReadPixelsComposite')==='1';}catch(error){return false;}}
function forcePixelUpload(){try{return typeof localStorage!=='undefined'&&localStorage.getItem('filmify.forcePixelUpload')==='1';}catch(error){return false;}}
function forceTileCpu(){try{return typeof localStorage!=='undefined'&&localStorage.getItem('filmify.forceTileCpu')==='1';}catch(error){return false;}}
const coreChecked=new Set();
const effectsChecked=new Set();
let assetRoot='./';const colorPromises={};const printPromises={};
/* 共享印相表(2026-09-22 LUT 重构):印相载体全局域表+逐胶卷 W 预变换,
   见 docs/shared-lut-design.md。recipe=胶卷 fp/raw + 印相表 + W 的合成对象,
   按 胶卷|印相 缓存(renderer.setStyle 以对象身份做纹理缓存键)。 */
const recipeCache={};
/* FNV-1a 32-bit over the decoded float32 LUT bytes; build-time stamp comes from
   scripts/stamp-mobile-lut-hashes.py / build-shared-prints.py (same decode math).
   Catches corruption introduced AFTER our verified zip: platform toolchain,
   transport, WebView image decode. Re-encode-proof by design (covers values,
   not PNG bytes). */
function fnv1a32(bytes){
 let h=0x811c9dc5;
 for(let i=0;i<bytes.length;i++){h^=bytes[i];h=Math.imul(h,0x01000193);}
 return h>>>0;
}
async function decodeAssetInto(path, size, expectedHash) {
  const image = await new Promise((resolve,reject) => {
    const img = new Image(); img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这卷胶片暂时没有准备好，请重试'));
    img.src = assetRoot+path.replace(/^\.\//,'');
  });
  if(image.naturalWidth!==size*2 || image.naturalHeight!==size*size)throw new Error('胶卷色彩资源尺寸异常，请重新打开工具');
  const table = document.createElement('canvas'); table.width = image.naturalWidth; table.height = image.naturalHeight;
  const ctx = table.getContext('2d'); ctx.drawImage(image,0,0);
  const rgba = ctx.getImageData(0,0,table.width,table.height).data;
  const values = new Float32Array(size*size*size*3);
  let peak = 0;
  for (let p=0;p<values.length/3;p++) for(let c=0;c<3;c++){const v=(rgba[p*8+c]+rgba[p*8+4+c]*256)/65535;values[p*3+c]=v;if(v>peak)peak=v;}
  // Guard against containers that silently blank canvas readback: an
  // all-zero table would render every photo as the uniform red/orange
  // film-base mask instead of failing loudly.
  if (!(peak > 0.01)) throw new Error('胶卷色彩资源读取失败，请重新打开工具');
  if (expectedHash !== undefined && expectedHash !== null) {
    const digest = fnv1a32(new Uint8Array(values.buffer));
    if (digest !== (expectedHash >>> 0)) throw new Error('胶卷色彩资源校验失败（数据在传输或解压中损坏），请重新打开工具');
  }
  table.width=table.height=1;
  return values;
}
function loadPrint(paperId){
 const print=(typeof window!=='undefined'&&window.FILMIFY_PRINTS||{})[paperId];
 if(!print)return Promise.reject(new Error('该印相载体暂未支持，请重新打开工具'));
 if(print.values)return Promise.resolve(print);
 if(!printPromises[paperId])printPromises[paperId]=(async()=>{
  print.values=await decodeAssetInto(print.asset,print.size,print.hash);
 })().catch(error=>{delete printPromises[paperId];throw error;});
 return printPromises[paperId].then(()=>print);
}
/* 共享直扫表(2026-09-22 下午):四款彩色反转片(velvia=基准恒等/provia/
   ektachrome/kodachrome)共用一张基准 Velvia 全局域裸 scan 表+3x20 三次 W,
   根治逐款直扫表的双重 DIR;trix 黑白反转片不在此列(保留逐款表+sqrt 路径)。 */
function scanRegistry(){
 return typeof window!=='undefined'&&window.FILMIFY_SCANS?window.FILMIFY_SCANS.direct_scan:null;
}
function scanRouted(styleId){
 const reg=scanRegistry();
 return !!(reg&&reg.styles&&reg.styles.indexOf(styleId)>=0);
}
function loadScan(){
 const reg=scanRegistry();
 if(!reg)return Promise.reject(new Error('直扫色彩资源不完整，请重新打开工具'));
 if(reg.values)return Promise.resolve(reg);
 if(!printPromises.__scan__)printPromises.__scan__=(async()=>{
  reg.values=await decodeAssetInto(reg.asset,reg.size,reg.hash);
 })().catch(error=>{delete printPromises.__scan__;throw error;});
 return printPromises.__scan__.then(()=>reg);
}
function recipeForScan(style){
 const key=style+'|scan';
 if(recipeCache[key])return recipeCache[key];
 const base=FILMIFY_STYLES[style],reg=scanRegistry();
 const recipe=Object.assign({},base,{
  mobileValues:reg.values,mobileSize:reg.size,
  preWC:(reg.W||{})[style]||null,sharedScan:1,comboKey:key});
 recipeCache[key]=recipe;return recipe;
}
function recipeFor(style,paperId){
 const key=style+'|'+paperId;
 if(recipeCache[key])return recipeCache[key];
 const base=FILMIFY_STYLES[style],print=window.FILMIFY_PRINTS[paperId];
 const recipe=Object.assign({},base,{
  mobileValues:print.values,mobileSize:print.size,
  preW:(print.W||{})[style]||null,sharedPrint:1,comboKey:key});
 recipeCache[key]=recipe;return recipe;
}
/* 胶卷侧表加载(raw 始终需要;直扫反转片另需逐款 mobile 表)。
   rawOnly=true 用于共享印相路径:逐组合 mobile.png 不再加载。 */
function loadFilmTables(id, style, rawOnly) {
  const cacheKey=rawOnly?id+'|raw':id;
  if (!colorPromises[cacheKey]) colorPromises[cacheKey] = (async () => {
    if (style.mobile) {
      const loaded = {
        mobileRawValues: style.mobileRawValues || await decodeAssetInto(style.mobileRawAsset, style.rawSize, style.mobileRawHash)
      };
      if (!rawOnly && !style.mobileValues)
        loaded.mobileValues = await decodeAssetInto(style.mobileAsset, style.mobileSize, style.mobileHash);
      if (loaded.mobileValues) style.mobileValues = loaded.mobileValues;
      style.mobileRawValues = loaded.mobileRawValues;
      style.rawValues = loaded.mobileRawValues;
      if (!style.meterValues) {
        style.meterValues = new Float32Array(style.rawValues.length);
        for(let i=0;i<style.rawValues.length;i+=3){
          const mean=(style.rawValues[i]*style.rawScale[0]+style.rawValues[i+1]*style.rawScale[1]+style.rawValues[i+2]*style.rawScale[2])/3;
          style.meterValues[i]=style.meterValues[i+1]=style.meterValues[i+2]=mean;
        }
        style.meterSize=style.rawSize;style.meterScale=1;
      }
    } else {
      const loaded = {
        values: await decodeAssetInto(style.asset,style.size),
        rawValues: await decodeAssetInto(style.rawAsset,style.rawSize)
      };
      // Meter uses the very same virtual-film raw model as exposure.
      loaded.meterValues=new Float32Array(loaded.rawValues.length);
      for(let i=0;i<loaded.rawValues.length;i+=3){const mean=(loaded.rawValues[i]*style.rawScale[0]+loaded.rawValues[i+1]*style.rawScale[1]+loaded.rawValues[i+2]*style.rawScale[2])/3;loaded.meterValues[i]=loaded.meterValues[i+1]=loaded.meterValues[i+2]=mean;}
      style.meterSize=style.rawSize;style.meterScale=1;
      Object.assign(style, loaded);
    }
    await filmifyYield();
  })().catch(error => { delete colorPromises[cacheKey]; throw error; });
  return colorPromises[cacheKey];
}
function loadColors(id, paperId) {
  const style = FILMIFY_STYLES[id];
  if (!style) return Promise.reject(new Error('请选择已支持的胶卷'));
  expandLogAxis(style);
  if (style.mobile) {
    if (paperId) {
      // 共享印相路径:胶卷侧只需 raw 表;印相表走 FILMIFY_PRINTS 注册表
      if (!style.mobileRawAsset) return Promise.reject(new Error('胶卷移动端色彩资源不完整，请重新打开工具'));
      const jobs=[loadPrint(paperId)];
      if (!style.mobileRawValues) jobs.push(loadFilmTables(id, style, true));
      return Promise.all(jobs).then(()=>{});
    }
    if (scanRouted(id)) {
      // 共享直扫路径:胶卷侧只需 raw 表;scan 表走 FILMIFY_SCANS 注册表
      if (!style.mobileRawAsset) return Promise.reject(new Error('胶卷移动端色彩资源不完整，请重新打开工具'));
      const jobs=[loadScan()];
      if (!style.mobileRawValues) jobs.push(loadFilmTables(id, style, true));
      return Promise.all(jobs).then(()=>{});
    }
    if (!style.mobileAsset) return Promise.reject(new Error('胶卷移动端色彩资源不完整，请重新打开工具'));
    if (style.mobileValues && style.mobileRawValues) return Promise.resolve();
    return loadFilmTables(id, style, false);
  }
  if (!style.nativeFilm || !style.asset || !style.rawAsset) return Promise.reject(new Error('胶卷色彩资源不完整，请重新打开工具'));
  if (style.values && style.rawValues) return Promise.resolve();
  return loadFilmTables(id, style, false);
}
/* logExposure 端点重建(2026-09-22 包体积治理):打包版 presets.js 只存
   [lo,hi,n](全部 20 款的轴实测为完美等差数列,构建断言偏差为 0),首次加载
   时无损展开回完整轴;源码版 presets.js 本就带完整轴,幂等。 */
function expandLogAxis(style){
 const fp=style&&style.film;
 if(fp&&fp.logExposureLin&&!fp.logExposure){
  const a=fp.logExposureLin[0],b=fp.logExposureLin[1],n=fp.logExposureLin[2];
  fp.logExposure=Array.from({length:n},(_,i)=>a+(b-a)*i/(n-1));
 }
}
// Only tile buffers live on the GPU. The final Canvas is full input size.
// Optical fields use whole-image coordinates; scanner tiles include a halo.
/* GL 生命周期历史（真机黑图定位，进 FILMIFY_DIAG.glHistory）：context 是否在
   页面隐藏态创建、释放/销毁/换节点次数、丢失事件次数。 */
const glHistory={releaseCalls:0,disposeCalls:0,swapCount:0,ctxCreatedHidden:0,lostEvents:0};
try{window.FILMIFY_DIAG=window.FILMIFY_DIAG||{};window.FILMIFY_DIAG.glHistory=glHistory;}catch(error){}
function resetRenderer(){
 glHistory.releaseCalls++;
 if(renderer){glHistory.disposeCalls++;try{renderer.dispose();}catch(error){}}
 const hadGl=!!renderer;
 renderer=null;
 /* 2026-09-21 真机黑图根因（小红书 WebView / Adreno 830）：销毁 WebGL
    context（loseContext）或替换 canvas 节点后，canvas→drawImage 的合成快照
    路径产出全黑（同任务 readPixels 数值始终正确）。释放因此只回收 GL 资源
    （dispose 删纹理/FBO/program），canvas 节点与其 context 终身保留——
    getContext 返回同一 context，新 Renderer 在其上重编译即可。
    例外：context 真已丢失时同节点重生无望（本机 restoreContext 实测无效，
    alpha7 T2），只能换节点——输出可能受影响的最后手段，但此时本就渲染不了。
    注意：renderer 不存在时绝不为检查而 getContext——在 pagehide（页面隐藏）
    里新建 GL context 本身就可能拿到坏 context（嫌疑实锤前按有毒处理）。 */
 if(!hadGl)return;
 const gl=canvas.getContext('webgl2');
 if(gl&&gl.isContextLost()){
  glHistory.swapCount++;
  const old=canvas,fresh=document.createElement('canvas');fresh.id='view';fresh.hidden=true;
  if(old.parentNode)old.parentNode.replaceChild(fresh,old);canvas=fresh;old.width=old.height=1;
 }
}
/* 默认母版为 JPEG 0.92，直接用于保存与分享。options.masterPNG 为数值门禁保留无损输出，避免 JPEG 色度抽样影响颗粒和 dither 测量。 */
const MASTER_JPEG_QUALITY=0.92;
function masterBlob(target,lossless){return new Promise((resolve,reject)=>{
 if(!target.toBlob){reject(new Error('当前设备无法导出完整尺寸照片'));return;}
 target.toBlob(blob=>{if(blob && blob.size)resolve(blob);else reject(new Error('照片导出失败，设备内存可能不足；未生成缩小版成片'));},
  lossless?'image/png':'image/jpeg',lossless?undefined:MASTER_JPEG_QUALITY);
});}
function assertCanvas(ctx,width,height){
 // Readback may have small browser privacy perturbations, including alpha.
 // Opposite writes to the same far corner still detect blank or stuck stores.
 const x=width-1,y=height-1,tolerance=8;
 const read=color=>{ctx.fillStyle=color;ctx.fillRect(x,y,1,1);return Array.from(ctx.getImageData(x,y,1,1).data);};
 const white=read('#fff'),dark=read('#000');
 try{(window.FILMIFY_DIAG=window.FILMIFY_DIAG||{}).canvasProbe={width:width,height:height,white:white,dark:dark};}catch(error){}
 ctx.clearRect(x,y,1,1);
 if(white.length!==4||dark.length!==4||white.some(value=>value<255-tolerance)||dark[3]<255-tolerance||dark.slice(0,3).some(value=>value>tolerance)){
  const error=new Error('画布读写自检未通过（白 '+white.join(',')+'；黑 '+dark.join(',')+'）');
  error.canvasFailure='readback';throw error;
 }
}
// The failed output is shrunk before waiting. Keep the active photo's optics
// intact and avoid allocating extra memory while recovering a backing store.
async function waitForCanvasRelease(){
 for(let i=0;i<3;i++)await new Promise(r=>setTimeout(r,30));
}
async function develop(style,onProgress,options){
 // v1: every stock renders through the mobile baked-core path; the native
 // full-size GPU path is not packaged.
 if(!(FILMIFY_STYLES[style]&&FILMIFY_STYLES[style].mobile))throw new Error('这卷胶片暂未支持移动端冲洗');
 return developMobile(style,onProgress,options);
}
// Mobile baked-core path (proposal A): full-resolution tiled colour core, no
// full-image Float32 planes, no prepareFilm stage. Progress starts at the first
// tile and each tile is a cancellable work unit.
async function developMobile(style,onProgress,options){
 options=options||{};
 if(!currentImage)throw new Error('请先选择照片');
 const source=currentImage;
 // Accept HTMLImageElement (naturalWidth) and canvas sources (width) alike.
 const fullW=source.naturalWidth||source.width,fullH=source.naturalHeight||source.height;
 if(!fullW||!fullH)throw new Error('照片尺寸无效');
 const width=fullW,height=fullH;
 try{const diag=window.FILMIFY_DIAG=window.FILMIFY_DIAG||{};delete diag.canvasProbe;delete diag.canvasAllocRetry;delete diag.canvasAllocFail;}catch(error){}
 const output=document.createElement('canvas');
 // Release owned canvas backing stores in finally, including failed renders.
 // A readback mismatch alone does not establish canvas memory exhaustion.
 let tile=null,srcCtx=null,srcMat=null,sourceIsCanvas=false;
 try{
  await loadColors(style,options.paper);await filmifyYield();
  /* 共享印相路径(2026-09-22):options.paper=印相载体 profile id 时,色彩表来自
     FILMIFY_PRINTS 全局域表+该胶卷的 W 预变换;无 paper 的彩色反转片走
     FILMIFY_SCANS 共享直扫表+三次 W(2026-09-22 下午);trix 仍走逐款表旧路径。 */
  const recipe=options.paper?recipeFor(style,options.paper)
    :scanRouted(style)?recipeForScan(style):FILMIFY_STYLES[style];
  const recipeKey=recipe.comboKey||style;
  const exposure=options.autoExposure===false?{ev:0,reason:'disabled',wb:{r:1,g:1,b:1}}:(options.exposure||FilmifyExposure.analyze(source,recipe));
  // Selected frame size drives the physical scale (um/px) of optics and grain.
  const formatMm=options.filmFormatMm||recipe.film.cameraFilmFormatMm||35;
  /* Tile granularity remembers the slow tier across photos: a device that once
     needed 384px tiles keeps them (was: re-measured and re-stalled per photo).
     The render canvas keeps a constant 896px backing store — tile granularity
     is set per-render via viewport, independent of backing size. */
  let edge=slowTier?384:896;
  if(canvas.width!==896){canvas.width=896;canvas.height=896;}
  /* Renderer persists for the session (context + compiled program + per-style
     LUT cache). A lost context stays attached to its canvas node, so on loss
     swap the node before recreating — same teardown as before, only on loss. */
  if(renderer&&(renderer.contextLost||renderer.gl.isContextLost())){
   glHistory.lostEvents++;glHistory.disposeCalls++;glHistory.swapCount++;
   try{renderer.dispose();}catch(error){}
   renderer=null;
   const old=canvas,fresh=document.createElement('canvas');fresh.id='view';fresh.hidden=true;
   if(old.parentNode)old.parentNode.replaceChild(fresh,old);
   old.width=old.height=1;canvas=fresh;
  }
  if(!renderer){
   if(document.hidden)glHistory.ctxCreatedHidden++; // 隐藏态建 context：真机毒源嫌疑记录
   renderer=new FilmifyMobile.Renderer(canvas,{});diffusionCrossChecked=false;
  }
  try{(window.FILMIFY_DIAG=window.FILMIFY_DIAG||{}).caps=renderer.caps;}catch(error){}
  /* 色彩核心自检：每个款式在首次显影前用 8 个已知像素走真实着色路径并回读
     对照纯 JS 参考值；失败说明该设备的 LUT/曲线/帧缓冲链路静默出错，继续显影
     只会产出假色照片——直接中止并给出诊断码。 */
  if(!coreChecked.has(recipeKey)){
   const chk=renderer.selfCheckCore(recipe);
   if(!chk||!chk.ok){
    console.error('Filmify core self-check FAILED',chk&&chk.detail,renderer.caps);
    try{window.FILMIFY_DIAG.coreFail=chk&&chk.detail;window.FILMIFY_DIAG.coreFailStyle=recipeKey;}catch(error){}
    throw new Error('色彩核心自检未通过（'+(chk&&chk.detail)+'），已中止以免输出错误颜色；请截图本提示反馈');
   }
   coreChecked.add(recipeKey);
  }
  // Optics field and grain use uncropped source pixel coordinates.
  renderer.outputWidth=fullW;renderer.outputHeight=fullH;
  /* 显式启用自动曝光时使用 AE_STRENGTH=0.5，折中中灰测光与场景明度；应用默认关闭 AE。与上游比较必须使用相同曝光口径。 */
  const AE_STRENGTH=0.5;
  const gain=Math.pow(2,exposure.ev*AE_STRENGTH);
  // Low-resolution optical field (scatter/halation) generated once per photo.
  // Field resolution follows output size: full-res photos get the bounded
  // 768px field; small renders cap at half their long edge with a 256px
  // floor — the halo is low-frequency, an upsampled 768px field wasted
  // ~9x field pixels per small render.
  let opticsEdge=Math.min(768,Math.max(256,Math.floor(Math.max(width,height)/2)));
  if(options.optics===false)opticsEdge=0;
  if(options.diffusion>0)opticsEdge=Math.min(512,Math.max(width,height));
  /* Stage timing (ms): optics field build / tile upload / shader render /
     GL→2D composite / master+preview encode. Wall clock per segment, yields
     included; surfaced via the return value, one console line and
     window.FILMIFY_PROFILE for real-device CPU/GPU split measurement. */
  const tStart=performance.now();
  const T={optics:0,upload:0,shade:0,composite:0,encode:0,tiles:0,usmPasses:0};
  let opticsField=null,opticsGPU=0;
  if(opticsEdge>0){
   if(onProgress)onProgress(1);
   const tO=performance.now();
   /* GPU optical field first: raw pass + separable FIR gaussians + additive
      glow in half-float FBOs (needs EXT_color_buffer_float). Falls back to the CPU
      buildField on any GPU-side unavailability/failure — the field itself is
      never silently degraded, only the builder that produced it. The renderer
      must already know the style so the raw LUT texture is resident; setStyle
      is cached and idempotent. */
   try{
    if(renderer&&options.gpuOptics!==false&&!gpuOpticsBroken){
     renderer.setStyle(recipe);
     const fieldOpts={filmFormatMm:formatMm,diffusion:options.diffusion,halation:options.optics!==false,cancelled:options.cancelled};
     // Validate the new FFT path on a bounded field, not a full CPU convolution
     // on the first photo. The normal halation-only self-check stays unchanged.
     if(options.diffusion>0&&!diffusionCrossChecked&&renderer.caps.colorBufferFloat){
      let probe=null;
      const checkSource=document.createElement('canvas');checkSource.width=65;checkSource.height=49;
      try{
       const ctx=checkSource.getContext('2d'),pixels=ctx.createImageData(65,49);
       for(let y=0;y<49;y++)for(let x=0;x<65;x++){const i=(y*65+x)*4;pixels.data[i]=x<32?5:240;pixels.data[i+1]=(x+y)%13?60:255;pixels.data[i+2]=y<24?20:210;pixels.data[i+3]=255;}ctx.putImageData(pixels,0,0);
       probe=await renderer.buildOpticsGPU(checkSource,recipe,48,fieldOpts);
       if(probe){
        const got=renderer.readFieldPixels(probe),ref=await FilmifyMobileOptics.buildField(checkSource,recipe,48,Object.assign({},fieldOpts,{keepFloat:true}));
        let maxD=0;if(!got||!ref)throw new Error('柔光 GPU 自检读取失败');
        for(let i=0;i<probe.w*probe.h;i++)for(let ch=0;ch<3;ch++){const d=Math.abs(got[4*i+ch]-ref.floatDelta[3*i+ch]);if(!Number.isFinite(d))throw new Error('柔光 GPU 自检非有限值');maxD=Math.max(maxD,d);}
        if(maxD>.002)throw new Error('柔光 GPU 自检误差 '+maxD);
        diffusionCrossChecked=true;
       }
      }catch(error){
       if(options.cancelled&&options.cancelled())throw error;
       gpuOpticsBroken=true;try{window.FILMIFY_DIAG.gpuOpticsBroken=true;window.FILMIFY_DIAG.diffusionCheckError=error.message;}catch(ignored){}
      }finally{checkSource.width=checkSource.height=1;if(probe&&probe.texture)renderer.gl.deleteTexture(probe.texture);}
     }
     const gpuField=gpuOpticsBroken||(options.diffusion>0&&!diffusionCrossChecked)?null:await renderer.buildOpticsGPU(source,recipe,opticsEdge,fieldOpts);
     if(gpuField){
      opticsField=gpuField;opticsGPU=1;
      /* 首次 GPU 场构建后与 CPU 场逐值对照（会话一次）：驱动静默错误（如
         严格驱动上半浮点 FBO 误渲染、半精度路径异常）不抛任何 GL 错误，
         只有数值对照能识别。超差即弃用该纹理并锁定 CPU 光学场。 */
      if(!fieldCrossChecked&&!(options.diffusion>0)){
       fieldCrossChecked=true;
       let maxD=-1,bad=false,cpuField=null;
       try{
        const gpuPix=renderer.readFieldPixels(gpuField);
        cpuField=await FilmifyMobileOptics.buildField(source,recipe,opticsEdge,{filmFormatMm:formatMm,keepFloat:true});
        if(!gpuPix||!cpuField||!cpuField.floatDelta){bad=true;}
        else{
         maxD=0;
         const n=gpuField.w*gpuField.h;
         for(let i=0;i<n;i++)for(let ch=0;ch<3;ch++){
          const d=Math.abs(gpuPix[i*4+ch]-cpuField.floatDelta[i*3+ch]);
          if(d>maxD)maxD=d;
         }
         bad=maxD>0.02; // 线性辉光域(2026-09-22 起);半精度量化误差 ≤~1e-3，离此一个数量级
        }
       }catch(error){bad=true;}
       if(bad){
        gpuOpticsBroken=true;opticsGPU=0;
        try{renderer.gl.deleteTexture(gpuField.texture);}catch(error){}
        opticsField=cpuField&&cpuField.data?cpuField:null;
        console.warn('GPU optics field self-check FAILED (maxDelta '+maxD+'), session falls back to CPU field',renderer.caps);
        try{window.FILMIFY_DIAG.gpuOpticsBroken=true;window.FILMIFY_DIAG.fieldMaxDelta=maxD;}catch(error){}
       }
      }
     }
    }
   }catch(error){if(opticsField&&opticsField.texture)renderer.gl.deleteTexture(opticsField.texture);opticsGPU=0;opticsField=null;if(options.cancelled&&options.cancelled())throw error;}
   if(!opticsField)opticsField=await FilmifyMobileOptics.buildField(source,recipe,opticsEdge,{filmFormatMm:formatMm,diffusion:options.diffusion,halation:options.optics!==false,cancelled:options.cancelled});
   T.optics=performance.now()-tO;
   if(options.cancelled&&options.cancelled()){if(opticsField&&opticsField.texture)renderer.gl.deleteTexture(opticsField.texture);throw new Error('已取消');}
   /* 光学场就绪是每张渲染的第一个真实里程碑(此前是长 stall):报 6%,
      供冲印页进度在 tile 回报开始前就有真实锚点(2026-09-22 进度均匀化) */
   if(onProgress)onProgress(6);
  }
  if(renderer){
   renderer.setOptics(opticsField);
   const stats=(typeof FILMIFY_GRAIN_STATS!=='undefined'&&FILMIFY_GRAIN_STATS)?FILMIFY_GRAIN_STATS[style]:null;
   renderer.setGrain(options.grain===false?null:stats,formatMm*1000/Math.max(fullW,fullH));
  renderer.scannerUSMEnabled=options.scannerUSM!==false;
   renderer.grainSeed=(options.seed||0);
   /* 全尺寸 tile 内计算短程散射，低分场负责 halation。优先 float32，支持时回退 float16；缺能力时记录诊断。scatter=false 仅用于对照。 */
   let scat=null;
   if(options.scatter!==false){
    const hal=recipe.film.halation;
    if(hal&&hal.active)scat=FilmifyMobile.scatterKernels(recipe,formatMm*1000/Math.max(fullW,fullH));
   }
   renderer.setScatter(scat);
   try{window.FILMIFY_DIAG.scatterMode=renderer.scatterMode;}catch(error){}
   renderer.scatterMs=0; // 只累计本次全尺寸 tile 循环的 scatter 耗时
   renderer.forceNoDir=options.dir===false; // A/B 对照:强制关逐点 DIR
   /* 全特性探针（2026-09-21 真机黑图教训）：核心自检为隔离变量关掉了
      grain/glare/USM，恰恰漏掉了在 Adreno 上被 mediump uint 折叠 hash
      团灭的那些阶段。此处配置已全部就位，用真实配置渲 8 像素断言画面
      活着（非全零/非全 255），每款配方首次显影一次，成本可忽略。 */
   if(!effectsChecked.has(recipeKey)){
    const echk=renderer.selfCheckEffects(recipe);
    if(!echk||!echk.ok){
     console.error('Filmify effects self-check FAILED',echk&&echk.detail,renderer.caps);
     try{window.FILMIFY_DIAG.effectsFail=echk&&echk.detail;window.FILMIFY_DIAG.effectsFailStyle=recipeKey;}catch(error){}
     throw new Error('成片效果自检未通过（'+(echk&&echk.detail)+'），已中止以免输出异常画面；请截图本提示反馈');
    }
    effectsChecked.add(recipeKey);
   }
  }
  const dirRadius=renderer.beginSpatialDir(recipe,formatMm*1000/Math.max(fullW,fullH),width,height,options.spatialDir===true);
  if(renderer.spatialDir)edge=Math.min(edge,512);
  try{window.FILMIFY_DIAG.spatialDir=renderer.dirMode;}catch(error){}
  const scatterPad=renderer&&renderer.scatter?renderer.scatter.radius:0;
  const scatPad=scatterPad+dirRadius+(options.scannerUSM===false?0:2);
  /* The full-size output canvas is allocated after the optics block: the GPU
     field builder holds ~15-30MB of transient float32 FBOs, so creating the
     44MB (4096px) output first would double peak memory. It is not touched
     until the first tile.
     Retry once after releasing a failed output backing store. Readback errors
     are recorded separately: they do not prove the device ran out of memory. */
  let ctx=null;
  for(let attempt=0;;attempt++){
   try{
    output.width=width;output.height=height;
    ctx=output.getContext('2d',{alpha:false,colorSpace:'srgb'});
    if(!ctx){const error=new Error('getContext 返回 null');error.canvasFailure='context';throw error;}
    assertCanvas(ctx,width,height);
    break;
   }catch(allocError){
    ctx=null;output.width=output.height=1;
    const failure={width:width,height:height,kind:allocError.canvasFailure||allocError.name||'Error',cause:String(allocError&&allocError.message||allocError)};
    if(allocError.name==='SecurityError'){
     try{window.FILMIFY_DIAG.canvasAllocFail=failure;}catch(e){}
     throw new Error('浏览器拒绝画布像素读取（SecurityError）；未降低分辨率');
    }
    if(attempt>=1){
     try{(window.FILMIFY_DIAG=window.FILMIFY_DIAG||{}).canvasAllocFail=failure;}catch(e){}
     throw new Error('完整尺寸画布初始化未通过，释放后重试仍失败（'+failure.kind+'，'+width+'×'+height+'）；请刷新页面后重试，未降低分辨率');
    }
    try{(window.FILMIFY_DIAG=window.FILMIFY_DIAG||{}).canvasAllocRetry=failure;}catch(e){}
    console.warn('Filmify: full-size canvas initialization failed, release + retry',allocError);
    await waitForCanvasRelease();
   }
  }
  tile=document.createElement('canvas');
  const tctx=tile.getContext('2d',{colorSpace:'srgb'});
  if(compositeMode===0){if(forcePixelUpload())compositeMode=3;else if(forceReadPixelsComposite())compositeMode=2;} // 桌面 A/B 强制开关
  if(tileCpu===0&&forceTileCpu())tileCpu=2;
  /* 源像素 CPU 直读通道（仅 tileCpu=2 兜底路径用）：canvas 源直接取其 2d
     上下文；img 源先物化一次（image→canvas drawImage 在病灶设备上正常——
     LUT 解码与自检一直依赖它），之后 getImageData 纯 CPU。
     注意：首个 tile 探针不走这里——探针只读一行，用窄条画布裁读，
     不为参照行物化全尺寸源画布（4096²≈67MB 峰值，2026-09-22 review 修复）。
     srcMat 是物化画布本身,finally 里 shrink 释放(iOS 画布额度);canvas 源
     时 srcCtx 借的是源画布自己的上下文,绝不能 shrink 源。 */
  sourceIsCanvas=(typeof HTMLCanvasElement!=='undefined'&&source instanceof HTMLCanvasElement);
  const getSrcCtx=()=>{
   if(srcCtx)return srcCtx;
   if(sourceIsCanvas)srcCtx=source.getContext('2d');
   if(!srcCtx){
    srcMat=document.createElement('canvas');srcMat.width=width;srcMat.height=height;
    const mctx=srcMat.getContext('2d',{colorSpace:'srgb'});
    mctx.drawImage(source,0,0);
    srcCtx=mctx;
   }
   return srcCtx;
  };
  const rowMaxOf=(buf)=>{let m2=0;for(let i=0;i<buf.length;i+=4){const m=buf[i]>buf[i+1]?(buf[i]>buf[i+2]?buf[i]:buf[i+2]):(buf[i+1]>buf[i+2]?buf[i+1]:buf[i+2]);if(m>m2)m2=m;}return m2;};
  function uploadTile(sx,sy,sw,sh,pad,forcePixels=false){
    const px=Math.max(0,sx-pad),py=Math.max(0,sy-pad);
    const pw=Math.min(width,sx+sw+pad)-px,ph=Math.min(height,sy+sh+pad)-py;
    tile.width=pw;tile.height=ph;
    /* tile 构建探针（会话首个 tile 一次）：canvas→canvas drawImage 在病灶
       设备出全黑——源参照行有内容而 tile 行全零即锁定 CPU 构建。 */
    let tileDrawn=false;
    if(tileCpu===0){
     try{
      tctx.drawImage(source,px,py,pw,ph,0,0,pw,ph);
      tileDrawn=true;
      const ky=Math.min(ph-1,ph>>1);
      /* 参照行不物化全尺寸源画布（2026-09-22 review：4096² 物化≈67MB 无谓峰值）——
         canvas 源直接读其 2d 上下文一行（纯 CPU）；img 源裁一行到窄条画布
         （image→canvas drawImage，与 LUT 解码同源的可信路径）。 */
      let srcRowMax;
      if(sourceIsCanvas){
       srcRowMax=rowMaxOf(getSrcCtx().getImageData(px,py+ky,pw,1).data);
      }else{
       const strip=document.createElement('canvas');strip.width=pw;strip.height=1;
       const sctx=strip.getContext('2d',{colorSpace:'srgb'});
       sctx.drawImage(source,px,py+ky,pw,1,0,0,pw,1);
       srcRowMax=rowMaxOf(sctx.getImageData(0,0,pw,1).data);
       strip.width=strip.height=1;
      }
      const tileRowMax=rowMaxOf(tctx.getImageData(0,ky,pw,1).data);
      tileCpu=1;
      if(srcRowMax>8&&tileRowMax===0){tileCpu=2;console.warn('Filmify: canvas-to-canvas drawImage broken on this device, tile build via putImageData',renderer.caps);}
      try{window.FILMIFY_DIAG.tileProbe={srcRowMax:srcRowMax,tileRowMax:tileRowMax,tileCpu:tileCpu};}catch(error){}
     }catch(error){tileCpu=1;}
    }
    let tileData=null;
    if(tileCpu===2){
     tileData=getSrcCtx().getImageData(px,py,pw,ph);
     tctx.putImageData(tileData,0,0);
    }else if(!tileDrawn){
     tctx.drawImage(source,px,py,pw,ph,0,0,pw,ph);
    }
    const srcCrop={x:sx-px,y:(py+ph)-(sy+sh)};
    // Both DIR passes must see the same pixels even on WebViews whose canvas
    // texture upload fails before the usual final-output probe can run.
    if(forcePixels||compositeMode===3||renderer.spatialDir){
     if(!tileData)tileData=tctx.getImageData(0,0,pw,ph);
     renderer.setSourcePixels(tileData.data,pw,ph,srcCrop);
    }
    else renderer.setSource(tile,srcCrop);
  }
  if(renderer.spatialDir){
   const dirStart=performance.now(),scale=renderer.spatialDir.scale;
   const step=Math.max(scale,Math.floor(edge/scale)*scale);let dirDone=0;
   for(let y=0;y<height;y+=step)for(let x=0;x<width;x+=step){
    if(options.cancelled&&options.cancelled())throw new Error('已取消');
    if(currentImage!==source)throw new Error('照片已更换，请重新冲洗');
    await filmifyYield();
    const w=Math.min(step,width-x),h=Math.min(step,height-y);
    uploadTile(x,y,w,h,scatterPad);
    renderer.render(recipe,gain,w,h,x,y,true);
    if(renderer.gl.getError()!==renderer.gl.NO_ERROR)throw new Error('空间显影预计算失败');
    dirDone+=w*h;if(onProgress)onProgress(6+12*dirDone/(width*height));
   }
   await renderer.finishDirField(options.cancelled);
   renderer.dirBuildMs=performance.now()-dirStart;
  }else renderer.dirBuildMs=0;
  let done=0;
  for(let y=0;y<height;){
   const rowHeight=Math.min(edge,height-y);
   for(let x=0;x<width;){
    if(options.cancelled&&options.cancelled())throw new Error('已取消');
    if(currentImage!==source)throw new Error('照片已更换，请重新冲洗');
    await filmifyYield();
    const w=Math.min(edge,width-x);
    const start=performance.now();
    const sx=x,sy=y,sw=w,sh=rowHeight;
    /* scatter 需要邻居 raw:tile 多取 scatPad 像素 padding(图像边界截断,
       着色器在 padding 内 reflect——输出像素永远只吃图内邻居)。srcCrop 是
       输出区在 padded tile 纹理里的偏移(y 从 padded 底边起算)。 */
    uploadTile(sx,sy,sw,sh,scatPad);
    const tUp=performance.now();
    renderer.setOutputFBO(compositeMode>=2);
    renderer.render(recipe,gain,sw,sh,sx,sy);
    const tShade=performance.now();
    const gl=renderer.gl;
    const glErr=gl.getError();
    if(gl.isContextLost() || glErr!==gl.NO_ERROR)throw new Error('图像处理资源不足 (glError='+glErr+')');
    // gl_FragCoord.y=0 is the framebuffer bottom; the tile result lands on
    // canvas rows (ch-rowHeight..ch). Read from there so output y maps to the
    // tile top. gl_FragCoord.xy+tileOffset then equals the source pixel coord.
    /* 输出路径三级探针（会话首个 tile 一次，逐级升级，锁定后终身沿用）：
       L1 drawImage 快照 / L2 终渲进 RGBA8 FBO + readPixels / L3 换 CPU 像素
       上传再 FBO。依据 2026-09-21 真机数据（小红书 WebView / Adreno 830）：
       画布背缓冲同任务 readPixels 与 drawImage 快照双双全零，而渲染管线
       （FBO 内）数值始终正确——两条画布相关路径都不可靠，必须能整体绕开。
       各级输出数值逐字节等价（桌面门禁锁定），升级只改取出方式不改结果。 */
    if(compositeMode===0){
     let drawMax=0,canvasMax=0,fboMax=0,pixMax=0,narrowMax=0;
     try{
      const rowMax=(buf)=>{let m2=0;for(let i=0;i<buf.length;i+=4){const m=buf[i]>buf[i+1]?(buf[i]>buf[i+2]?buf[i]:buf[i+2]):(buf[i+1]>buf[i+2]?buf[i+1]:buf[i+2]);if(m>m2)m2=m;}return m2;};
      const k=rowHeight>>1,rowBuf=new Uint8Array(w*4);
      gl.readPixels(0,k,w,1,gl.RGBA,gl.UNSIGNED_BYTE,rowBuf);
      canvasMax=rowMax(rowBuf);
      /* 同行 8px 窄条对照：8×2 探针渲染在这台机器上一直能正确回读，若窄条
         有值而宽条全零，则坏的是「宽 readPixels 回读」而非渲染本身。 */
      const nBuf=new Uint8Array(8*4);
      gl.readPixels(0,k,8,1,gl.RGBA,gl.UNSIGNED_BYTE,nBuf);
      narrowMax=rowMax(nBuf);
      const probe=document.createElement('canvas');probe.width=w;probe.height=1;
      const pctx=probe.getContext('2d',{colorSpace:'srgb'});
      pctx.drawImage(canvas,0,canvas.height-1-k,w,1,0,0,w,1);
      drawMax=rowMax(pctx.getImageData(0,0,w,1).data);
      probe.width=probe.height=1;
      if(drawMax>0)compositeMode=1;
      else{
       /* L1 坏：升级 FBO 终渲重渲本 tile 再探。render 确定性（同 seed 同
          参数），重渲不改变后续 tile 的任何状态。 */
       renderer.setOutputFBO(true);
       renderer.render(recipe,gain,sw,sh,sx,sy);
       gl.bindFramebuffer(gl.FRAMEBUFFER,renderer.outFBO);
       gl.readPixels(0,k,w,1,gl.RGBA,gl.UNSIGNED_BYTE,rowBuf);
       fboMax=rowMax(rowBuf);
       if(fboMax>0)compositeMode=2;
       else{
        /* L2 也坏：嫌疑上移到纹理上传（canvas 元素 GPU→GPU 上传采到全黑），
           换 CPU 像素上传重渲再探。 */
        uploadTile(sx,sy,sw,sh,scatPad,true);
        renderer.render(recipe,gain,sw,sh,sx,sy);
        gl.readPixels(0,k,w,1,gl.RGBA,gl.UNSIGNED_BYTE,rowBuf);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);
        pixMax=rowMax(rowBuf);
        if(!pixMax)throw new Error('设备输出读回失败，请重新打开工具后重试');
        compositeMode=3;
       }
      }
      if(compositeMode>1)console.warn('Filmify: canvas output path broken on this device, composite mode '+compositeMode,renderer.caps);
     }finally{
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      try{window.FILMIFY_DIAG.compositeProbe={drawMax:drawMax,canvasMax:canvasMax,narrowMax:narrowMax,fboMax:fboMax,pixMax:pixMax,mode:compositeMode};}catch(error){}
     }
    }
    if(compositeMode>=2){
     /* FBO 合成：最终 pass 已落入 outFBO。GL 行序自下而上，翻转转正后直接
        putImageData 进输出画布——全程 CPU 运输（readPixels/putImageData），
        不经过任何 GPU 画布间拷贝；与 drawImage 路径数值逐字节等价。 */
     const buf=new Uint8ClampedArray(w*rowHeight*4);
     gl.bindFramebuffer(gl.FRAMEBUFFER,renderer.outFBO);
     gl.readPixels(0,0,w,rowHeight,gl.RGBA,gl.UNSIGNED_BYTE,buf);
     gl.bindFramebuffer(gl.FRAMEBUFFER,null);
     const imgData=ctx.createImageData(w,rowHeight);
     for(let r2=0;r2<rowHeight;r2++)imgData.data.set(buf.subarray(r2*w*4,(r2+1)*w*4),(rowHeight-1-r2)*w*4);
     ctx.putImageData(imgData,x,y);
    }else{
     ctx.drawImage(canvas,0,canvas.height-rowHeight,w,rowHeight,x,y,w,rowHeight);
    }
    T.tiles++;T.upload+=tUp-start;T.shade+=tShade-tUp;T.composite+=performance.now()-tShade;
    done+=w*rowHeight;x+=w;
    if(onProgress){const base=renderer.spatialDir?18:6;onProgress(Math.min(97,base+Math.floor(done/(width*height)*(97-base))));}
    // Slow devices use smaller work units, never fewer output pixels.
    if(performance.now()-start>120){slowTier=true;edge=384;}
   }
   y+=rowHeight;
  }
  await filmifyYield();
  const tEnc=performance.now();
  let blob=await masterBlob(output,options.masterPNG===true);
  /* 病灶设备编码守卫（compositeMode>=2）：toBlob 若也走坏掉的 GPU 读出，
     母版会全黑——解码回验（image→canvas 与 getImageData 均为可用 CPU 路径），
     黑则从输出画布 getImageData 经 putImageData 重建纯 CPU 画布重编码。 */
  if(compositeMode>=2){
   try{
    const outMax=rowMaxOf(ctx.getImageData(0,height>>1,width,1).data);
    const chk=await new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>rej(new Error('decode'));im.src=URL.createObjectURL(blob);});
    const cc=document.createElement('canvas');cc.width=64;cc.height=64;
    const cx=cc.getContext('2d');cx.drawImage(chk,0,0,64,64);
    const blobMax=rowMaxOf(cx.getImageData(0,0,64,64).data);
    URL.revokeObjectURL(chk.src);chk.src='';cc.width=cc.height=1;
    if(outMax>8&&blobMax===0){
     const cpuC=document.createElement('canvas');cpuC.width=width;cpuC.height=height;
     const cpuX=cpuC.getContext('2d',{alpha:false,colorSpace:'srgb'});
     cpuX.putImageData(ctx.getImageData(0,0,width,height),0,0);
     blob=await masterBlob(cpuC,options.masterPNG===true);
     cpuC.width=cpuC.height=1;
     try{window.FILMIFY_DIAG.encodeCpu=1;}catch(error){}
     console.warn('Filmify: canvas toBlob broken on this device, encoded via CPU canvas');
    }
   }catch(error){}
  }
  /* 页内预览:长边 2048 JPEG(DPR3 槽位 1062×1416 设备像素,横图 cover 裁切后竖边
     仍需 ≥1416,4:3 需 1888),只用于成片页显示,不进保存/分享链路 */
  const preview=document.createElement('canvas'),scale=Math.min(1,2048/Math.max(width,height));
  preview.width=Math.max(1,Math.round(width*scale));preview.height=Math.max(1,Math.round(height*scale));
  const pctx=preview.getContext('2d');pctx.imageSmoothingEnabled=true;pctx.imageSmoothingQuality='high';
  pctx.drawImage(output,0,0,preview.width,preview.height);
  /* 病灶设备预览守卫：canvas→canvas 缩绘若出全黑，改 JS 盒式降采样 +
     putImageData（仅预览路径，不影响保存/分享的母版）。 */
  if(compositeMode>=2){
   try{
    const outMax=rowMaxOf(ctx.getImageData(0,height>>1,width,1).data);
    const pvMax=rowMaxOf(pctx.getImageData(0,preview.height>>1,preview.width,1).data);
    if(outMax>8&&pvMax===0){
     const full=ctx.getImageData(0,0,width,height),fd=full.data;
     const pd=pctx.createImageData(preview.width,preview.height),dd=pd.data,pw2=preview.width,ph2=preview.height;
     for(let dy=0;dy<ph2;dy++){
      const sy0=Math.floor(dy/scale),sy1=Math.max(sy0+1,Math.floor((dy+1)/scale));
      for(let dx=0;dx<pw2;dx++){
       const sx0=Math.floor(dx/scale),sx1=Math.max(sx0+1,Math.floor((dx+1)/scale));
       let r=0,g=0,b2=0,n=0;
       for(let sy=sy0;sy<sy1;sy++)for(let sx=sx0;sx<sx1;sx++){const o=(sy*width+sx)*4;r+=fd[o];g+=fd[o+1];b2+=fd[o+2];n++;}
       const d=(dy*pw2+dx)*4;dd[d]=r/n;dd[d+1]=g/n;dd[d+2]=b2/n;dd[d+3]=255;
      }
     }
     pctx.putImageData(pd,0,0);
     try{window.FILMIFY_DIAG.previewCpu=1;}catch(error){}
    }
   }catch(error){}
  }
  let previewBlob;
  try{previewBlob=await new Promise((resolve,reject)=>preview.toBlob(b=>b&&b.size?resolve(b):reject(new Error('预览导出失败')),'image/jpeg',.92));}finally{preview.width=preview.height=1;}
  T.encode=performance.now()-tEnc;
  if(onProgress)onProgress(100);
  const timings={mobile:true,style:style,width:width,height:height,edge:edge,tiles:T.tiles,
   diffusion:options.diffusion||0,opticsEdge:opticsEdge,scannerPacked:!!renderer.scanPacked,
   opticsGPU:opticsGPU,gpuOpticsBroken:gpuOpticsBroken,diffusionGPU:!!(opticsField&&opticsField.diffusionGPU),diffusionPeakBytes:options.diffusion>0&&opticsGPU?renderer.diffusionPeakBytes||0:0,opticsPeakBytes:opticsGPU?renderer.opticsPeakBytes||0:0,
   composite:compositeMode===3?'fbo+pixels':compositeMode===2?'fbo':'drawImage',
   scatter:renderer&&renderer.scatter?1:0,
   scatterMode:renderer.scatterMode,
   spatialDir:renderer.dirMode,dirBuildMs:Math.round(renderer.dirBuildMs||0),dirTileMs:Math.round(renderer.dirMs||0),dirPeakBytes:renderer.dirPeakBytes||0,
   scatterMs:Math.round(renderer&&renderer.scatterMs||0),
   gpuRenderer:renderer&&renderer.caps?renderer.caps.renderer:'',
   opticsMs:Math.round(T.optics),uploadMs:Math.round(T.upload),shadeMs:Math.round(T.shade),
   compositeMs:Math.round(T.composite),encodeMs:Math.round(T.encode),totalMs:Math.round(performance.now()-tStart)};
  console.log('developMobile ms',JSON.stringify(timings));
  try{(window.FILMIFY_PROFILE=window.FILMIFY_PROFILE||[]).push(timings);}catch(error){}
  return {blob:blob,previewBlob:previewBlob,width:width,height:height,mode:'full',exposure:exposure,timings:timings};
 }catch(error){
  throw new Error('完整尺寸冲洗未完成：'+(error.message || error)+'。请重试；不会改存低清照片。');
 }finally{
  output.width=output.height=1;
  /* iOS 画布额度(2026-09-22):tile 与物化源画布立即 shrink,不等 GC——
     WebKit 对死画布 backing store 回收不积极,批量冲印会累积占额。
     srcCtx 为 canvas 源时借的是源自己的上下文,srcMat 才是我们物化的。 */
  if(tile)tile.width=tile.height=1;
  if(srcMat)srcMat.width=srcMat.height=1;
  /* The renderer (context, compiled program, per-style LUT cache) persists
     across photos; only the per-photo optics texture is dropped here.
     release()/resetRenderer() remain the hard teardown path. */
  if(renderer)try{renderer.setOptics(null);renderer.endSpatialDir();}catch(error){}
 }
}
function init(target,root){canvas=target;assetRoot=root;}
function setImage(image){currentImage=image;}
function release(){currentImage=null;resetRenderer();}
return {init:init,setImage:setImage,develop:develop,release:release,loadColors:loadColors};
})();
