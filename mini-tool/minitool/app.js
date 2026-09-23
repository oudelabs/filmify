'use strict';
/* Filmify 网页工具：最多 9 张照片，20 款胶卷与 118 种组合。主页选择照片和配方，冲印页展示真实工序进度；成片页提供对比图、效果图、拼图与显影动画。配方单选，画幅取胶卷默认值，仅影响效果尺度，不裁剪照片。 */
const MAX_BATCH_PHOTOS=9;
/* 主页大图/缩略图基底长边:负片预览在 DPR3 全宽(约 1062 设备像素)下不放大(2026-09-21 清晰度链路) */
const THUMB_EDGE=1152;
/* 首屏在导入期准备真实负片，保留原有导入进度，不再先展示方形黑块占位。 */
/* 导入长边上限为 4096，超限照片等比缩小；冲印不因慢设备再次降低输出尺寸。 */
const MAX_INPUT_EDGE=4096;
/* 页内展示图长边为 2048，按原比例 contain 显示；保存和分享使用全尺寸 blob。 */
const VIEW_EDGE=2048;
/* 实况动图负片首帧长边:录制画布 1280 长边、页内预览背压 1080×1440(cover 裁切后横图
   可见区约需 0.75×竖边),1536 全覆盖;负片是动画起点而非成片,不再向上堆分辨率 */
const LIVE_NEG_EDGE=1536;
/* 引擎直接生成 JPEG 0.92 母版，保存与分享直传 blob，避免重复有损编码和额外解码内存。 */
/* 拼图布局/绘制已抽为 collage-grid.js(FilmifyCollageGrid,2026-09-22 下午定稿):
   固定竖版 3:4 黑底方格,2–9 张全覆盖,取代旧 COLLA_ROWS 仅 4/8 张的行模板 */
const COLLAGE_CELL_SRC=400;/* 拼图格位 200px,取 2× 余量的逐格解码长边(预览/录制/静态共用) */
/* 配方卡色条:与交互稿 v4 一致,按 materials.js 胶卷顺序 */
const $=selector=>document.querySelector(selector);
const photos={};let nextPhoto=1;
/* state.print=-1 表示跟随原厂搭配（官配）；换胶卷时重置 */
const state={page:'main',selected:[],active:0,film:0,format:0,print:-1,resultIndex:0};
let assetRoot='./';
let toastTimer;
let procUnits=1,procDone=0;
let processStep=0,busy=false,job=0,engineQueue=Promise.resolve();
let outputs={},collage=null,presentation=null;
function resultPresentation(){
 if(!presentation){const seed=(Math.random()*4294967296)>>>0;presentation={theme:seed%2?'black':'white',seed:seed};}
 return presentation;
}
/* 对比图缓存与 outputs 同生命周期，换配方或重选照片后作废。 */
let compares={};
let ioBusy=false,picking=false,appendMode=false;
/* 保存部分失败时待重试的条目;仅弹层内「重试」按钮消费,页脚「保存全部」始终全量 */
let pendingSaveRetry=null;
/* 录制级失败后，本页后续分享直接使用图片组；取消不计为失败，刷新页面重置。 */
let liveShareDead=false;
const slideMeta=[];

function icon(name,size=20){const shapes={close:'<path d="m6 6 12 12M18 6 6 18"/>'};return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]||''}</svg>`;}
/* 胶卷卡使用片基色与暖白文字；印相图标为相纸叠片，纸色取 sw；直扫图标为取景框。 */
function swColors(sw){const m=String(sw).match(/#[0-9a-fA-F]{6}/g)||['#888888'];return [m[0],m[1]||m[0]];}
function filmBase(f){return f.type==='rev'?'#232529':(f.mono?'#323232':'#4a2c1b');}
function paperIconSVG(p){const c=swColors(p.sw);
 return '<svg viewBox="0 0 28 34" aria-hidden="true"><rect x="9" y="4" width="15" height="22" rx="2" fill="currentColor" opacity=".3"/><rect x="4" y="8" width="15" height="12" rx="2" fill="'+c[0]+'"/><rect x="4" y="14" width="15" height="12" rx="2" fill="'+c[1]+'"/></svg>';}
const SCAN_ICON='<svg viewBox="0 0 28 34" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 8H9a2 2 0 0 0-2 2v3" opacity=".85"/><path d="M17 8h2a2 2 0 0 1 2 2v3" opacity=".85"/><path d="M7 23v3a2 2 0 0 0 2 2h2" opacity=".85"/><path d="M21 23v3a2 2 0 0 1-2 2h-2" opacity=".85"/><rect x="10.5" y="13.5" width="7" height="9" rx="1" opacity=".5"/></svg>';
/* 品牌 Logo 按主题出图(2026-09-22):深色主题用暖白版 logo-mark-t-dark.png(橙色部分保留) */
function brandLogo(interactive=false){const content='<img class="brand-logo" src="'+window.FilmifyPrintDesign.logoURL()+'" alt="Filmify">';return interactive?'<button class="brand-wrap brand-about" data-action="about" aria-label="关于 Filmify" aria-haspopup="dialog" title="关于 Filmify">'+content+'</button>':'<span class="brand-wrap">'+content+'</span>';}
function escapeHTML(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function selectedFilm(){return FilmifyMaterials.films[state.film];}
/* 彩色负片可选 8 款彩色载体，黑白负片仅可选 2302；反转片直接扫描。 */
function comboBaked(f,p){
 if(!f.baked||!p)return false;
 if(f.mono)return p.id==='kodak_2302';
 return p.id!=='kodak_2302';
}
function printsOf(f){
 if(f.type==='rev'||f.type==='bwrev')return [];
 return FilmifyMaterials.prints.map((p,k)=>({p:p,k:k})).filter(e=>comboBaked(f,e.p));
}
function selectedPrint(){
 const list=printsOf(selectedFilm());if(!list.length)return null;
 /* state.print=-1=跟随官配(2026-09-22 全矩阵后印相行有 8 款,默认不能退化成 list[0]) */
 if(state.print===-1){const oem=list.filter(e=>e.p.id===selectedFilm().oem)[0];if(oem)return oem;}
 return list.filter(e=>e.k===state.print)[0]||list[0];
}
/* 跨工艺组合的第一步取胶卷冲洗路线，其余步骤取所选印相载体路线。 */
function routeSteps(){
 const sp=selectedPrint(),f=selectedFilm();
 if(!sp)return FilmifyMaterials.routes[f.route].steps.slice();
 const pr=FilmifyMaterials.routes[sp.p.route];
 return [FilmifyMaterials.routes[f.route].steps[0]].concat(pr.steps.slice(1));
}
/* 黑白联动：黑白胶卷，或彩色负片选了 2302 黑白印片（彩负印黑白=黑白成片，预览负片同步转灰） */
function comboMono(){const f=selectedFilm();if(f.mono)return true;const sp=selectedPrint();return !!(sp&&sp.p.id==='kodak_2302');}
/* 成片页与摘要使用简短组合文案。 */
function comboLabel(){const sp=selectedPrint();return selectedFilm().name+' · '+(sp?sp.p.carrier:'直接扫描');}
/* 分享正文只描述当前配方，标题留给用户；印片不能称作相纸。 */
function shareNote(){
 const f=selectedFilm(),sp=selectedPrint();
 const brands={KODAK:'Kodak',FUJICOLOR:'Fujicolor',FUJIFILM:'Fujifilm'};
 const film=(brands[f.brand]||f.brand)+' '+f.name;
 const carrier=sp?(sp.p.id.indexOf('fujifilm_')===0?'Fujifilm':'Kodak')+' '+sp.p.carrier.replace(/ (?:相纸|黑白印片|印片)$/,''):null;
 return {
  content:'配方：'+film+' · '+(carrier||'直接扫描'),
  tags:'#Filmify #胶片感'
 };
}
/* 拼图脚标使用大写胶卷名和载体英文 mark；直扫只显示胶卷名。 */
function paperCaption(){
 const sp=selectedPrint();if(!sp)return null;
 const aliases={kodak_portra_endura:'ENDURA',fujifilm_crystal_archive_typeii:'CRYSTAL II'};
 return aliases[sp.p.id]||sp.p.name.replace(/^Kodak /,'').toUpperCase();
}
function collageFooterLabel(){
 return window.FilmifyPrintDesign.recipe({film:selectedFilm().name,paper:paperCaption()});
}
/* slideMeta 供页数统计与门禁读取，记录胶卷及可选相纸。 */
function resultLabel(){const sp=selectedPrint();return sp?selectedFilm().name+' · '+sp.p.carrier:selectedFilm().name;}
/* One presentation per result batch; preview, cover and recording share it. */
function liveCaptionOpts(){
 return {film:selectedFilm().name,paper:paperCaption(),theme:resultPresentation().theme};
}
async function liveCover(id){
 const output=outputs[id];if(!output)throw new Error('已取消');
 if(output.liveCover)return output.liveCover;
 const opts=liveCaptionOpts(),image=await decode(output.url);
 try{
  const blob=await window.FilmifyPrintDesign.compose(image,opts,true);
  if(outputs[id]!==output)throw new Error('已取消');
  if(!output.liveCover)output.liveCover={blob:blob,url:URL.createObjectURL(blob)};
  return output.liveCover;
 }finally{image.src='';}
}
function filmOf(k){return FilmifyMaterials.films[k];}
function current(){return state.selected[state.active]||state.selected[0];}
/* 主页照片/缩略图按当前组合显示负片:彩色=棕色负片,黑白(含彩负×2302)=黑白负片 */
function negThumbOf(id){
 const p=photos[id];if(!p)return '';
 // 首次导入先准备所需负片；切换黑白时沿用已有负片，避免闪出方形占位块。
 if(comboMono())return p.negBWPending?(p.negPending?p.thumb:p.thumbNeg):p.thumbNegBW;
 return p.negPending?(p.negBWPending?p.thumb:p.thumbNegBW):p.thumbNeg;
}
/* 显影动画首帧按需生成 LIVE_NEG_EDGE 负片，与主页 FilmNegativePreview 同源，按照片和黑白模式缓存；不用于静态成片渲染。 */
const liveNegCache={};
async function liveNegativeURL(id){
 const mono=comboMono(),key=id+(mono?'|bw':'|color');
 if(liveNegCache[key])return liveNegCache[key];
 const p=photos[id];if(!p)throw new Error('照片不存在');
 const img=await decode(p.display||p.src);
 const scale=Math.min(1,LIVE_NEG_EDGE/Math.max(img.naturalWidth,img.naturalHeight));
 const w=Math.max(2,Math.round(img.naturalWidth*scale)),h=Math.max(2,Math.round(img.naturalHeight*scale));
 const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
 hiQ(canvas.getContext('2d')).drawImage(img,0,0,w,h);img.src='';
 const neg=await FilmNegativePreview.render(canvas,assetRoot,mono?'bw':'color');
 canvas.width=canvas.height=1;
 const url=mono?neg.bw:neg.color;/* 按需单模式渲染,不再有未用侧需要释放 */
 liveNegCache[key]=url;
 return url;
}
function dropLiveNeg(id){const prefix=id+'|';Object.keys(liveNegCache).forEach(key=>{if(key.indexOf(prefix)===0){URL.revokeObjectURL(liveNegCache[key]);delete liveNegCache[key];}});}
// 默认微弱光学扩散（CineBloom 1/8）；所有胶卷和单/多图统一，不增加创作选项。
const DEFAULT_DIFFUSION=.125;
// Recipe-driven spatial DIR; URL override is only for internal A/B checks.
const SPATIAL_DIR_ENABLED=!/(?:^|[?&])dir=0(?:&|$)/.test(location.search);
// Imported phone photos are already rendered: preserve their scene brightness.
// Native midgray AE (even at half strength) darkens correctly exposed bright
// scenes. Film/paper tone curves remain active; do not re-enable scene AE here.
function configuration(){return {diffusion:DEFAULT_DIFFUSION,spatialDir:SPATIAL_DIR_ENABLED,style:selectedFilm().style,format:state.format,paper:selectedPrint()?selectedPrint().p.id:null,autoExposure:false};}
function printReady(id){return !!outputs[id];}
function filmFormat(config){return FilmifyMaterials.formats[config.format].filmFormatMm;}

/* ---------- 主页(一屏:Logo + 选图 + 胶卷/印相两行 + 随机搭配 + 开始冲印) ---------- */
const TYPE_TAG={neg:'彩色负片',rev:'反转片',bwneg:'黑白负片',bwrev:'黑白反转'};
function main(){
 const n=state.selected.length,f=selectedFilm();
 let area;
 /* 空态显示虚线框、加号与张数上限，整区可点击导入。 */
 if(!n)area='<button class="photoarea empty" data-action="select-photos" aria-label="选择照片"><svg class="plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span class="t">最多选择 '+MAX_BATCH_PHOTOS+' 张照片</span></button>';
 /* 已选照片的大图只作预览；通过缩略图的移除与追加按钮换图。 */
 else area='<div class="photoarea"><img src="'+negThumbOf(current())+'" alt="当前照片"></div>';
 /* 缩略图行保持占位；有照片时显示小加号，空态由大虚线框提供入口。 */
 let strip='<div class="strip">';
 if(n){
  strip+=state.selected.map((id,i)=>'<span class="cell"><button class="sthumb'+(i===state.active?' on':'')+'" data-thumb="'+id+'" aria-label="查看第 '+(i+1)+' 张"><img src="'+negThumbOf(id)+'" alt=""></button><button class="thumb-x" data-delete="'+id+'" aria-label="移除第 '+(i+1)+' 张">'+icon('close',10)+'</button></span>').join('');
  if(n<MAX_BATCH_PHOTOS)strip+='<button class="add" data-action="add" aria-label="添加照片">＋</button>';
 }
 strip+='</div>';
 /* 胶卷卡展示片基色、片型和型号名。 */
 const filmCards=FilmifyMaterials.films.map((f2,k)=>{
  const sel=k===state.film;
  return '<button class="rcard'+(sel?' on':'')+(f2.baked?'':' soon')+'" data-film="'+k+'"'+(f2.baked?'':' disabled aria-disabled="true"')+' aria-pressed="'+sel+'" style="background:'+filmBase(f2)+'"><span class="pt"><span class="k">'+(f2.baked?TYPE_TAG[f2.type]:'即将上线')+'</span><span class="pn">'+escapeHTML(f2.name)+'</span></span></button>';
 }).join('');
 /* 印相卡展示载体图标、分类和名称；直扫卡使用同构布局，避免切换时跳动。 */
 let printRow='';
 const plist=printsOf(f);
 if(f.type==='rev'||f.type==='bwrev'){
  const rev=f.type==='rev';
  printRow='<div class="r-head"><span class="t">印相</span></div>'+
   '<div class="plist"><span class="pcard scan on">'+SCAN_ICON+'<span class="pt"><span class="k">直接扫描</span><span class="pn">'+(rev?'E-6 反转冲洗':'黑白反转冲洗')+'</span></span></span></div>';
 }else{
  const sp=selectedPrint();
  printRow='<div class="r-head"><span class="t">印相</span></div>'+
   '<div class="plist">'+plist.map(e=>{
    const on=sp&&e.k===sp.k;
    return '<button class="pcard'+(on?' on':'')+'" data-print="'+e.k+'" aria-pressed="'+on+'">'+paperIconSVG(e.p)+'<span class="pt"><span class="k">'+escapeHTML(e.p.kind)+'</span><span class="pn">'+escapeHTML(e.p.name)+'</span></span></button>';
   }).join('')+'</div>';
 }
 /* 摘要始终显示当前胶卷与载体，空态也保留。 */
 const summary=comboLabel();
 return '<div class="flow main-flow">'+
  '<header class="brandline">'+brandLogo(true)+'</header>'+
  '<div class="main-body">'+area+
  '<p class="preview-hint"'+(n?'':' aria-hidden="true"')+'>'+(n?'底片预览 · 冲印后查看最终效果':'')+'</p>'+strip+
  '<div class="r-head"><span class="t">胶卷</span><span class="s">'+escapeHTML(f.hint||'')+'</span></div>'+
  '<div class="rlist">'+filmCards+'</div>'+
  printRow+'</div>'+
  '<footer class="bottom-bar main-footer">'+
  '<div class="dice-row"><button class="dice" data-action="dice" aria-label="试试手气，随机搭配一组胶卷与印相"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.2" cy="8.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.8" cy="8.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="8.2" cy="15.8" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.8" cy="15.8" r="1.15" fill="currentColor" stroke="none"/></svg>试试手气</button></div>'+
  '<p class="summary">'+escapeHTML(summary)+'</p>'+
  '<button class="btn orange" data-action="process"'+(n?'':' disabled')+'>开始冲印</button></footer></div>';
}

/* ---------- 正在冲印(首页头部 + 正在xx + 段条 + 取消冲印) ---------- */
/* 工序来自所选配方路线，stageNames 在 startProcessing 时固定；推进受真实处理进度约束。 */
let stageNames=routeSteps();
function processing(){
 return '<div class="flow proc-flow">'+
  '<header class="brandline">'+brandLogo()+'</header>'+
  /* 单橙波浪表示处理中，工序文字承载进度语义；WORKING 标识绝对定位，不影响文字锚点。 */
  '<div class="proc-stage"><div class="proc-name-wrap"><img class="proc-sign" src="assets/working-sign.png" alt="">'+
  '<div class="proc-name" id="procName">正在'+escapeHTML(stageNames[0])+'</div></div>'+
  '<div class="proc-waves" aria-hidden="true"><div class="w1"><svg viewBox="0 0 340 28">'+
  '<path d="M-80,14 q20,-14 40,0 t40,0 t40,0 t40,0 t40,0 t40,0 t40,0 t40,0 t40,0 t40,0 t40,0"/>'+
  '</svg></div></div></div>'+
  '<footer class="bottom-bar main-footer"><p class="summary-spacer"></p><div class="cancel-row"><button class="cancel-link" data-action="cancel-process">取消冲印</button></div></footer></div>';
}
/* 每段至少显示 1 秒。展示进度取真实完成进度与匀速节奏的较小值；stageShownAt 防止快速跨过尚未完整显示的工序。 */
const MIN_STAGE_MS=1000;
let stageShownAt=0,stageTimer=0,procStartAt=0;
function applyStage(){
 const idx=Math.min(processStep,stageNames.length-1);
 const name=$('#procName');if(!name)return;
 name.textContent='正在'+stageNames[idx];
 /* 段条已撤(2026-09-22 波浪线重设计),阶段推进只换「正在xx」文案 */
}
function updateProcessing(){
 stageShownAt=performance.now();
 applyStage();
}
/* 整体进度:主渲染每张 1 份(引擎百分比填充);拼图双静态版(效果+底片,逐格小图解码)约为单张
   主渲染的 0.6 倍,计 0.6 份;单调递增,映射到当前路线的工序段数(合集卡与小样渲染已于 2026-09-21 移除,不再占份) */
const COLLAGE_WEIGHT=0.6;
/* 目标段 = min(真实进度, 匀速节奏) 映射到段号;两个上限取小保证「不超前真实,不快于 1s/段」 */
function stageTarget(){
 const n=stageNames.length;
 const real=Math.min(1,procDone/procUnits);
 const pace=Math.min(1,(performance.now()-procStartAt)/(n*MIN_STAGE_MS));
 return Math.min(Math.floor(Math.min(real,pace)*n),n-1);
}
function scheduleStage(ms){
 if(!stageTimer)stageTimer=setTimeout(()=>{stageTimer=0;tryAdvance();},ms);
}
/* 推进下一段:目标超前才动,且当前段须已亮相满 1s;未播完时按 120ms 自检——
   匀速节奏随时间推进,不依赖进度事件(快渲染下事件早早停发,节奏仍要走完) */
function tryAdvance(){
 if(state.page!=='processing')return;
 const k=stageTarget();
 if(k>processStep){
  const wait=MIN_STAGE_MS-(performance.now()-stageShownAt);
  if(wait>0){scheduleStage(wait);return;}
  processStep++;updateProcessing();
 }
 if(processStep<stageNames.length-1)scheduleStage(120);
}
function procProgress(units){
 procDone=Math.max(procDone,Math.min(units,procUnits));
 tryAdvance();
}
/* 收尾等待:全部段播完且末段亮相满 1s 才进成片页;取消时页面已切走,resolve 后由 token 拦截 */
function stagesSettled(){
 return new Promise(res=>{
  (function check(){
   if(state.page!=='processing')return res();
   if(processStep>=stageNames.length-1&&performance.now()-stageShownAt>=MIN_STAGE_MS)return res();
   setTimeout(check,80);
  })();
 });
}

/* ---------- 成片(横滑) ---------- */
/* 成片页不显示品牌头，result-mid 的弹性间隔控制画面垂直位置。 */
function result(){
 const single=state.selected.length===1;
 return '<div class="flow result-flow">'+
  '<div class="result-mid"><div class="swiper" id="swiper"><div class="track" id="track"></div></div>'+
  '<div class="dots" id="dots"></div><p class="result-hint" id="resultHint"></p></div>'+
  /* 成片页复用主页底栏的安全区与按钮位置，再次冲印入口位于按钮上方。 */
  '<footer class="bottom-bar main-footer result-footer">'+
  '<button class="againlink" data-action="again">再次冲印</button>'+
  '<div class="button-row">'+
  '<button class="btn ghost" data-action="save">'+(single?'保存效果图':'保存全部图片')+'</button>'+
  '<button class="btn orange" data-action="share">分享</button></div></footer></div>';
}
let preparedCover=null;
async function prepareResultCover(ids,token){
 if(token!==job)return;
 await window.FilmifyPrintDesign.ready();
 if(token!==job)return;
 if(ids.length===1)await liveCover(ids[0]);
 if(token!==job)return;
 if(preparedCover){preparedCover.src='';preparedCover=null;}
 let url;
 if(ids.length===1){
  try{url=await compareURL(ids[0]);}catch(error){if(token!==job)return;url=outputs[ids[0]].url;}
 }else url=collage&&collage.url;
 if(!url||token!==job)return;
 const image=await decode(url);
 if(image.decode)try{await image.decode();}catch(error){/* onload 已确认可解码 */}
 if(token!==job){image.src='';return;}
 preparedCover=image;
}
function resultImage(src,caption){
 let img;
 if(preparedCover&&preparedCover.src===src){img=preparedCover;preparedCover=null;}
 else{
  img=new Image();img.style.visibility='hidden';
  img.onload=()=>{img.style.visibility='';};
  if(src)img.src=src;
 }
 img.alt=caption;img.draggable=false;
 return img;
}
function addImageSlide(track,src,caption,cls){
 const s=document.createElement('div');s.className='slide'+(cls?' '+cls:'');
 const img=resultImage(src,caption);
 s.appendChild(img);track.appendChild(s);
 slideMeta.push(caption);
}
/* 对比图(原片×成片)按需合成:原片全尺寸解码一次+成片全尺寸解码一次,串行用完即释放;
   结果 blob 缓存进 compares(与 outputs 同生命周期)。失败按生成失败抛给调用方退化。
   全局串行队列(2026-09-22 review 修复):setupResult 对多图同时触发 addCompareSlide,并发合成
   每路持有 原图+成片 两张全尺寸位图(4096²≈134MB/路,8 张峰值可超 1GB),低端 WebView 直接 OOM;
   与拼图「逐格解码即释放」同一约束。队列顺带去重同 id 并发(占位 slide 与分享组可同时请求)。 */
let compareQueue=Promise.resolve();
async function compareBlob(id){
 if(compares[id])return compares[id].blob;
 const photo=photos[id],output=outputs[id];
 const current=()=>photos[id]===photo&&outputs[id]===output;
 if(!photo||!output)throw new Error('已取消');
 const work=compareQueue.catch(()=>{}).then(async()=>{
  if(!current())throw new Error('已取消');
  if(compares[id])return compares[id].blob;
  const sImg=await decode(photo.src);
  let eImg=null;
  try{
   eImg=await decodeBlob(output.blob);
   const blob=await window.FilmifyCompare.render(sImg,eImg,liveCaptionOpts());
   if(!current())throw new Error('已取消');
   compares[id]={blob:blob,url:''};
   return blob;
  }finally{sImg.src='';if(eImg)eImg.src='';}
 });
 compareQueue=work;
 return work;
}
async function compareURL(id){
 const blob=await compareBlob(id);
 if(!compares[id].url)compares[id].url=URL.createObjectURL(blob);
 return compares[id].url;
}
/* 首屏对比图在冲印期备好；其他页先用效果图保底，解码完成后替换，不插入无 src 的图片。 */
function addCompareSlide(track,id){
 const s=document.createElement('div');s.className='slide';
 const cached=compares[id]&&compares[id].url;
 const img=resultImage(cached||(outputs[id]||{}).url,'对比图');
 s.appendChild(img);track.appendChild(s);
 slideMeta.push('对比图');
 if(cached)return;
 compareURL(id).then(decode).then(ready=>{if(img.isConnected){ready.alt='对比图';ready.draggable=false;img.replaceWith(ready);}else ready.src='';}).catch(()=>{
  if(img.isConnected&&outputs[id])img.src=outputs[id].url;
 });
}
/* 页内显影动画循环绘制，不使用 MediaRecorder；停止后统一释放两张已解码图片。 */
let stopLive=null,liveSlideIndex=-1;
function stopLivePreview(){if(stopLive){stopLive();stopLive=null;liveSlideIndex=-1;}}
/* 预览循环只在动图页可见时运行:滑到效果图页暂停 rAF,滑回恢复(2026-09-21 性能审查) */
function syncLivePlayback(){
 if(!stopLive)return;
 if(state.resultIndex===liveSlideIndex)stopLive.resume();else stopLive.pause();
}
function addLiveSlide(track,id){
 const s=document.createElement('div');s.className='slide';
 const canvas=document.createElement('canvas');canvas.className='live-wipe';
 const output=outputs[id],placeholder=resultImage(output.liveCover?output.liveCover.url:output.url,'显影实况');
 s.appendChild(placeholder);track.appendChild(s);
 /* slideMeta 用于页数、滑动边界及门禁读取页序。 */
 slideMeta.push(resultLabel());
 liveSlideIndex=slideMeta.length-1;
 /* 首帧负片按需渲染(1536 长边,缓存);负片渲染失败一并走下方退化,不阻断成片页 */
 Promise.all([liveNegativeURL(id).then(decode),decode(outputs[id].url),window.FilmifyPrintDesign.ready()]).then(all=>{
  const imgs=all.slice(0,2);
  if(!s.isConnected||outputs[id]!==output){imgs.forEach(i=>{i.src='';});return;}
  const stop=window.FilmifyLiveWipe.preview(imgs[0],imgs[1],liveCaptionOpts(),canvas);
  placeholder.replaceWith(canvas);updateResultHint();
  const release=()=>{stop();imgs.forEach(i=>{i.src='';});};
  release.pause=stop.pause;release.resume=stop.resume;
  stopLive=release;
  /* 启动时若当前不在动图页,立即挂起循环 */
  syncLivePlayback();
 }).catch(()=>{
  /* 解码/负片渲染失败:动图页退化为静态效果图,不阻断成片页 */
  if(!s.isConnected)return;
  // Keep the decoded branded cover when live playback cannot start.
  if(canvas.isConnected)canvas.replaceWith(placeholder);
  updateResultHint();
 });
}
/* 拼图页先显示已合成静态图，逐格图片就绪后播放动画；解码失败时保留静态图。 */
function addCollageLiveSlide(track){
 const s=document.createElement('div');s.className='slide';
 const img=resultImage(collage.url,'拼图动图');
 s.appendChild(img);track.appendChild(s);
 slideMeta.push('拼图动图');
 liveSlideIndex=slideMeta.length-1;
 const ids=state.selected.filter(printReady);
 loadCollageCells(ids).then(cells=>{
  if(!s.isConnected){releaseCellImages(cells.negs);releaseCellImages(cells.effs);return;}
  const canvas=document.createElement('canvas');canvas.className='live-wipe';
  const stop=window.FilmifyCollageGrid.preview(cells.negs,cells.effs,collageFooterLabel(),canvas,collage.seed);
  const release=()=>{stop();releaseCellImages(cells.negs);releaseCellImages(cells.effs);};
  release.pause=stop.pause;release.resume=stop.resume;
  img.replaceWith(canvas);
  updateResultHint();
  stopLive=release;
  /* 启动时若当前不在动图页,立即挂起循环 */
  syncLivePlayback();
 }).catch(()=>{/* 保底静态效果拼图留着,不阻断成片页 */});
}
function setupResult(){
 const track=$('#track');if(!track)return;
 slideMeta.length=0;
 const single=state.selected.length===1;
 if(single){
  const id=state.selected[0];
  /* 单图页序为对比图、效果图、显影动画；换配方返回主页。 */
  addCompareSlide(track,id);
  addImageSlide(track,(outputs[id]||{}).url||photos[id].thumb,resultLabel());
  addLiveSlide(track,id);
 }else{
  /* 组图页序(2026-09-22 下午定稿):拼图动图(进页先摆冲印期合成的效果拼静,不空闪;
     逐格小图就绪后换整幅渐变显影循环 canvas)+ 底片拼静 + 效果拼静(仅 N≠8;
     N=8 满编 18 张,效果拼静即动图封面帧不单发)+ 逐对(N=9 无对比图,只出 9 张成片直发九宫格) */
  const n=state.selected.filter(printReady).length;
  if(collage){
   addCollageLiveSlide(track);
   addImageSlide(track,collage.negUrl,'底片拼图','collage');
   if(n!==8)addImageSlide(track,collage.url,'效果拼图','collage');
   state.selected.forEach(id=>{
    if(!outputs[id])return;
    if(n!==9)addCompareSlide(track,id);
    addImageSlide(track,outputs[id].url,resultLabel());
   });
  }
 }
 state.resultIndex=Math.max(0,Math.min(state.resultIndex,track.children.length-1));
 renderDots();slideTo(state.resultIndex);
 bindSwipe($('#swiper'));
}
function renderDots(){
 const dots=$('#dots');if(!dots)return;dots.innerHTML='';
 const number=document.createElement('span');number.className='num';dots.appendChild(number);
 dots.setAttribute('aria-live','polite');dots.setAttribute('aria-atomic','true');
}
function slideTo(idx){
 syncLivePlayback();
 const track=$('#track'),dots=$('#dots');if(!track||!dots)return;
 track.style.transform='translateX('+(-idx*100)+'%)';
 updateResultHint();
 const num=dots.querySelector('.num');
 if(num)num.textContent=(idx+1)+' / '+slideMeta.length;
 dots.setAttribute('aria-label','第 '+(idx+1)+' 页，共 '+slideMeta.length+' 页');
}
/* 只说明页类型与操作，不重复画面内已有的胶卷/相纸署名。 */
function updateResultHint(){
 const hint=$('#resultHint');if(!hint)return;
 const slide=$('#track')&&$('#track').children[state.resultIndex];
 const live=slide&&slide.querySelector('canvas.live-wipe');
 const label=slideMeta[state.resultIndex];
 const kind=label==='对比图'||label==='底片拼图'||label==='效果拼图'?label:'效果图';
 hint.textContent=live?'显影实况':kind;
 const save=$('[data-action="save"]');if(save&&state.selected.length===1)save.textContent=state.resultIndex===2?'保存实况封面':'保存效果图';
}
function bindSwipe(sw){
 if(!sw||sw._bound)return;sw._bound=true;
 const track=$('#track');let gesture=null;
 sw.addEventListener('dragstart',e=>e.preventDefault());
 sw.addEventListener('pointerdown',e=>{
  if(e.button>0||e.isPrimary===false||gesture)return;
  const width=sw.clientWidth,base=track.getBoundingClientRect().left-sw.getBoundingClientRect().left;
  gesture={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,time:e.timeStamp,velocity:0,dx:0,width:width,base:base,index:state.resultIndex,axis:''};
 });
 sw.addEventListener('pointermove',e=>{
  const q=gesture;if(!q||e.pointerId!==q.id)return;
  const dx=e.clientX-q.x,dy=e.clientY-q.y;
  if(!q.axis){if(Math.max(Math.abs(dx),Math.abs(dy))<6)return;q.axis=Math.abs(dx)>Math.abs(dy)?'x':'y';}
  if(q.axis!=='x')return;
  if(!track.classList.contains('drag')){track.classList.add('drag');if(sw.setPointerCapture)try{sw.setPointerCapture(e.pointerId);}catch(error){}}
  const dt=e.timeStamp-q.time;if(dt>0)q.velocity=(e.clientX-q.lastX)/dt;
  q.lastX=e.clientX;q.time=e.timeStamp;q.dx=dx;
  let offset=q.base+dx;const min=-(slideMeta.length-1)*q.width;
  if(offset>0)offset*=.25;else if(offset<min)offset=min+(offset-min)*.25;
  track.style.transform='translate3d('+offset+'px,0,0)';
 });
 function end(e,cancelled){
  const q=gesture;if(!q||e.pointerId!==q.id)return;gesture=null;
  let next=q.index;
  if(!cancelled&&q.axis==='x'){
   const flick=e.timeStamp-q.time<100&&Math.abs(q.dx)>16&&Math.abs(q.velocity)>.45;
   if(Math.abs(q.dx)>Math.min(64,q.width*.18)||flick)next=q.index+(q.dx<0?1:-1);
  }
  state.resultIndex=Math.max(0,Math.min(slideMeta.length-1,next));
  track.classList.remove('drag');slideTo(state.resultIndex);
  if(sw.hasPointerCapture&&sw.hasPointerCapture(q.id))try{sw.releasePointerCapture(q.id);}catch(error){}
 }
 sw.addEventListener('pointerup',e=>end(e,false));sw.addEventListener('pointercancel',e=>end(e,true));
 // Touch starts with implicit capture on the image/canvas. Transferring it to
 // the swiper emits a bubbling loss on that child; only our own loss cancels.
 sw.addEventListener('lostpointercapture',e=>{if(e.target===sw)end(e,true);});
 sw.addEventListener('pointerleave',e=>{if(gesture&&gesture.axis!=='x')end(e,true);});
}

/* ---------- 整组拼图合成(collage-grid.js 固定方格黑底版,冲印期合成,分享/保存/成片页共用) ---------- */
function decodeBlob(blob){
 return new Promise((resolve,reject)=>{
  const url=URL.createObjectURL(blob);const img=new Image();
  /* 用后 img.src='' 释放会触发 error 事件:onload 后先摘 onerror,
     否则同一 URL 被 revoke 两次(2026-09-22 泄漏探针实锤,每张照片 -1 净额噪声) */
  img.onload=()=>{img.onerror=null;URL.revokeObjectURL(url);resolve(img);};
  img.onerror=()=>{img.onload=null;URL.revokeObjectURL(url);reject(new Error('成片合成失败'));};
  img.src=url;
 });
}
/* 逐格小图解码(格位 200px,解码目标长边 COLLAGE_CELL_SRC=400 即 2× 余量):
   优先 createImageBitmap 缩放解码(解码即落小尺寸,无全尺寸位图驻留——旧实现
   8×12MP 同时解码峰值约 384MB,低端 WebView 直接 OOM);失败时整图解码画进小 canvas
   立即释放,同样只留小图。 */
function smallCanvasFromImage(img,px){
 const s=Math.min(1,px/Math.max(img.naturalWidth,img.naturalHeight));
 const canvas=document.createElement('canvas');
 canvas.width=Math.max(1,Math.round(img.naturalWidth*s));
 canvas.height=Math.max(1,Math.round(img.naturalHeight*s));
 hiQ(canvas.getContext('2d')).drawImage(img,0,0,canvas.width,canvas.height);
 img.src='';
 return canvas;
}
async function cellImage(blob,w,h,px){
 if(typeof createImageBitmap==='function'&&w&&h){
  try{
   const s=Math.min(1,px/Math.max(w,h));
   return await createImageBitmap(blob,{resizeWidth:Math.max(1,Math.round(w*s)),resizeHeight:Math.max(1,Math.round(h*s)),resizeQuality:'high'});
  }catch(err){}
 }
 return smallCanvasFromImage(await decodeBlob(blob),px);
}
async function cellImageURL(url,px){
 /* 负片缩略图只有 blob URL,平台禁 fetch/XHR 无法取回 Blob 走缩放解码;
    直接整图解码(1152 长边,约 5MB 瞬时)画进小 canvas 立即释放 */
 return smallCanvasFromImage(await decode(url),px);
}
function releaseCellImages(list){list.forEach(img=>{if(!img)return;if(typeof img.close==='function')img.close();else if(img.tagName==='CANVAS')img.width=img.height=1;else img.src='';});}
/* 逐格解码整组底片/正片小图(静态拼图、页内动图预览、分享录制共用;9×2 张 400px 小图内存可忽略) */
function collageInputs(ids){
 return {ids:ids.slice(),photos:ids.map(id=>photos[id]),outputs:ids.map(id=>outputs[id]),recipe:JSON.stringify(configuration()),mono:comboMono()};
}
function collageInputsCurrent(input){
 return !!input&&input.recipe===JSON.stringify(configuration())&&input.ids.length===state.selected.length&&
  input.ids.every((id,i)=>state.selected[i]===id&&photos[id]===input.photos[i]&&outputs[id]===input.outputs[i]);
}
async function loadCollageCells(ids,onProgress,input=collageInputs(ids),token=job){
 const negs=[],effs=[];
 const check=()=>{if(token!==job||!collageInputsCurrent(input))throw new Error('已取消');};
 try{
  for(let k=0;k<ids.length;k++){
   check();
   const output=input.outputs[k];
   const negative=await preparedNegativeURL(ids[k],input.mono);
   check();
   effs.push(await cellImage(output.blob,output.width,output.height,COLLAGE_CELL_SRC));
   check();
   negs.push(await cellImageURL(negative,COLLAGE_CELL_SRC));
   check();
   if(onProgress)onProgress((k+1)/(ids.length+0.5));
  }
  return {negs:negs,effs:effs};
 }catch(error){releaseCellImages(negs);releaseCellImages(effs);throw error;}
}
/* 合成结果提交前校验任务与输入；取消的工作不能写回后续批次。 */
async function composeCollage(ids,onProgress,token=job){
 const G=window.FilmifyCollageGrid,label=collageFooterLabel(),seed=resultPresentation().seed,input=collageInputs(ids);
 const check=()=>{if(token!==job||!collageInputsCurrent(input))throw new Error('已取消');};
 const cells=await loadCollageCells(ids,onProgress,input,token);
 try{
  check();
  const blob=await G.composeStatic(cells.effs,label,seed);
  check();
  const negBlob=await G.composeStatic(cells.negs,label,seed);
  check();
  if(onProgress)onProgress(1);
  return {blob:blob,url:URL.createObjectURL(blob),negBlob:negBlob,negUrl:URL.createObjectURL(negBlob),seed:seed,input:input};
 }finally{releaseCellImages(cells.negs);releaseCellImages(cells.effs);}
}
function disposeCollage(value){if(value){URL.revokeObjectURL(value.url);URL.revokeObjectURL(value.negUrl);}}
function releaseCollage(){
 disposeCollage(collage);collage=null;
 if(preparedCover){preparedCover.src='';preparedCover=null;}
}

/* ---------- 引擎调用 ---------- */
function engineRender(image,config,token,exposure,onProgress){
 const work=engineQueue.catch(()=>{}).then(async()=>{
  if(token!==job)throw new Error('已取消');FilmifyEngine.setImage(image);
  return FilmifyEngine.develop(config.style,onProgress,{filmFormatMm:filmFormat(config),paper:config.paper,autoExposure:config.autoExposure,diffusion:config.diffusion,spatialDir:config.spatialDir,exposure:exposure,cancelled:()=>token!==job});
 });engineQueue=work;return work;
}
async function cameraExposure(photo,config,image){
 if(!config.autoExposure)return null;
 await FilmifyEngine.loadColors(config.style,config.paper);
 if(!photo.exposures)photo.exposures={};
 if(!photo.exposures[config.style])photo.exposures[config.style]=FilmifyExposure.analyze(image,FILMIFY_STYLES[config.style]);
 return photo.exposures[config.style];
}
async function renderPhoto(id,config,token,onProgress){
 const photo=photos[id],image=await decode(photo.src);
 try{
  /* 里程碑式回报(2026-09-22 进度均匀化):解码/曝光分析完成各报一次真实锚点,
     引擎段(光学场 6% → 逐 tile → 编码 100%)映射进 4..100,全程单调 */
  if(onProgress)onProgress(2);
  const exposure=await cameraExposure(photo,config,image);
  if(onProgress)onProgress(4);
  const result=await engineRender(image,config,token,exposure,p=>{if(onProgress)onProgress(4+p*0.96);});
  if(token!==job)throw new Error('已取消');
  return {blob:result.blob,width:result.width,height:result.height,url:URL.createObjectURL(result.previewBlob)};
 }finally{image.src='';}
}
async function startProcessing(){
 if(!state.selected.length||busy)return;
 state.resultIndex=0;
 const token=++job,config=configuration(),ids=state.selected.slice();
 /* 进度份额只计真实待做工作:已缓存的主渲染/拼图不占份(2026-09-21 review 修复——
    原实现取消后再开始时,全部命中的工作仍空播四段动画各 1s)。权重依据见 COLLAGE_WEIGHT */
 if(collage&&!collageInputsCurrent(collage.input))releaseCollage();
 const pending=ids.filter(id=>!outputs[id]);
 const extra=(ids.length>1&&!collage?COLLAGE_WEIGHT:0);
 procUnits=pending.length+extra;procDone=0;processStep=0;
 /* 工序列表按本次所选配方路线定格(黑白反转/E-6/负片印纸等流程不同,页内工序名必须与实际一致) */
 stageNames=routeSteps();
 busy=true;
 if(!procUnits){/* 缓存命中也先解码首图，不空播冲印动画。 */
  try{await prepareResultCover(ids,token);if(token!==job)return;busy=false;state.page='result';render();}
  catch(error){if(token===job){busy=false;toast(errorMessage(error));}}return;
 }
 state.page='processing';render();
 if(stageTimer){clearTimeout(stageTimer);stageTimer=0;}
 stageShownAt=procStartAt=performance.now();
 /* 匀速节奏不依赖进度事件:进页即启动自检链(快渲染下事件很快停发,1s/段节奏仍要走完) */
 tryAdvance();
 let completed=0;
 try{
  for(let i=0;i<ids.length;i++){
   const id=ids[i];if(token!==job)return;
   if(outputs[id])continue;
   outputs[id]=await renderPhoto(id,config,token,percent=>{
    if(token!==job)return;
    procProgress(completed+percent/100);
   });
   completed++;procProgress(completed);
  }
  if(ids.length>1&&!collage){
   const composed=await composeCollage(ids,frac=>{
    if(token!==job)return;
    procProgress(completed+frac*COLLAGE_WEIGHT);
   },token);
   if(token!==job||!collageInputsCurrent(composed.input)){disposeCollage(composed);return;}
   collage=composed;
  }
  if(token!==job)return;
  await prepareResultCover(ids,token);
  if(token!==job)return;
  procProgress(procUnits);await stagesSettled();await filmifyYield();
  if(token!==job)return;
  busy=false;state.page='result';render();
 }catch(error){
  if(token!==job)return;
  cancelWork();state.page='main';render();
  sheet('冲印未完成','<p>'+escapeHTML(errorMessage(error))+'</p><p>已完成的照片保留，再次开始会继续处理。</p>');
 }
}

/* ---------- 保存 / 分享 ---------- */
/* 静态分享使用对比图和效果图。 */
/* 母版、对比图和拼图均直接交付 JPEG，不再进行二次编码。 */
/* 纯图片分享：单图为对比图和效果图；多图先放两种拼图，再放逐张对比和效果图，9 张时省略对比图。 */
async function buildShareBlobs(){
 const single=state.selected.length===1;
 const ids=state.selected.filter(printReady);
 const blobs=[];
 if(single){
  const id=ids[0];
  blobs.push(await compareBlob(id));
  blobs.push(outputs[id].blob);
 }else{
  if(collage){blobs.push(collage.blob);blobs.push(collage.negBlob);}
  const n=ids.length;
  for(const id of ids){
   if(n!==9)blobs.push(await compareBlob(id));
   blobs.push(outputs[id].blob);
  }
 }
 return blobs;
}
async function saveAll(retryItems){
 if(busy||ioBusy)return;
 /* 重试条目自带 blob 引用,不依赖当前 outputs(2026-09-22 review:此前 retry 也被
    「当前选中集无成片」检查静默吞掉,弹层按钮点了没反应;改为仅全量保存需要 ids) */
 let items=retryItems&&retryItems.length?retryItems:null;
 const ids=state.selected.filter(printReady);
 if(!items&&!ids.length)return;
 ioBusy=true;setIOLock();
 if(!items){
  items=[];
  try{
   if(state.selected.length===1){
    /* 单图保存一张效果图。 */
    if(state.resultIndex===2)items.push({blob:(await liveCover(ids[0])).blob,name:'live-cover-'+ids[0]});
    else items.push({blob:outputs[ids[0]].blob,name:'print-'+ids[0]});
   }else{
    /* 多图保存两种静态拼图及逐张对比和效果图，9 张时省略对比图；视频只进入分享组。 */
    if(collage){items.push({blob:collage.blob,name:'collage'});items.push({blob:collage.negBlob,name:'collage-negative'});}
    const n=ids.length;
    for(const id of ids){
     if(n!==9)items.push({blob:await compareBlob(id),name:'compare-'+id});
     items.push({blob:outputs[id].blob,name:'print-'+id});
    }
   }
  }catch(error){ioBusy=false;setIOLock();toast(errorMessage(error));return;}
 }
 let completed=0,failed=0,lastError='';
 const failedItems=[];
 toast('正在保存 0/'+items.length,true);
 for(const item of items){
  try{await window.filmifySavePhoto(item.blob,item.name);completed++;}
  catch(error){failed++;lastError=errorMessage(error);failedItems.push(item);}
  if(completed+failed<items.length)toast('正在保存 '+(completed+failed)+'/'+items.length,true);
 }
 ioBusy=false;render();
 const native=window.xhs&&window.xhs.miniTool;
 if(failed){
  pendingSaveRetry=failedItems;
  $('#toast').classList.remove('visible');positionToast();
  sheet(completed?'部分照片未保存':'照片未保存','<p>'+completed+' 张'+(native?'已保存':'已发起下载')+'，'+failed+' 张未完成。</p><p>'+escapeHTML(lastError)+'</p>','save','重试未完成的 '+failed+' 张照片');
 }else toast(native?'已保存 '+completed+' 张':'已发起 '+completed+' 张下载，请在浏览器下载中查看');
}
/* 分享直接打开宿主编辑页，优先使用静态图与显影实况混合组；录制不可用时回退纯图片组，总数不超过 18。 */
async function share(){
 if(busy||ioBusy)return;
 const ids=state.selected.filter(printReady);if(!ids.length)return;
 const single=state.selected.length===1;
 const note=shareNote();
 ioBusy=true;setIOLock();toast('正在准备分享',true);
 try{
  /* 单图单效果:分享组 = 对比图 + 效果图 + 4s 负片→成片渐变实况;
     实况「生成」不可用/失败(含负片渲染失败、录出黑帧自检不通过)时回退纯图片组
     (对比图+效果图),不阻断分享;
     生成成功后的 postNote 失败不再回退重试(否则会双重 toast + 二次唤起),直接走外层报错 */
  if(single&&!liveShareDead&&window.FilmifyLiveWipe&&window.FilmifyLiveWipe.supported()){
   const id=ids[0];
   let live=null,nImg=null,eImg=null;
   try{
    /* 负片首帧走 liveNegativeURL(1536 长边,缓存):录制画布仅 1280 长边,画质无区别,
       省一次大解码的耗时与内存峰值 */
    nImg=await decode(await liveNegativeURL(id));eImg=await decode(outputs[id].url);
    toast('正在生成分享素材，请稍等',true);
    try{live=await window.FilmifyLiveWipe.record(nImg,eImg,liveCaptionOpts());}
    catch(recordError){
     /* 录制级失败记死亡标记(解码失败不记——那是图的问题不是编码器的);
        用户切后台的主动取消也不记,回前台重试仍应尝试实况 */
     if(!/取消/.test(errorMessage(recordError)))liveShareDead=true;
     throw recordError;
    }
   }catch(liveError){
    toast(errorMessage(liveError)+'，已改为图片分享');
   }finally{
    /* 成功/失败都立即释放两张已解码图:失败路径原实现不清 src,位图会一直挂到
       分享流程结束(2026-09-21 review) */
    if(nImg)nImg.src='';if(eImg)eImg.src='';
   }
   if(live){
    /* 静态图直传母版/对比图(均已是 JPEG),实况封面/视频不动 */
    await window.filmifyShareLiveGroup([await compareBlob(id),outputs[id].blob],live.cover,live.video,note);
    toast('已打开发布页面');ioBusy=false;setIOLock();return;
   }
  }
  /* 8 张照片的混合组省略效果拼图静态件，9 张省略逐张对比图；其他情况包含实况、两种拼图与逐张对比和效果图。 */
  if(!single&&collage&&!liveShareDead&&window.FilmifyCollageGrid&&window.FilmifyCollageGrid.supported()){
   let live=null,cells=null;
   try{
    toast('正在生成分享素材，请稍等',true);
    cells=await loadCollageCells(ids);
    try{live=await window.FilmifyCollageGrid.record(cells.negs,cells.effs,collageFooterLabel(),collage.seed);}
    catch(recordError){
     if(!/取消/.test(errorMessage(recordError)))liveShareDead=true;
     throw recordError;
    }
   }catch(liveError){
    toast(errorMessage(liveError)+'，已改为图片分享');
   }finally{
    if(cells){releaseCellImages(cells.negs);releaseCellImages(cells.effs);}
   }
   if(live){
    const n=ids.length;
    const stills=[collage.negBlob];
    if(n!==8)stills.push(collage.blob);
    for(const id of ids){
     if(n!==9)stills.push(await compareBlob(id));
     stills.push(outputs[id].blob);
    }
    await window.filmifyShareLiveGroup(stills,live.cover,live.video,note);
    toast('已打开发布页面');ioBusy=false;setIOLock();return;
   }
  }
  const blobs=await buildShareBlobs();
  await window.filmifySharePhotos(blobs,note);toast('已打开发布页面');
 }catch(error){toast(errorMessage(error));}
 ioBusy=false;setIOLock();
}

/* ---------- 基础设施 ---------- */
function showAbout(){
 if($('.sheet-backdrop'))return;
 const trigger=$('.brand-about'),main=$('.main-flow');
 const meta=document.querySelector('meta[name="filmify-version"]');
 const version=meta&&meta.content!=='development'?'v'+meta.content:'开发版';
 const repository=document.querySelector('meta[name="filmify-repository"]');
 const repoURL=repository?repository.content:'';
 const source=repoURL?'<div class="about-section"><h4>开源地址</h4><p class="about-copy about-url">'+escapeHTML(repoURL.replace(/^https:\/\//,''))+'</p></div>':'';
 sheet('关于 Filmify',
  '<p class="about-version">'+escapeHTML(version)+' · Beta</p>'+
  '<div class="about-body"><p class="about-intro">一个模拟真实冲印的胶片风格化工具。</p>'+
  source+
  '<div class="about-section"><h4>致谢与致敬</h4><p class="about-copy">致敬 Andrea Volpato 与 spektrafilm，为本项目提供胶片模拟模型与算法基础。</p>'+
  '<p class="about-copy about-url">github.com/andreavolpato/spektrafilm</p>'+
  '<p class="about-copy about-font-credit">署名字体：Libre Baskerville。感谢字体项目的作者们。</p></div>'+
  '<details class="about-licenses"><summary>开源许可与出处</summary><p class="about-copy">代码与自制素材：GPL-3.0-only<br>模型衍生数据：CC BY-SA 4.0<br>字体：SIL OFL 1.1</p><pre></pre></details></div>',
  'close-sheet','');
 const overlay=$('.sheet-backdrop');overlay.classList.add('about-backdrop');overlay.querySelector('.sheet').classList.add('about-sheet');
 overlay.querySelector('pre').textContent=$('#licenseText').textContent.trim()||'源码预览未嵌入许可全文，请构建后查看，或阅读项目随附的 LICENSE 与资源来源说明。';
 const wasInert=main&&main.inert;if(main)main.inert=true;
 overlay.addEventListener('keydown',event=>{
  if(event.key!=='Tab')return;
  const items=overlay.querySelectorAll('button,summary');
  const first=items[0],last=items[items.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
 });
 const observer=new MutationObserver(()=>{
  if(overlay.isConnected)return;
  observer.disconnect();if(main)main.inert=wasInert;
  if(trigger&&trigger.isConnected)trigger.focus();
 });
 observer.observe($('#screen'),{childList:true});
}
function sheet(title,content,action='close-sheet',label='知道了'){const overlay=document.createElement('div');overlay.className='sheet-backdrop';overlay.innerHTML=`<section class="sheet" role="dialog" aria-modal="true" aria-label="${title}"><div class="sheet-head"><h3>${title}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">${icon('close',18)}</button></div>${content}${label?`<button class="primary" data-action="${action}">${label}</button>`:''}</section>`;$('#screen').append(overlay);overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove();});overlay.querySelector('button').focus();}
function positionToast(){
 const footer=$('.bottom-bar');if(!footer)return;
 $('#toast').style.bottom=Math.max(16,window.innerHeight-footer.getBoundingClientRect().top+12)+'px';
 // 反馈出现时暂时让出页下说明，保留原布局，避免两行文字叠在一起。
 const hint=$('#resultHint');if(hint)hint.style.visibility=$('#toast').classList.contains('visible')?'hidden':'';
}
function toast(message,persistent){
 clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('visible');positionToast();
 if(!persistent)toastTimer=setTimeout(()=>{$('#toast').classList.remove('visible');positionToast();},5000);
}
function errorMessage(error){return error&&(error.message||error.errMsg)||'操作未完成，请重试';}
function cancelWork(){job++;busy=false;}
/* 随机搭配分胶卷与印相两步跳格；胶卷提交时同步失效成片，避免中途恢复页面后复用旧配方。 */
let diceRolling=false;
function slotCenter(list,card){return Math.max(0,card.offsetLeft+card.offsetWidth/2-list.clientWidth/2);}
function slotSpin(list,card,hops,done){
 /* 逐卡居中并点亮选中框，跳格间隔由 60ms 逐渐增加，实现减速效果。 */
 const cards=Array.prototype.slice.call(list.children);
 const ti=cards.indexOf(card);
 if(ti<0){done();return;}
 const n=cards.length;
 let seq=[],i;
 if(ti>=hops-1){for(i=ti-hops+1;i<=ti;i++)seq.push(i);}
 else{for(i=Math.min(n-1,ti+hops-1);i>=ti;i--)seq.push(i);}
 let k=0;
 const hop=()=>{
  if(!list.isConnected||state.page!=='main'){diceRolling=false;return;}
  const idx=seq[k];
  cards.forEach((c,j)=>c.classList.toggle('on',j===idx));
  list.scrollLeft=slotCenter(list,cards[idx]);
  k++;
  if(k<seq.length){const t=seq.length-1;setTimeout(hop,60+Math.round(Math.pow(k/t,2)*130));return;}
  done();
 };
 hop();
}
function rollDice(){
 if(diceRolling||busy||ioBusy||state.page!=='main')return;
 const pool=FilmifyMaterials.films.map((f,k)=>f.baked?k:-1).filter(k=>k>=0);
 if(pool.length<2)return;
 let nf;do{nf=pool[Math.floor(Math.random()*pool.length)];}while(nf===state.film);
 diceRolling=true;
 const finish=()=>{diceRolling=false;render();};
 const applyFilm=()=>{releaseOutputs();state.film=nf;state.print=-1;state.format=filmOf(nf).formats[0];};
 const reduced=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 const rlist=document.querySelector('.rlist');
 const card=rlist&&rlist.querySelector('[data-film="'+nf+'"]');
 if(reduced||!card){applyFilm();finish();return;}
 /* 第一步:胶卷行滚动停住 */
 slotSpin(rlist,card,7,()=>{
  applyFilm();render();
  /* render 重建 DOM 后 scrollLeft 归零:瞬间复位到「停住居中」位置再接第二步 */
  const rl=document.querySelector('.rlist'),fc=rl&&rl.querySelector('[data-film="'+nf+'"]');
  if(fc)rl.scrollLeft=slotCenter(rl,fc);
  const plist=document.querySelector('.plist');
  const pcs=plist?plist.querySelectorAll('.pcard[data-print]'):[];
  if(!pcs.length){finish();return;}/* 反转片直扫卡无 data-print,无可抽,直接收工 */
  const pick=pcs[Math.floor(Math.random()*pcs.length)];
  /* 第二步:印相行滚动停住 */
  slotSpin(plist,pick,4,()=>{
   state.print=Number(pick.getAttribute('data-print'));
   finish();
   /* 最终 render 同样复位两行滚动到停住位置 */
   const rl2=document.querySelector('.rlist'),pl2=document.querySelector('.plist');
   const fc2=rl2&&rl2.querySelector('[data-film="'+nf+'"]');if(fc2)rl2.scrollLeft=slotCenter(rl2,fc2);
   const pc2=pl2&&pl2.querySelector('[data-print="'+state.print+'"]');if(pc2)pl2.scrollLeft=slotCenter(pl2,pc2);
  });
 });
}
function releaseOutputs(){
 Object.keys(outputs).forEach(id=>{URL.revokeObjectURL(outputs[id].url);if(outputs[id].liveCover)URL.revokeObjectURL(outputs[id].liveCover.url);});outputs={};presentation=null;
 releaseCollage();
 Object.keys(compares).forEach(id=>{if(compares[id].url)URL.revokeObjectURL(compares[id].url);});compares={};
}
function restart(){cancelWork();releaseOutputs();state.resultIndex=0;state.page='main';render();}
function decode(src){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('这张照片无法读取，请换用 JPEG、PNG 或可解码的照片'));image.src=src;});}
/* JPEG/PNG 文件头预读尺寸:避免为了「知道照片有多大」先整图解码(48MP 全尺寸解码在弱 WebView
   上可能直接 OOM)。JPEG 扫 SOF 段、PNG 读 IHDR;HEIC/WebP/GIF 等未知格式返回 null,由调用方
   降级为整图解码。FileReader 兼容 Chrome 61(该基线无 Blob.arrayBuffer)。 */
function readHead(file,size){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(new Uint8Array(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(file.slice(0,Math.min(file.size,size)));});}
/* 解析 JPEG TIFF IFD0 的 EXIF 方向标签 0x0112，返回方向与标签字节位置；失败返回 0。 */
function exifOrientation(buf,base,end){
 if(base+8>end)return 0;
 const le=buf[base]===0x49&&buf[base+1]===0x49;
 if(!le&&!(buf[base]===0x4D&&buf[base+1]===0x4D))return 0;
 const u16=o=>le?(buf[o]|buf[o+1]<<8):(buf[o]<<8|buf[o+1]);
 const u32=o=>le?((buf[o]|buf[o+1]<<8|buf[o+2]<<16|buf[o+3]<<24)>>>0):(((buf[o]<<24)|(buf[o+1]<<16)|(buf[o+2]<<8)|buf[o+3])>>>0);
 if(u16(base+2)!==42)return 0;
 const ifd=base+u32(base+4);
 if(ifd+2>end)return 0;
 const n=u16(ifd);
 for(let i=0;i<n;i++){
  const e=ifd+2+i*12;
  if(e+12>end)break;
  if(u16(e)===0x0112){
   if(u16(e+2)!==3||u32(e+4)!==1)return 0;
   const v=u16(e+8);return v>=1&&v<=8?{value:v,offset:e+8,littleEndian:le}:0;
  }
 }
 return 0;
}
/* 手动转正变换:o=1 不变;o≥5 为 90/270 度族,端正后宽高互换。w/h=待画内容的原始存储向尺寸 */
function orientCtx(ctx,w,h,o){
 switch(o){
  case 2:ctx.transform(-1,0,0,1,w,0);break;
  case 3:ctx.transform(-1,0,0,-1,w,h);break;
  case 4:ctx.transform(1,0,0,-1,0,h);break;
  case 5:ctx.transform(0,1,1,0,0,0);break;
  case 6:ctx.transform(0,1,-1,0,h,0);break;
  case 7:ctx.transform(0,-1,-1,0,h,w);break;
  case 8:ctx.transform(0,-1,1,0,0,w);break;
 }
}
async function readImageSize(file){
 try{
  const head=await readHead(file,32);
  if(head.length>=24&&head[0]===0x89&&head[1]===0x50&&head[2]===0x4E&&head[3]===0x47)
   return{width:((head[16]<<24)|(head[17]<<16)|(head[18]<<8)|head[19])>>>0,height:((head[20]<<24)|(head[21]<<16)|(head[22]<<8)|head[23])>>>0,orientation:1};
  if(head.length>=2&&head[0]===0xFF&&head[1]===0xD8){
   const buf=await readHead(file,65536);
   let orientation=1,orientationTag=null;
   for(let p=2;p+9<buf.length;){
    if(buf[p]!==0xFF){p++;continue;}
    const marker=buf[p+1];
    if(marker===0xD8||(marker>=0xD0&&marker<=0xD7)){p+=2;continue;}
    const len=(buf[p+2]<<8)|buf[p+3];
    if(len<2)return null;
    if(marker===0xE1&&len>=16&&buf[p+4]===0x45&&buf[p+5]===0x78&&buf[p+6]===0x69&&buf[p+7]===0x66&&buf[p+8]===0&&buf[p+9]===0){
     const o=exifOrientation(buf,p+10,Math.min(p+2+len,buf.length));
     if(o){orientation=o.value;orientationTag=o;}
    }
    if(marker>=0xC0&&marker<=0xCF&&marker!==0xC4&&marker!==0xC8&&marker!==0xCC){
     const w=(buf[p+7]<<8)|buf[p+8],h=(buf[p+5]<<8)|buf[p+6];
     if(w>0&&h>0)return{width:w,height:h,orientation:orientation,orientationTag:orientationTag};
    }
    p+=2+len;
   }
  }
 }catch(ignore){}
 return null;
}
function canvasBlob(canvas,type='image/png',quality=.95){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('图片导出失败，未生成低清替代图')),type,quality));}
/* 程序化缩绘统一高质量滤波:canvas 2d 默认 imageSmoothingQuality='low'(双线性),
   大倍率降采样(如 4096→1152)会出摩尔纹/糊边;Chrome 30+/Safari 均支持 'high' */
function hiQ(ctx){ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';return ctx;}
function openPicker(append){
 if(picking||busy||ioBusy)return;
 appendMode=append;
 const input=$('#fileInput');input.multiple=true;input.value='';input.click();
}
/* 大图统一压到长边 MAX_INPUT_EDGE:优先 createImageBitmap 解码期缩放(省去全尺寸解码的内存峰值),
   基线 WebView 61 / WebKit 对 resize 选项支持不可靠,故校验输出尺寸,不符或异常回退 <img>+canvas 缩绘;
   长边本就不超的原图不重新编码,直接沿用原文件。image 可为 null:调用方已通过文件头预读尺寸
   (readImageSize)时跳过整图解码,仅在 resize 解码不可用且确实需要缩放时才在此处解码一次。
   EXIF 端正(2026-09-22 竖图横显修复):width/height=存储向尺寸,orientation=文件头解析值;
   缩放后的 blob 是端正像素,宽高记端正值(o≥5 宽高互换)。浏览器可能忽略
   imageOrientation:'none' 仍自动转正；缩放前只把解码副本的 EXIF 方向标签置为 1，
   保留压缩像素与其余元数据，再手动变换一次。bitmap 与 <img> 回退同源，
   不靠宽高猜方向（镜像、180 度、正方形照片不能靠宽高识别）。 */
async function normalizeSource(file,image,width,height,orientation,header){
 const o=orientation||1,swap=o>=5;
 const ow=swap?height:width,oh=swap?width:height;
 const scale=Math.min(1,MAX_INPUT_EDGE/Math.max(ow,oh));
 if(scale>=1)return{blob:file,width:ow,height:oh};
 /* scale>=1 直传原文件:现代浏览器 <img>/drawImage 会自动按 EXIF 端正,与端正值宽高一致;
    无 EXIF 概念的古早 WebView(Chrome 61 基线)维持横躺,与历史行为一致 */
 const tw=Math.max(1,Math.round(ow*scale)),th=Math.max(1,Math.round(oh*scale));
 const rw=Math.max(1,Math.round(width*scale)),rh=Math.max(1,Math.round(height*scale));
 let source=file;
 if(o>1){
  const info=header||await readImageSize(file),tag=info&&info.orientationTag;
  if(!tag||tag.value!==o)throw new Error('无法读取照片方向，请重新导出照片后重试');
  source=new Blob([file.slice(0,tag.offset),new Uint8Array(tag.littleEndian?[1,0]:[0,1]),file.slice(tag.offset+2)],{type:file.type});
 }
 let bitmap=null;
 if(typeof createImageBitmap==='function'){
  try{
   const candidate=await createImageBitmap(source,{imageOrientation:'none',resizeWidth:rw,resizeHeight:rh,resizeQuality:'high'});
   if(candidate.width===rw&&candidate.height===rh)bitmap=candidate;
   else if(candidate.close)candidate.close();
  }catch(ignore){}
 }
 const canvas=document.createElement('canvas');canvas.width=tw;canvas.height=th;
 const ctx=hiQ(canvas.getContext('2d'));
 if(bitmap){
  if(o>1)orientCtx(ctx,rw,rh,o);
  ctx.drawImage(bitmap,0,0,rw,rh);
  if(bitmap.close)bitmap.close();
 }else{
  /* resize 解码不可用:解码同一份中性方向副本，再执行一次明确的方向变换。 */
  let img=source===file?image:null;
  if(!img){const u=URL.createObjectURL(source);try{img=await decode(u);}finally{URL.revokeObjectURL(u);}}
  if(o>1)orientCtx(ctx,rw,rh,o);
  ctx.drawImage(img,0,0,rw,rh);
  if(img!==image)img.src='';
 }
 const blob=await canvasBlob(canvas,'image/jpeg');canvas.width=canvas.height=1;
 return{blob:blob,width:tw,height:th};
}
/* 导入进度显示在照片区；正常结束由 render 清除，提前返回的失败路径也必须显式 render。 */
function importing(text){
 const area=$('.photoarea');if(!area)return;
 const t=area.querySelector('.t');
 if(t){t.textContent=text;return;}
 let el=area.querySelector('.importing');
 if(!el){el=document.createElement('span');el.className='importing';area.appendChild(el);}
 el.textContent=text;
}
async function acceptFiles(files){
 if(!files.length)return;
 picking=true;const append=appendMode;
 const available=MAX_BATCH_PHOTOS-(append?state.selected.length:0);
 if(append&&available<=0){picking=false;toast('最多选择 '+MAX_BATCH_PHOTOS+' 张');return;}
 const chosen=Array.from(files).slice(0,available),created=[];let failed=0;
 importing('正在导入底片…');
 let readIdx=0;
 for(const file of chosen){
  readIdx++;
  if(chosen.length>1)importing('正在导入底片 '+readIdx+'/'+chosen.length);
  let raw=null,src=null,thumb=null,display=null;
  try{
   /* 先读 JPEG/PNG 文件头拿尺寸:命中则跳过整图解码,直接走缩放(或原文件);
      HEIC 等未知格式降级整图解码路径。避免 48MP 这类大图在选图瞬间先全尺寸解码。 */
   const header=await readImageSize(file);
   let norm,origW=0,origH=0,image=null;
   if(header){
    origW=header.width;origH=header.height;
    norm=await normalizeSource(file,null,origW,origH,header.orientation,header);
    /* EXIF o≥5 时端正后宽高互换,origW/origH 同步记端正值(仅存档,无下游消费) */
    if(header.orientation>=5){const t=origW;origW=origH;origH=t;}
   }else{
    raw=URL.createObjectURL(file);
    image=await decode(raw);origW=image.naturalWidth;origH=image.naturalHeight;
    norm=await normalizeSource(file,image,origW,origH);
   }
   if(image)image.src='';
   if(raw)URL.revokeObjectURL(raw);
   /* 统一长边上限后再走后续全部流程:显影/保存/分享都用压缩后副本 */
   src=URL.createObjectURL(norm.blob);
   /* 缩放解码替代整图解码(2026-09-22 导入提速):缩略图/展示版最大只需 VIEW_EDGE,
      createImageBitmap 解码期直接缩到 ≤2048,省去 4096² 全尺寸位图(约 67MB)的
      解码耗时与内存峰值;与 normalizeSource 同款输出尺寸校验,不符或异常回退 <img>
      整图解码。注意直传原文件带 EXIF:默认 imageOrientation:'from-image' 先转正再
      缩放,期望值用端正值(norm.width/height 已按 o≥5 互换),校验不过即回退 */
   const vscale=Math.min(1,VIEW_EDGE/Math.max(norm.width,norm.height));
   const vw=Math.max(1,Math.round(norm.width*vscale)),vh=Math.max(1,Math.round(norm.height*vscale));
   let bmp=null,view=null;
   if(typeof createImageBitmap==='function'){
    try{
     const candidate=await createImageBitmap(norm.blob,{resizeWidth:vw,resizeHeight:vh,resizeQuality:'high'});
     if(candidate.width===vw&&candidate.height===vh)bmp=candidate;
     else if(candidate.close)candidate.close();
    }catch(ignore){}
   }
   if(!bmp)view=await decode(src);
   const sw=bmp?vw:view.naturalWidth,sh=bmp?vh:view.naturalHeight,pixels=bmp||view;
   const canvas=document.createElement('canvas'),tscale=Math.min(1,THUMB_EDGE/Math.max(sw,sh));canvas.width=Math.max(1,Math.round(sw*tscale));canvas.height=Math.max(1,Math.round(sh*tscale));
   hiQ(canvas.getContext('2d')).drawImage(pixels,0,0,canvas.width,canvas.height);
   thumb=URL.createObjectURL(await canvasBlob(canvas,'image/jpeg'));
   /* 所需负片在导入期间生成，保持导入进度直到真实预览就绪；不挂黑块占位。
      只影响主页显示，显影与保存仍用归一化原图。 */
   /* 成片页原图展示版:长边 VIEW_EDGE;归一化图本就不超时直接复用,不再多存一份 */
   display=src;
   if(vscale<1){
    canvas.width=vw;canvas.height=vh;
    hiQ(canvas.getContext('2d')).drawImage(pixels,0,0,canvas.width,canvas.height);
    display=URL.createObjectURL(await canvasBlob(canvas,'image/jpeg'));
   }
   canvas.width=canvas.height=1;if(view)view.src='';if(bmp&&bmp.close)bmp.close();
   const id=nextPhoto++;photos[id]={id:id,file:norm.blob,src:src,display:display,thumb:thumb,thumbNeg:thumb,thumbNegBW:thumb,negPending:true,negBWPending:true,negBWQueued:false,width:norm.width,height:norm.height,origWidth:origW,origHeight:origH};created.push(id);
   await (comboMono()?fillNegativeBW(id):fillNegative(id));
  }catch(error){
   /* 失败路径释放全部已建 Object URL(含展示版,2026-09-21 review 补) */
   if(raw)URL.revokeObjectURL(raw);if(src)URL.revokeObjectURL(src);if(thumb)URL.revokeObjectURL(thumb);
   if(display&&display!==src)URL.revokeObjectURL(display);
   failed++;
  }
  await filmifyYield();
 }
 picking=false;
 if(!created.length){render();toast('未能读取照片，请重新选择');return;}
 if(!append){releaseOutputs();state.selected.forEach(disposePhoto);state.selected=[];}
 else releaseCollage();
 state.selected=state.selected.concat(created);state.active=append?state.active:0;
 state.page='main';render();clearTimeout(toastTimer);$('#toast').classList.remove('visible');
 if(failed)toast(failed+' 张无法读取，其他照片已保留');
 else if(files.length>available)toast('最多选择 '+MAX_BATCH_PHOTOS+' 张，已保留前 '+created.length+' 张');
 /* 黑白导入只等待黑白负片，彩色备用预览仍可后台补齐。 */
 created.forEach(fillNegative);
}
/* 负片预览后台补算队列(与 engineQueue/compareQueue 同构 Promise 链,逐张串行):
   冲印/分享进行中(busy/ioBusy)轮询等待,不与显影抢主线程;
   照片已移除或已补算过则跳过;补算失败清 negPending 回退原图
   (与旧 neg 渲染失败兜底语义一致),不影响任何后续流程 */
let negQueue=Promise.resolve();
/* 负片补算完成(或失败回退)后原地换图:不整页 render,避免打断正在滑动的胶卷/印相行;
   只在仍停主页时换,进了冲印/成片页则由下次 render 自然带上 */
function negSwapDOM(id){
 if(state.page!=='main'||picking)return;
 document.querySelectorAll('[data-thumb="'+id+'"] img').forEach(el=>{el.src=negThumbOf(id);});
 const cur=current();/* current() 返回的是 id 而非照片对象 */
 if(cur===id){const big=document.querySelector('.photoarea img');if(big)big.src=negThumbOf(id);}
}
/* 正式合成只用指定模式的真实负片；主页的临时兜底不进入导出。
   与后台共用已开始的任务，但不等待受 busy 限制的后台队列。 */
function preparedNegativeURL(id,mono){
 const p=photos[id];if(!p)return Promise.reject(new Error('已取消'));
 const urlKey=mono?'thumbNegBW':'thumbNeg',pendingKey=mono?'negBWPending':'negPending',taskKey=mono?'negBWTask':'negTask';
 if(p[urlKey]&&p[urlKey]!==p.thumb)return Promise.resolve(p[urlKey]);
 if(p[taskKey])return p[taskKey];
 const work=(async()=>{
  let img=null,canvas=null;
  try{
   img=await decode(p.thumb);
   if(photos[id]!==p)throw new Error('已取消');
   canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
   canvas.getContext('2d').drawImage(img,0,0);
   const neg=await FilmNegativePreview.render(canvas,assetRoot,mono?'bw':'color');
   const url=neg&&(mono?neg.bw:neg.color);
   if(!url)throw new Error('底片预览生成失败，请重试');
   if(photos[id]!==p){URL.revokeObjectURL(url);throw new Error('已取消');}
   p[urlKey]=url;p[pendingKey]=false;negSwapDOM(id);return url;
  }finally{if(img)img.src='';if(canvas)canvas.width=canvas.height=1;}
 })();
 p[taskKey]=work;
 const clear=()=>{if(p[taskKey]===work)p[taskKey]=null;};work.then(clear,clear);
 return work;
}
function queueNegative(id,mono){
 const pendingKey=mono?'negBWPending':'negPending';
 negQueue=negQueue.then(async()=>{
  let p=photos[id];if(!p||!p[pendingKey])return;
  while(photos[id]===p&&p[pendingKey]&&(busy||ioBusy))await new Promise(r=>setTimeout(r,300));
  if(photos[id]!==p||!p[pendingKey])return;
  try{await preparedNegativeURL(id,mono);}
  catch(error){if(photos[id]===p){p[pendingKey]=false;negSwapDOM(id);}}
 }).catch(()=>{});
 return negQueue;
}
function fillNegative(id){return queueNegative(id,false);}
function fillNegativeBW(id){return queueNegative(id,true);}
function ensureNegBW(){
 if(!comboMono())return;
 state.selected.forEach(id=>{const p=photos[id];if(p&&p.negBWPending&&!p.negBWQueued){p.negBWQueued=true;fillNegativeBW(id);}});
}
function disposePhoto(id){if(!photos[id])return;const p=photos[id];URL.revokeObjectURL(p.src);if(p.display&&p.display!==p.src)URL.revokeObjectURL(p.display);URL.revokeObjectURL(p.thumb);if(p.thumbNeg&&p.thumbNeg!==p.thumb)URL.revokeObjectURL(p.thumbNeg);if(p.thumbNegBW&&p.thumbNegBW!==p.thumb)URL.revokeObjectURL(p.thumbNegBW);dropLiveNeg(id);delete photos[id];}
function removePhoto(id){
 if(outputs[id]){URL.revokeObjectURL(outputs[id].url);if(outputs[id].liveCover)URL.revokeObjectURL(outputs[id].liveCover.url);delete outputs[id];}
 releaseCollage();
 state.selected=state.selected.filter(value=>value!==id);disposePhoto(id);
 state.active=Math.max(0,Math.min(state.active,state.selected.length-1));
 render();
}
function setIOLock(){document.querySelectorAll('#screen button').forEach(button=>{if(ioBusy){button.dataset.wasDisabled=String(button.disabled);button.disabled=true;}else if(button.dataset.wasDisabled!==undefined){button.disabled=button.dataset.wasDisabled==='true';delete button.dataset.wasDisabled;}});}
/* 桌面预览补充:原生 overflow-x 只响应触摸/滚轮,鼠标拖不动;按下拖动超过 4px 视为滚动并吞掉随后的点击,避免误选配方 */
function dragScroll(el){
 if(el.dataset.dragScroll)return;el.dataset.dragScroll='1';
 let down=false,startX=0,startLeft=0,moved=false;
 const move=e=>{if(!down)return;const dx=e.clientX-startX;if(Math.abs(dx)>4)moved=true;if(moved)el.scrollLeft=startLeft-dx;};
 const up=()=>{down=false;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);};
 el.addEventListener('pointerdown',e=>{if(e.pointerType!=='mouse'||e.button!==0)return;down=true;moved=false;startX=e.clientX;startLeft=el.scrollLeft;window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);});
 el.addEventListener('click',e=>{if(moved){moved=false;e.preventDefault();e.stopPropagation();}},true);
 el.addEventListener('dragstart',e=>e.preventDefault());
}
const renders={main,processing,result};
function render(){
 stopLivePreview();
 $('#studio').classList.toggle('result-theme',state.page==='result');
 $('#screen').innerHTML=renders[state.page]();
 if(state.page==='result')setupResult();
 const rlist=$('.rlist');
 if(rlist){dragScroll(rlist);const active=rlist.querySelector('.rcard.on');if(active)rlist.scrollLeft=Math.max(0,active.offsetLeft-rlist.offsetLeft-(rlist.clientWidth-active.clientWidth)/2);}
 const plist=$('.plist');
 if(plist){dragScroll(plist);const on=plist.querySelector('.pcard.on');if(on)plist.scrollLeft=Math.max(0,on.offsetLeft-plist.offsetLeft-(plist.clientWidth-on.clientWidth)/2);}
 const strip=$('.strip');if(strip)dragScroll(strip);
 setIOLock();
 positionToast();
 ensureNegBW();/* 黑白组合下按需补算黑白负片(懒算,幂等) */
}
$('#screen').addEventListener('click',event=>{
 const el=event.target.closest('button');if(!el||el.disabled||ioBusy||picking||diceRolling)return;
 if(busy&&el.dataset.action!=='cancel-process')return;
 if(el.dataset.thumb!==undefined){
  const id=Number(el.dataset.thumb);state.active=state.selected.indexOf(id);
  if(state.active<0)state.active=0;
  /* 大图槽与主页初始渲染一致,按当前主配方显示负片预览,不回退成普通缩略图 */
  const img=$('.photoarea img');if(img&&photos[id])img.src=negThumbOf(id);
  document.querySelectorAll('.sthumb').forEach(t=>t.classList.remove('on'));el.classList.add('on');
  return;
 }
 if(el.dataset.delete!==undefined){removePhoto(Number(el.dataset.delete));return;}
 if(el.dataset.film!==undefined){
  const k=Number(el.dataset.film);
  if(k===state.film)return;
  state.film=k;state.print=-1;state.format=filmOf(k).formats[0];
  releaseOutputs();render();return;
 }
 /* 印相载体选择:换印相=换组合,成片缓存作废 */
 if(el.dataset.print!==undefined){
  const k=Number(el.dataset.print);
  const sp=selectedPrint();
  if(sp&&k===sp.k)return;
  state.print=k;releaseOutputs();render();return;
 }
 const action=el.dataset.action;
 if(action==='about'){showAbout();return;}

 /* 随机搭配:快速轮闪几组已烘焙胶卷再停住(抽签减速感);印相随官配联动 */
 if(action==='dice'){rollDice();return;}
 /* select-photos 只剩空态占位区一个入口(已选图的大图不可点,无重选确认层) */
 if(action==='select-photos'){openPicker(false);return;}
 if(action==='add'){openPicker(true);return;}
 if(action==='process'){startProcessing();return;}
 if(action==='save'){
  const overlay=el.closest('.sheet-backdrop');
  const retry=overlay?pendingSaveRetry:null;
  pendingSaveRetry=null;
  if(overlay)overlay.remove();
  saveAll(retry);return;
 }
 if(action==='share'){share();return;}
 if(action==='again'){restart();return;}
 if(action==='cancel-process'){cancelWork();state.page='main';render();return;}
 if(action==='close-sheet'){el.closest('.sheet-backdrop').remove();return;}
});
$('#fileInput').addEventListener('change',event=>acceptFiles(event.target.files).catch(error=>{picking=false;render();toast(errorMessage(error));}));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!ioBusy){const overlay=$('.sheet-backdrop');if(overlay)overlay.remove();}});
/* 页面生命周期(2026-09-21 review 第 9 点):真正离开(卸载/WebView 回收/bfcache 冻结)时
   取消进行中的任务并释放引擎资源——release() 丢弃 WebGL 上下文与 LUT 缓存,下次 develop
   自动重建(engine.js renderer 按需 new)。bfcache 恢复(pageshow)时任务已被取消,复位状态
   回主页(照片/配方保留),避免停在冲印页死锁。仅隐藏(切后台)不打断:filmifyYield 在隐藏态
   挂起等待可见(yield.js),冲印随渲染循环自然暂停、回前台继续,任务与进度都无需重来
   (2026-09-22 review 修正:此前注释误写「后台仍会执行完」,与实际挂起行为相反)。 */
let pageLeaving=false;
window.addEventListener('pagehide',()=>{pageLeaving=true;cancelWork();if(FilmifyEngine&&FilmifyEngine.release)FilmifyEngine.release();});
window.addEventListener('pageshow',()=>{if(pageLeaving){pageLeaving=false;cancelWork();ioBusy=false;picking=false;state.page='main';render();}});
/* 部分 WebView 的 innerHeight 包含系统遮挡区；存在更小的 visualViewport.height 时使用可视高度。 */
function viewport(){
 let h=window.innerHeight;
 if(window.visualViewport&&visualViewport.height&&visualViewport.height<h)h=Math.round(visualViewport.height);
 document.documentElement.style.setProperty('--app-height',h+'px');
 positionToast();
}
window.addEventListener('resize',viewport);
if(window.visualViewport)visualViewport.addEventListener('resize',viewport);
assetRoot=$('#studio').getAttribute('data-asset-root')||'./';
FilmifyEngine.init($('#view'),assetRoot);
window.FilmifyPrintDesign.ready().then(()=>{document.querySelectorAll('.brand-logo').forEach(img=>{img.src=window.FilmifyPrintDesign.logoURL();});}).catch(()=>{});
viewport();
/* 预览调试入口(2026-09-22):?proc=N 直落冲印页第 N 段(1 起),不跑真实显影——
   段条定格在该段、当前段流光常动,专供本地调样式;小红书环境无此 query,不会触发 */
const devProc=(location.search.match(/[?&]proc=(\d)/)||[])[1];
if(devProc){state.page='processing';processStep=Math.min(Number(devProc)-1,stageNames.length-1);}
/* 预览调试入口(2026-09-22):?shot=N 直达成片页(N=照片数,默认 1),程序生成渐变测试图
   充当原图/效果图,不跑真实显影;多图(N≥2)不生成拼图,专供本地调成片页样式 */
const devShot=(location.search.match(/[?&]shot=(\d)/)||[])[1];
if(devShot){
 const count=Math.max(1,Math.min(8,Number(devShot)||1));
 const devImg=(w,h,hue,tint)=>{const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d'),g=ctx.createLinearGradient(0,0,w,h);
  g.addColorStop(0,'hsl('+hue+',45%,62%)');g.addColorStop(1,'hsl('+((hue+60)%360)+',40%,38%)');
  ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
  ctx.fillStyle='rgba(255,250,236,.85)';ctx.beginPath();ctx.arc(w*.5,h*.42,Math.min(w,h)*.18,0,7);ctx.fill();
  if(tint){ctx.fillStyle=tint;ctx.globalCompositeOperation='overlay';ctx.fillRect(0,0,w,h);}
  return canvas;};
 (async()=>{
  for(let k=0;k<count;k++){
   const src=URL.createObjectURL(await canvasBlob(devImg(1200,1600,(k*47)%360),'image/jpeg'));
   const out=URL.createObjectURL(await canvasBlob(devImg(1200,1600,(k*47)%360,'rgba(240,105,31,.55)'),'image/jpeg'));
   photos[k]={src:src,thumb:src,thumbNeg:src,thumbNegBW:src,display:src,exposures:{}};
   outputs[k]={blob:null,width:1200,height:1600,url:out};
   state.selected.push(k);
  }
  state.page='result';render();
 })();
}
render();
if(devProc)updateProcessing();
