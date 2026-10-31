'use strict';
/* Finished-photo results and static sharing. Master JPEGs belong to the editor;
   this controller owns only the URLs and bounded template cache it creates. */
window.FilmifyEditorShare=(function(){
 const STYLES={effect:'效果图',frame:'镜框',hanging:'挂绳',compare:'对比图'};
 const SHARE_CAPTIONS=['用个小工具，把日常冲成胶片。','手机里的照片，值得再冲一次。','工具不大，出片有点东西。','小工具，也能冲出大效果。','小小冲印室，出片有惊喜。','给日常，再加点故事感'];
 let captionBag=[],lastCaption='';
 function nextShareCaption(){
  if(!captionBag.length)captionBag=SHARE_CAPTIONS.slice();
  const choices=captionBag.length>1?captionBag.filter(text=>text!==lastCaption):captionBag;
  const text=choices[Math.floor(Math.random()*choices.length)];captionBag.splice(captionBag.indexOf(text),1);lastCaption=text;return text;
 }
 const CACHE_LIMIT=16*1024*1024;
 const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function cancelled(){const error=new Error('已取消');error.cancelled=true;return error;}
 function releaseImages(images){images.forEach(image=>{if(!image)return;if(image.close)image.close();else if(image.tagName==='CANVAS')image.width=image.height=1;else{image.onload=image.onerror=null;image.src='';}});}
 function create(options){
  options=options||{};const container=options.container;
  if(!container||!container.querySelector)throw new Error('分享模块缺少容器');
  const $=selector=>container.querySelector(selector);
  const state={page:'result',selected:[],resultIndex:0};
  let photos={},outputs={},seed=1,theme='black',generation=0,disposed=false,visible=false;
  let shareStyle='effect',shareSelected=null,shareItems=[],shareEpoch=0,sharePreparing=false,shareError='',shareCaption='',dismissShareError=null;
  let resultReturnIndex=0,sharePageIndex=0,resultCollage=null,collagePreparing=false;
  let ioBusy=false,activeIO=null,pendingSaveRetry=null,shareRenderQueue=Promise.resolve();
  let resultViewerClose=null,sharePreviewObserver=null,toastTimer=0,toastElement=null,sheetFocus=null;
  const slideMeta=[],ownedURLs=new Set(),pendingDecodes=new Set(),resourceWaits=new Set(),cache=new Map();let cacheBytes=0;
  const browserMode=()=>window.filmifyBrowserMode?window.filmifyBrowserMode():!(window.xhs&&window.xhs.miniTool);
  function icon(name,size){return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="'+(name==='close'?'m6 6 12 12M18 6 6 18':name==='back'?'m15 6-6 6 6 6':'')+'"/></svg>';}
  function ownURL(blob){const url=URL.createObjectURL(blob);ownedURLs.add(url);return url;}
  function revoke(url){if(ownedURLs.delete(url))URL.revokeObjectURL(url);}
  function current(token){if(disposed||!visible||token!==generation)throw cancelled();}
  function errorMessage(error){return error&&(error.message||error.errMsg)||'操作未完成，请重试';}
  function clearToast(){clearTimeout(toastTimer);if(toastElement)toastElement.remove();toastElement=null;}
  function toast(message,persistent){
   clearToast();toastElement=document.createElement('div');toastElement.className='editor-share-toast';toastElement.setAttribute('role','status');toastElement.textContent=message;document.body.appendChild(toastElement);
   if(!persistent)toastTimer=setTimeout(clearToast,5000);
  }
  function focusIdentity(element){
   const control=element.closest('[data-share-style],[data-share-index],[data-action],.slide');if(!control||!container.contains(control))return null;
   if(control.dataset.shareStyle!==undefined)return {kind:'style',value:control.dataset.shareStyle};
   if(control.dataset.shareIndex!==undefined)return {kind:'photo',value:state.selected[Number(control.dataset.shareIndex)]};
   if(control.dataset.action!==undefined)return {kind:'action',value:control.dataset.action};
   const track=$('#track');return track?{kind:'slide',value:Array.from(track.children).indexOf(control)}:null;
  }
  function rememberFocus(){const element=document.activeElement;return element&&container.contains(element)?{element:element,identity:focusIdentity(element)}:null;}
  function focusTarget(identity){
   if(!identity)return null;
   if(identity.kind==='slide'){const track=$('#track');return track&&track.children[identity.value];}
   const attribute=identity.kind==='style'?'shareStyle':identity.kind==='photo'?'shareIndex':'action',value=identity.kind==='photo'?String(state.selected.indexOf(identity.value)):identity.value;
   return Array.from(container.querySelectorAll('button')).find(button=>button.dataset[attribute]===value)||null;
  }
  function focusElement(element){if(!element||element.disabled||typeof element.focus!=='function')return;try{element.focus({preventScroll:true});}catch(error){element.focus();}}
  function restoreFocus(bookmark,preferred){
   // Restore only the focus this operation removed. A later user focus in
   // another control or outside this controller must keep its current owner.
   if(!bookmark||disposed||!visible||document.hidden||document.activeElement!==document.body&&document.activeElement!==document.documentElement)return;
   const fallback=state.page==='sharePage'?focusTarget({kind:'style',value:shareStyle}):focusTarget({kind:'slide',value:state.resultIndex});
   focusElement(focusTarget(preferred)||(!preferred&&bookmark.element.isConnected&&container.contains(bookmark.element)?bookmark.element:null)||focusTarget(bookmark.identity)||fallback);
  }
  function closeSheet(restore){const overlay=$('.sheet-backdrop'),bookmark=sheetFocus;sheetFocus=null;if(!overlay)return null;const removedFocus=overlay.contains(document.activeElement);overlay.remove();if(restore!==false&&removedFocus)restoreFocus(bookmark);return removedFocus?bookmark:null;}
  function sheet(title,body,action,label,returnFocus){
   const bookmark=returnFocus||sheetFocus||rememberFocus();closeSheet(false);sheetFocus=bookmark;const overlay=document.createElement('div');overlay.className='sheet-backdrop';
   overlay.innerHTML='<section class="sheet" role="dialog" aria-modal="true" aria-label="'+esc(title)+'"><div class="sheet-head"><h3>'+esc(title)+'</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">'+icon('close',18)+'</button></div>'+body+(label?'<button class="primary" data-action="'+action+'">'+esc(label)+'</button>':'')+'</section>';
   container.appendChild(overlay);overlay.addEventListener('click',event=>{if(event.target===overlay)closeSheet();});
   overlay.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeSheet();}if(event.key==='Tab'){const buttons=Array.from(overlay.querySelectorAll('button'));const first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
   overlay.querySelector('button').focus();
  }
  function decode(url,guard){return new Promise((resolve,reject)=>{
   const image=new Image();let done=false;
   let timer=0,poll=0;
   const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);clearInterval(poll);pendingDecodes.delete(abort);image.onload=image.onerror=null;if(error){image.src='';reject(error);}else resolve(image);};
   const check=()=>{if(done)return false;try{if(guard)guard();return true;}catch(error){finish(error);return false;}};
   const abort=()=>finish(cancelled());pendingDecodes.add(abort);
   if(!check())return;
   timer=setTimeout(()=>finish(new Error('照片读取超时，请重试')),30000);if(guard)poll=setInterval(check,25);
   image.onload=()=>{if(check())finish();};
   image.onerror=()=>finish(new Error('照片读取失败，请重试'));
   try{image.src=url;}catch(error){finish(error);}
  });}
  function cancelResourceWaits(){resourceWaits.forEach(abort=>abort());resourceWaits.clear();}
  function waitForResource(promise,guard,message,releaseLate,shared){return new Promise((resolve,reject)=>{
   let done=false,timer=0,poll=0;
   const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);clearInterval(poll);resourceWaits.delete(abort);if(error)reject(error);else resolve(value);};
   const check=()=>{if(done)return false;try{guard();return true;}catch(error){finish(error);return false;}};
   const abort=()=>finish(cancelled());if(shared!==false)resourceWaits.add(abort);
   timer=setTimeout(()=>finish(new Error(message||'素材加载超时，请重试')),30000);poll=setInterval(check,25);
   promise.then(value=>{if(done){if(releaseLate)releaseLate(value);return;}if(check())finish(null,value);else if(releaseLate)releaseLate(value);},error=>finish(error));
  });}
  async function cellImage(blob,w,h,edge,guard){
   guard();const scale=Math.min(1,edge/Math.max(w,h)),rw=Math.max(1,Math.round(w*scale)),rh=Math.max(1,Math.round(h*scale));
   if(typeof createImageBitmap==='function'){
    let bitmap=null;
    try{bitmap=await waitForResource(createImageBitmap(blob,{resizeWidth:rw,resizeHeight:rh,resizeQuality:'high'}),guard,'照片解码超时，请重试',value=>value.close(),false);guard();if(bitmap.width===rw&&bitmap.height===rh)return bitmap;}
    catch(error){if(error.cancelled){if(bitmap)bitmap.close();throw error;}}
    if(bitmap)bitmap.close();
   }
   const url=ownURL(blob);let image=null,canvas=null;
   try{
    image=await decode(url,guard);guard();canvas=document.createElement('canvas');canvas.width=rw;canvas.height=rh;
    const g=canvas.getContext('2d',{alpha:false});g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';g.drawImage(image,0,0,rw,rh);guard();return canvas;
   }catch(error){if(canvas)canvas.width=canvas.height=1;throw error;}
   finally{releaseImages([image]);revoke(url);}
  }
  async function shareTemplateImage(record,edge,guard,source){
   const blob=source?(record.sourceBlob||record.file):record.blob;
   const previewURL=record.previewURL||record.display||record.url;
   // Inspect actual preview dimensions: a 1152 editor preview cannot silently
   // replace the higher-resolution source pixels required by a share template.
   if(previewURL){let image=null;
    try{image=await decode(previewURL,guard);guard();if(Math.max(image.naturalWidth,image.naturalHeight)>=Math.min(edge,Math.max(record.width,record.height)))return image;}
    catch(error){if(error.cancelled)throw error;}
    releaseImages([image]);
   }
   return cellImage(blob,record.width,record.height,edge,guard);
  }
  function previewBlob(blob){return window.FilmifyPrintDesign.previewBlob(blob);}
  function getCache(key){const item=cache.get(key);if(!item)return null;cache.delete(key);cache.set(key,item);return item.blob;}
  function putCache(key,blob){
   const small=previewBlob(blob),bytes=blob.size+(small===blob?0:small.size),old=cache.get(key);
   if(old){cacheBytes-=old.bytes;cache.delete(key);}if(bytes>CACHE_LIMIT)return;
   while(cacheBytes+bytes>CACHE_LIMIT&&cache.size){const first=cache.keys().next().value;cacheBytes-=cache.get(first).bytes;cache.delete(first);}
   cache.set(key,{blob:blob,bytes:bytes});cacheBytes+=bytes;
  }
  function disposeShareItems(items){items.forEach(item=>{if(item.owned)revoke(item.url);});}
  function selectedShareIds(){return state.selected.filter(id=>shareSelected===null||shareSelected.indexOf(id)!==-1);}
  function signature(){return generation+'|'+shareStyle+'|'+selectedShareIds().join(',');}
  function displayItems(){return state.page==='sharePage'?shareItems:state.selected.map(id=>({blob:outputs[id].blob,url:outputs[id].previewURL,label:'效果图',name:'photo-'+id})).concat(resultCollage?[resultCollage]:[]);}
  function result(){return '<div class="flow result-flow"><div class="result-mid"><div class="swiper" id="swiper"><div class="track" id="track"></div></div><div class="dots" id="dots"></div>'+(collagePreparing?'<p class="editor-collage-status" role="status">正在生成拼图</p>':'')+'</div><footer class="bottom-bar main-footer result-footer action-footer"><button class="againlink action-return" data-action="back" aria-label="返回编辑页，调整效果">'+icon('back',16)+'<span>返回</span></button><button class="btn orange action-main" data-action="share">分享</button><button class="btn ghost action-aux" data-action="download-result" aria-label="保存成片">保存</button></footer></div>';}
  function sharePage(){
   const ids=selectedShareIds(),ready=!sharePreparing&&!shareError&&shareItems.length>0;
   const choices=Object.keys(STYLES).map(key=>'<button data-share-style="'+key+'" aria-pressed="'+(shareStyle===key)+'">'+STYLES[key]+'</button>').join('');
   // Selection thumbnails identify the source photo; use the editor's small
   // source thumbnail rather than decoding nine 1600px delivery previews.
   const thumbs=state.selected.map((id,i)=>'<button class="share-thumb" data-share-index="'+i+'" aria-label="照片 '+(i+1)+'" aria-pressed="'+(ids.indexOf(id)!==-1)+'"><img src="'+esc(photos[id].previewURL||outputs[id].previewURL)+'" alt=""><span aria-hidden="true">'+(ids.indexOf(id)!==-1?'✓':'')+'</span></button>').join('');
   return '<div class="flow result-flow share-flow"><header class="share-header"><h2>分享图片</h2></header><div class="share-styles" role="group" aria-label="分享样式">'+choices+'</div><div class="result-mid share-fit">'+(sharePreparing&&!shareItems.length?'<p class="share-status" role="status">正在生成分享内容，请稍后。</p>':shareError?'<div class="share-status" role="status"><p>'+esc(shareError)+'</p><button data-action="share-retry">重新生成</button></div>':!ids.length?'<p class="share-status">选择下方照片，预览分享效果</p>':'<div class="share-stage"><div class="swiper" id="swiper"><div class="track" id="track"></div></div></div><div class="dots" id="dots"></div>')+'</div><div class="share-options"><p class="share-progress" role="status"'+(sharePreparing&&shareItems.length?'':' hidden')+'>正在生成分享内容，请稍后。</p>'+(state.selected.length>1?'<div class="share-selection-label">选择照片 <span>已选 '+ids.length+' 张</span></div><div class="share-thumbs" role="group" aria-label="要分享的照片">'+thumbs+'</div>':'')+'</div><footer class="bottom-bar main-footer result-footer action-footer"><button class="share-back action-return" data-action="share-back" aria-label="返回成片">'+icon('back',16)+'<span>返回</span></button>'+(browserMode()?'':'<button class="btn orange action-main" data-action="publish"'+(ready?'':' disabled')+'>分享'+(ready?' '+shareItems.length+' 张':'')+'</button>')+'<button class="btn '+(browserMode()?'orange action-main':'ghost action-aux')+'" data-action="save-share" aria-label="'+(browserMode()?'保存分享图'+(ready?'，共 '+shareItems.length+' 张':''):'保存到相册')+'"'+(ready?'':' disabled')+'>'+(browserMode()?'保存分享图':'保存')+'</button></footer></div>';
  }
  function resultImage(src,caption){const image=new Image();image.alt=caption;image.draggable=false;if(src)image.src=src;return image;}
  function addImageSlide(track,src,caption,cls,fullBlob){const slide=document.createElement('div');slide.className='slide'+(cls?' '+cls:'');slide._fullBlob=fullBlob;slide._previewURL=src;slide.appendChild(resultImage('',caption));slide.setAttribute('role','button');slide.setAttribute('aria-label','放大查看');slide.setAttribute('aria-haspopup','dialog');track.appendChild(slide);slideMeta.push(caption);}
  function updateResultPagination(){const dots=$('#dots'),num=dots&&dots.querySelector('.num');if(num)num.textContent=(state.resultIndex+1)+' / '+slideMeta.length;if(dots)dots.setAttribute('aria-label','第 '+(state.resultIndex+1)+' 页，共 '+slideMeta.length+' 页');}
  function slideTo(index,keyboard){
   const track=$('#track');if(!track)return;track.style.transform='translateX('+(-index*100)+'%)';
   Array.from(track.children).forEach((slide,i)=>{slide.tabIndex=i===index?0:-1;const image=slide.firstElementChild;if(image&&image.tagName==='IMG'&&!slide.classList.contains('viewer-content')){if(Math.abs(i-index)<=1){if(image.getAttribute('src')!==slide._previewURL)image.src=slide._previewURL;}else image.removeAttribute('src');}});
   updateResultPagination();if(keyboard)focusElement(track.children[index]);
  }
  function fitSharePreview(){const stage=$('.share-stage'),sw=$('#swiper');if(!stage||!sw||!sw.classList.contains('hanging-strip'))return;const width=Math.max(0,Math.min(stage.clientWidth-40,stage.clientHeight*.75));sw.style.width=width+'px';sw.style.height=(width*4/3)+'px';}
  function setupResult(){
   const track=$('#track');if(!track)return;$('#swiper').classList.toggle('hanging-strip',state.page==='sharePage'&&shareStyle==='hanging');slideMeta.length=0;
   displayItems().forEach(item=>addImageSlide(track,item.url,item.label,item.collage?'collage':'',item.blob));state.resultIndex=Math.max(0,Math.min(state.resultIndex,track.children.length-1));
   $('#dots').innerHTML='<span class="num"></span>';$('#dots').setAttribute('aria-live','polite');slideTo(state.resultIndex);fitSharePreview();bindSwipe($('#swiper'));
   if(state.page==='sharePage'&&typeof ResizeObserver==='function'){sharePreviewObserver=new ResizeObserver(fitSharePreview);sharePreviewObserver.observe($('.share-stage'));}
  }
  function render(preferred){if(!visible||disposed)return;if(resultViewerClose)resultViewerClose();const bookmark=rememberFocus();if(sharePreviewObserver)sharePreviewObserver.disconnect();sharePreviewObserver=null;sheetFocus=null;container.innerHTML=state.page==='sharePage'?sharePage():result();setupResult();setIOLock();if(bookmark&&!bookmark.element.isConnected)restoreFocus(bookmark,preferred);}
  function bindSwipe(sw){
   const track=$('#track');let gesture=null;
   sw.addEventListener('dragstart',event=>event.preventDefault());
   sw.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openResultViewer();}else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();state.resultIndex=Math.max(0,Math.min(slideMeta.length-1,state.resultIndex+(event.key==='ArrowRight'?1:-1)));slideTo(state.resultIndex,true);}});
   sw.addEventListener('pointerdown',event=>{if(event.isPrimary===false){if(gesture)gesture.axis='multi';return;}if(event.button>0||gesture||resultViewerClose||ioBusy)return;gesture={target:event.target,started:event.timeStamp,id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,time:event.timeStamp,velocity:0,dx:0,width:sw.clientWidth,base:track.getBoundingClientRect().left-sw.getBoundingClientRect().left,index:state.resultIndex,axis:''};});
   sw.addEventListener('pointermove',event=>{const q=gesture;if(!q||event.pointerId!==q.id)return;const dx=event.clientX-q.x,dy=event.clientY-q.y;if(!q.axis){if(Math.max(Math.abs(dx),Math.abs(dy))<6)return;q.axis=Math.abs(dx)>Math.abs(dy)?'x':'y';}if(q.axis!=='x')return;if(!track.classList.contains('drag')){track.classList.add('drag');try{sw.setPointerCapture(event.pointerId);}catch(ignore){}}const dt=event.timeStamp-q.time;if(dt>0)q.velocity=(event.clientX-q.lastX)/dt;q.lastX=event.clientX;q.time=event.timeStamp;q.dx=dx;let offset=q.base+dx;const min=-(slideMeta.length-1)*q.width;if(offset>0)offset*=.25;else if(offset<min)offset=min+(offset-min)*.25;track.style.transform='translate3d('+offset+'px,0,0)';});
   function end(event,aborted){const q=gesture;if(!q||event.pointerId!==q.id)return;gesture=null;let next=q.index;if(!aborted&&q.axis==='x'){const flick=event.timeStamp-q.time<100&&Math.abs(q.dx)>16&&Math.abs(q.velocity)>.45;if(Math.abs(q.dx)>Math.min(64,q.width*.18)||flick)next=q.index+(q.dx<0?1:-1);}state.resultIndex=Math.max(0,Math.min(slideMeta.length-1,next));track.classList.remove('drag');slideTo(state.resultIndex);try{if(sw.hasPointerCapture(q.id))sw.releasePointerCapture(q.id);}catch(ignore){}if(!aborted&&!q.axis&&event.timeStamp-q.started<500&&Math.hypot(event.clientX-q.x,event.clientY-q.y)<6&&q.target.closest('.slide'))openResultViewer();}
   sw.addEventListener('pointerup',event=>end(event,false));sw.addEventListener('pointercancel',event=>end(event,true));sw.addEventListener('lostpointercapture',event=>{if(event.target===sw)end(event,true);});sw.addEventListener('pointerleave',event=>{if(gesture&&gesture.axis!=='x')end(event,true);});
  }

  // The existing result viewer is appended below: only the current page decodes
  // a master, and closing returns its original lightweight image to the list.
function openResultViewer(){
 if(resultViewerClose||ioBusy||(state.page!=='result'&&state.page!=='sharePage'))return;
 let slide=$('#track')&&$('#track').children[state.resultIndex];
 if(!slide||!slide.firstElementChild)return;
 const screen=container,focus=document.activeElement,initialIndex=state.resultIndex;
 let slot=null;
 const connected=state.page==='sharePage'&&shareStyle==='hanging',neighbors=[];
 const overlay=document.createElement('div');overlay.className='result-viewer';
 overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','放大查看成片');
 overlay.innerHTML='<div class="viewer-stage"></div><button class="viewer-close" aria-label="关闭放大查看">'+icon('close',24)+'</button>';
 const stage=overlay.querySelector('.viewer-stage'),close=overlay.querySelector('.viewer-close');
 document.body.appendChild(overlay);screen.setAttribute('inert','');screen.setAttribute('aria-hidden','true');
 let scale=1,x=0,y=0,swipeX=0,width=1,height=1,closed=false,lastTap=null,gesture=null,fullURL='',fullImage=null,originalImage=null;
 const pointers=new Map();
 function paint(){
  const r=stage.getBoundingClientRect(),limitX=Math.max(0,(width*scale-r.width)/2),limitY=Math.max(0,(height*scale-r.height)/2);
  x=Math.max(-limitX,Math.min(limitX,x));y=Math.max(-limitY,Math.min(limitY,y));
  slide.style.transform='translate3d('+(x+swipeX)+'px,'+y+'px,0) scale('+scale+')';
  neighbors.forEach(image=>{image.hidden=scale!==1;});
 }
 function fit(reset){
  if(closed)return;
  const media=slide.firstElementChild;if(!media)return;
  const w=media.naturalWidth||media.width,h=media.naturalHeight||media.height;if(!w||!h)return;
  const r=stage.getBoundingClientRect(),ratio=Math.min(r.width/w,r.height/h);
  width=w*ratio;height=h*ratio;slide.style.width=width+'px';slide.style.height=height+'px';
  if(reset!==false){scale=1;x=y=swipeX=0;pointers.clear();gesture=null;lastTap=null;}
  paint();
 }
 function point(e){const r=stage.getBoundingClientRect();return{x:e.clientX-r.left-r.width/2,y:e.clientY-r.top-r.height/2};}
 function basis(){
  const a=Array.from(pointers.values());if(!a.length){gesture=null;return;}
  const mid=a.length>1?{x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2}:{x:a[0].x,y:a[0].y};
  gesture={mid:mid,distance:a.length>1?Math.hypot(a[1].x-a[0].x,a[1].y-a[0].y):0,scale:scale,x:x,y:y};
 }
 function zoomAt(next,p){const old=scale;swipeX=0;scale=Math.max(1,Math.min(4,next));x=p.x-(p.x-x)*scale/old;y=p.y-(p.y-y)*scale/old;paint();}
 function toggle(p){if(scale>1.05){scale=1;x=y=0;paint();}else zoomAt(2.5,p);}
 stage.addEventListener('pointerdown',e=>{
  if(e.button>0)return;e.preventDefault();
  const p=point(e);p.startX=p.x;p.startY=p.y;p.time=e.timeStamp;p.tap=true;p.blank=e.target===stage;
  p.swipe=scale===1;p.axis='';p.lastX=p.x;p.lastTime=e.timeStamp;p.velocity=0;
  pointers.set(e.pointerId,p);
  if(pointers.size>1){pointers.forEach(q=>{q.tap=false;q.swipe=false;});lastTap=null;swipeX=0;paint();}
  try{stage.setPointerCapture(e.pointerId);}catch(error){}
  basis();
 });
 stage.addEventListener('pointermove',e=>{
  const p=pointers.get(e.pointerId);if(!p||!gesture)return;
  const next=point(e);p.x=next.x;p.y=next.y;if(Math.hypot(p.x-p.startX,p.y-p.startY)>6)p.tap=false;
  const a=Array.from(pointers.values());
  if(a.length>1){
   const mid={x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2};
   const distance=Math.hypot(a[1].x-a[0].x,a[1].y-a[0].y);
   scale=Math.max(1,Math.min(4,gesture.scale*distance/Math.max(1,gesture.distance)));
   x=mid.x-(gesture.mid.x-gesture.x)*scale/gesture.scale;y=mid.y-(gesture.mid.y-gesture.y)*scale/gesture.scale;
  }else if(p.swipe){
   const dx=p.x-p.startX,dy=p.y-p.startY;
   if(!p.axis&&Math.max(Math.abs(dx),Math.abs(dy))>=6)p.axis=Math.abs(dx)>Math.abs(dy)?'x':'y';
   const dt=e.timeStamp-p.lastTime;if(dt>0)p.velocity=(p.x-p.lastX)/dt;
   p.lastX=p.x;p.lastTime=e.timeStamp;
   if(p.axis==='x')swipeX=dx*((dx>0&&state.resultIndex===0)||(dx<0&&state.resultIndex===slideMeta.length-1)?.25:1);
  }else{x=gesture.x+p.x-gesture.mid.x;y=gesture.y+p.y-gesture.mid.y;}
  paint();
 });
 function end(e,cancelled){
  const p=pointers.get(e.pointerId);if(!p)return;
  pointers.delete(e.pointerId);basis();
  swipeX=0;paint();
  if(cancelled){lastTap=null;return;}
  const endPoint=point(e);
  if(p.swipe&&p.axis==='x'&&!pointers.size){
   const dx=endPoint.x-p.startX,flick=e.timeStamp-p.lastTime<100&&Math.abs(dx)>16&&Math.abs(p.velocity)>.45;
   lastTap=null;
   if(Math.abs(dx)>Math.min(64,stage.clientWidth*.18)||flick)navigate(dx<0?1:-1);
   return;
  }
  if(!p.tap||Math.hypot(endPoint.x-p.startX,endPoint.y-p.startY)>6||e.timeStamp-p.time>400)return;
  if(p.blank&&e.target===stage&&scale===1){resultViewerClose();return;}
  if(lastTap&&e.timeStamp-lastTap.time<320&&Math.hypot(p.x-lastTap.x,p.y-lastTap.y)<30){toggle(p);lastTap=null;}
  else lastTap={x:p.x,y:p.y,time:e.timeStamp};
 }
 stage.addEventListener('pointerup',e=>end(e,false));stage.addEventListener('pointercancel',e=>end(e,true));
 stage.addEventListener('lostpointercapture',e=>{if(e.target===stage)end(e,true);});stage.addEventListener('dragstart',e=>e.preventDefault());
 stage.addEventListener('wheel',e=>{e.preventDefault();zoomAt(scale*Math.exp(-e.deltaY*.002),point(e));},{passive:false});
 // Late full-resolution/neighbor loads must not cancel an active swipe or zoom.
 const fitMedia=()=>fit(false),observer=new MutationObserver(fitMedia);
 function releaseSlide(){
  observer.disconnect();slide.removeEventListener('load',fitMedia,true);
  neighbors.forEach(image=>{image.remove();image.src='';});neighbors.length=0;
  if(fullImage){fullImage.onload=fullImage.onerror=null;if(originalImage&&fullImage.parentNode===slide)fullImage.replaceWith(originalImage);fullImage.src='';}
  if(fullURL)URL.revokeObjectURL(fullURL);
  fullURL='';fullImage=originalImage=null;
  slide.classList.remove('viewer-content');slide.removeAttribute('style');slide.setAttribute('role','button');
  slot.replaceWith(slide);pointers.clear();gesture=null;lastTap=null;
 }
 function mountSlide(){
  slot=document.createElement('div');slot.className='slide';slot.style.height=slide.getBoundingClientRect().height+'px';slide.replaceWith(slot);
  stage.appendChild(slide);slide.classList.add('viewer-content');slide.removeAttribute('role');slide.removeAttribute('tabindex');
  updateResultPagination();
  if(connected)[-1,1].forEach(delta=>{
   const item=shareItems[state.resultIndex+delta];if(!item)return;
   const image=new Image();image.className='viewer-neighbor';image.setAttribute('aria-hidden','true');image.alt='';image.draggable=false;image.style.left=(delta*100)+'%';image.src=item.url;
   neighbors.push(image);slide.appendChild(image);
  });
  observer.observe(slide,{childList:true});slide.addEventListener('load',fitMedia,true);fit();
  if(slide._fullBlob){
   const target=slide,image=new Image();fullImage=image;image.alt=slide.firstElementChild.alt;image.draggable=false;
   image.onload=()=>{if(closed||fullImage!==image||slide!==target)return;originalImage=target.firstElementChild;originalImage.replaceWith(image);};
   image.onerror=()=>{if(!closed&&fullImage===image)toast('原尺寸加载失败，当前显示预览图');};
   fullURL=URL.createObjectURL(slide._fullBlob);image.src=fullURL;
  }
 }
 function navigate(delta){
  const next=Math.max(0,Math.min(slideMeta.length-1,state.resultIndex+delta));if(next===state.resultIndex)return;
  releaseSlide();state.resultIndex=next;slide=$('#track').children[next];mountSlide();slideTo(next);
 }
 window.addEventListener('resize',fit);
 if(window.visualViewport)visualViewport.addEventListener('resize',fit);
 resultViewerClose=()=>{
  if(closed)return;closed=true;resultViewerClose=null;
  releaseSlide();window.removeEventListener('resize',fit);
  if(window.visualViewport)visualViewport.removeEventListener('resize',fit);
  overlay.remove();screen.removeAttribute('inert');screen.removeAttribute('aria-hidden');slideTo(state.resultIndex);
  (state.resultIndex===initialIndex&&focus&&focus.isConnected&&focus!==document.body?focus:slide).focus({preventScroll:true});
 };
 close.addEventListener('click',()=>resultViewerClose&&resultViewerClose());
 overlay.addEventListener('click',e=>{if(e.target===overlay&&resultViewerClose)resultViewerClose();});
 overlay.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();resultViewerClose();}
  else if(e.key==='Tab'){e.preventDefault();close.focus();}
  else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();navigate(e.key==='ArrowRight'?1:-1);}
  else if(e.key==='0'){scale=1;x=y=0;paint();}
  else if(e.key==='+'||e.key==='='){e.preventDefault();zoomAt(scale*1.5,{x:0,y:0});}
  else if(e.key==='-'){e.preventDefault();zoomAt(scale/1.5,{x:0,y:0});}
 });
 mountSlide();close.focus({preventScroll:true});
}

  async function enqueue(work){
   const previous=shareRenderQueue;let finish;
   shareRenderQueue=new Promise(resolve=>{finish=resolve;});
   await previous;try{return await work();}finally{finish();}
  }
  async function yieldTask(guard){await new Promise(resolve=>setTimeout(resolve,0));guard();}
  async function composeTemplate(style,id,index,ids,guard){
   const output=outputs[id],photo=photos[id];let images=[];
   try{
    const caption={film:'',paper:null,theme:theme,plainFrame:true,effectLabel:'EFFECT'};
    if(style==='compare'){
     const edge=window.FilmifyCompare.layout(output.width,output.height).sourceEdge;
     images.push(await shareTemplateImage(photo,edge,guard,true));guard();
     images.push(await shareTemplateImage(output,edge,guard));guard();
     const blob=await window.FilmifyCompare.render(images[0],images[1],caption,output,guard);guard();return blob;
    }
    const edge=style==='frame'?window.FilmifyPrintDesign.shareLayout(output.width,output.height,caption).sourceEdge:1856;
    images.push(await shareTemplateImage(output,edge,guard));guard();
    const blob=style==='frame'?await window.FilmifyPrintDesign.compose(images[0],caption,false,output,guard):await window.FilmifyClothesline.compose(images[0],index,window.FilmifyClothesline.scene(seed,ids.length,null),guard);
    guard();return blob;
   }finally{releaseImages(images);}
  }
  async function refreshSharePage(preferred){
   if(typeof dismissShareError==='function')dismissShareError();dismissShareError=null;
   cancelResourceWaits();
   const token=generation,epoch=++shareEpoch,key=signature(),ids=selectedShareIds(),style=shareStyle,items=[];
   const guard=()=>{current(token);if(document.hidden||state.page!=='sharePage'||epoch!==shareEpoch||key!==signature())throw cancelled();};
   const add=(blob,label,id)=>items.push({blob:blob,url:ownURL(previewBlob(blob)),owned:true,label:label,name:style+'-'+id});
   disposeShareItems(shareItems);shareItems=[];sharePreparing=ids.length>0;shareError='';state.resultIndex=0;render(preferred);
   try{
    if(style==='effect'){
     guard();ids.forEach(id=>items.push({blob:outputs[id].blob,url:outputs[id].previewURL,label:'效果图',name:'photo-'+id}));
    }else if(ids.length){
     await enqueue(async()=>{
      guard();if(style==='hanging'){await waitForResource(window.FilmifyClothesline.ready(),guard);guard();}
      if(style==='compare'){await waitForResource(window.FilmifyPrintDesign.ready(),guard);guard();}
      for(let i=0;i<ids.length;i++){
       guard();const id=ids[i],cacheKey=token+'|'+style+'|'+id+'|'+theme+(style==='hanging'?'|'+ids.join(','):'');
       let blob=getCache(cacheKey);if(!blob){blob=await composeTemplate(style,id,i,ids,guard);guard();putCache(cacheKey,blob);}
       guard();add(blob,STYLES[style],id);await yieldTask(guard);
      }
     });
    }
    guard();shareItems=items;sharePreparing=false;render();
   }catch(error){disposeShareItems(items);if(epoch===shareEpoch&&visible&&!disposed&&state.page==='sharePage'){sharePreparing=false;shareItems=[];if(!error.cancelled){shareError=errorMessage(error);if(options.onError)dismissShareError=options.onError(error);}render();}}
  }
  async function composeResultCollage(token){
   const ids=state.selected.slice(),guard=()=>current(token);let images=[];
   try{
    const blob=await enqueue(async()=>{
     guard();for(const id of ids){images.push(await cellImage(outputs[id].blob,outputs[id].width,outputs[id].height,400,guard));guard();}
     const value=await window.FilmifyCollageGrid.composeStatic(images,'',seed,{plainCaption:true},guard);guard();return value;
    });
    guard();resultCollage={blob:blob,url:ownURL(previewBlob(blob)),owned:true,label:'拼图',name:'collage',collage:true};collagePreparing=false;
    // Do not interrupt a user's current fullscreen slide or share selection.
    if(state.page==='result'){
     const track=$('#track');if(track){addImageSlide(track,resultCollage.url,resultCollage.label,'collage',resultCollage.blob);slideTo(state.resultIndex);}
     const status=$('.editor-collage-status');if(status)status.remove();
    }
   }catch(error){if(token===generation&&!disposed){collagePreparing=false;const status=$('.editor-collage-status');if(status)status.remove();if(!error.cancelled&&options.onError)options.onError(error);}}
   finally{releaseImages(images);}
  }
  function setIOLock(){container.querySelectorAll('[data-action],[data-share-style],[data-share-index]').forEach(button=>{const back=button.dataset.action==='share-back'||button.dataset.action==='back';if(ioBusy&&!back){if(!button.disabled)button.dataset.ioEnabled='true';button.disabled=true;}else if(button.dataset.ioEnabled){delete button.dataset.ioEnabled;button.disabled=false;}});}
  function cancelIO(){const task=activeIO;if(task){task.cancelled=true;if(task.abort)task.abort();}activeIO=null;ioBusy=false;pendingSaveRetry=null;setIOLock();clearToast();}
  function waitForIO(promise,task,guard){return new Promise((resolve,reject)=>{
   let done=false;const finish=(error,value)=>{if(done)return;done=true;task.abort=null;if(error)reject(error);else resolve(value);};
   task.abort=()=>finish(cancelled());
   promise.then(value=>{if(done)return;try{guard();finish(null,value);}catch(error){finish(error);}},error=>finish(error));
  });}
  function readyShareItems(){if(state.page!=='sharePage'||sharePreparing||shareError||!shareItems.length)throw new Error('请先选择照片并等待预览完成');return shareItems.map(item=>({blob:item.blob,name:item.name}));}
  async function saveAll(retry,returnFocus){
   if(ioBusy||disposed||!visible)return;
   const task={cancelled:false,type:'save',returnFocus:returnFocus||rememberFocus()},token=generation;activeIO=task;ioBusy=true;setIOLock();
   const guard=()=>{current(token);if(task.cancelled||activeIO!==task)throw cancelled();};
   try{
    const items=retry|| (state.page==='sharePage'?readyShareItems():state.selected.map(id=>({blob:outputs[id].blob,name:'photo-'+id})));
    if(!items.length)return;guard();let completed=0,lastError='';const failed=[];toast('正在保存 0/'+items.length,true);
    for(const item of items){
     guard();try{await waitForIO(window.filmifySavePhoto(item.blob,item.name,guard),task,guard);guard();completed++;}catch(error){guard();if(error.cancelled)throw error;lastError=errorMessage(error);failed.push(item);}
     toast('正在保存 '+(completed+failed.length)+'/'+items.length,true);
    }
    guard();clearToast();
    if(failed.length){pendingSaveRetry=failed;sheet(completed?'部分照片未保存':'照片未保存','<p>'+completed+' 张'+(browserMode()?'已发起下载':'已保存')+'，'+failed.length+' 张未完成。</p><p>'+esc(lastError)+'</p>','retry-save','重试未完成的 '+failed.length+' 张照片',task.returnFocus);}
    else toast(browserMode()?'已发起 '+completed+' 张下载，请在浏览器下载中查看':'已保存 '+completed+' 张');
   }catch(error){if(activeIO===task&&!error.cancelled)toast(errorMessage(error));}
   finally{if(activeIO===task){activeIO=null;ioBusy=false;setIOLock();if(returnFocus)restoreFocus(returnFocus);}}
  }
  async function share(){
   if(ioBusy||disposed||!visible||document.hidden)return;
   const task={cancelled:false,type:'share',submitted:false},token=generation;activeIO=task;ioBusy=true;setIOLock();
   const guard=submitting=>{current(token);if(task.cancelled||activeIO!==task||document.hidden&&!task.submitted)throw cancelled();if(submitting)task.submitted=true;};
   try{guard();const items=readyShareItems();toast('正在准备分享',true);await waitForIO(window.filmifySharePhotos(items.map(item=>item.blob),{content:shareCaption+'\n\n#Filmify #胶片感',tags:'Filmify,胶片感'},guard),task,guard);if(activeIO===task)clearToast();}
   catch(error){if(activeIO===task&&!error.cancelled)toast(errorMessage(error));}
   finally{if(activeIO===task){activeIO=null;ioBusy=false;setIOLock();}}
  }
  function downloadResult(){
   pendingSaveRetry=null;
   if(state.selected.length===1&&!resultCollage){saveAll();return;}
   sheet('保存照片','<div class="download-choices"><button class="choice-row" data-action="save-current">保存当前'+(state.resultIndex>=state.selected.length?'拼图':'照片')+'</button><button class="choice-row" data-action="save-all">保存全部照片（'+state.selected.length+' 张）</button></div>');
  }
  function onClick(event){
   const button=event.target.closest('button');if(!button||!container.contains(button)||button.disabled)return;
   if(ioBusy){if(button.dataset.action==='share-back'||button.dataset.action==='back')cancelIO();else return;}
   if(button.dataset.shareStyle!==undefined){shareStyle=button.dataset.shareStyle;refreshSharePage();return;}
   if(button.dataset.shareIndex!==undefined){const id=state.selected[Number(button.dataset.shareIndex)],ids=selectedShareIds();shareSelected=ids.indexOf(id)!==-1?ids.filter(n=>n!==id):ids.concat(id);refreshSharePage();return;}
   const action=button.dataset.action;
   if(action==='close-sheet'){closeSheet();return;}
   if(action==='back'){hide();if(options.onBack)options.onBack();return;}
   if(action==='share'){shareCaption=nextShareCaption();resultReturnIndex=state.resultIndex;state.resultIndex=sharePageIndex;state.page='sharePage';pendingSaveRetry=null;clearToast();refreshSharePage({kind:'style',value:shareStyle});return;}
   if(action==='share-back'){shareEpoch++;cancelResourceWaits();pendingSaveRetry=null;sharePreparing=false;sharePageIndex=state.resultIndex;state.resultIndex=resultReturnIndex;state.page='result';render({kind:'action',value:'share'});return;}
   if(action==='share-retry'){refreshSharePage();return;}
   if(action==='download-result'){downloadResult();return;}
   if(action==='save-current'){const item=displayItems()[state.resultIndex],bookmark=closeSheet(false);if(item)saveAll([{blob:item.blob,name:item.name}],bookmark);return;}
   if(action==='retry-save'){const retry=pendingSaveRetry;pendingSaveRetry=null;const bookmark=closeSheet(false);saveAll(retry,bookmark);return;}
   if(action==='save-all'||action==='save-share'){pendingSaveRetry=null;const bookmark=closeSheet(false);saveAll(null,bookmark);return;}
   if(action==='publish')share();
  }
  function clearSession(){
   if(typeof dismissShareError==='function')dismissShareError();dismissShareError=null;shareCaption='';
   generation++;shareEpoch++;cancelResourceWaits();cancelIO();if(resultViewerClose)resultViewerClose();if(sharePreviewObserver)sharePreviewObserver.disconnect();sharePreviewObserver=null;
   pendingDecodes.forEach(abort=>abort());pendingDecodes.clear();ownedURLs.forEach(url=>URL.revokeObjectURL(url));ownedURLs.clear();cache.clear();cacheBytes=0;
   photos={};outputs={};shareItems=[];shareSelected=null;sharePreparing=false;shareError='';resultCollage=null;collagePreparing=false;slideMeta.length=0;sheetFocus=null;
  }
  function hide(){clearSession();visible=false;container.classList.remove('editor-share');const studio=container.closest('#studio');if(studio)studio.classList.remove('result-theme');}
  function showResults(data){
   if(disposed)throw new Error('分享控制器已释放');
   const list=data&&data.outputs;if(!Array.isArray(list)||!list.length||list.length>9)throw new Error('成片需要 1–9 张照片');
   const originals=new Map((data.photos||[]).map(photo=>[String(photo.id),photo]));
   if(new Set(list.map(output=>String(output.id))).size!==list.length)throw new Error('照片编号重复');
   list.forEach(output=>{const photo=originals.get(String(output.id));if(!photo||!(photo.sourceBlob||photo.file)||!output.blob||!(output.width>0&&output.height>0&&photo.width>0&&photo.height>0))throw new Error('成片或原图数据不完整');});
   clearSession();visible=true;state.page='result';state.resultIndex=0;shareStyle='effect';resultReturnIndex=sharePageIndex=0;seed=Number(data.seed)>>>0;theme=data.theme==='white'?'white':'black';state.selected=[];
   list.forEach(output=>{const id=String(output.id);state.selected.push(id);photos[id]=originals.get(id);outputs[id]=Object.assign({},output,{previewURL:output.previewURL||ownURL(output.previewBlob||output.blob)});});
   container.classList.add('editor-share');const studio=container.closest('#studio');if(studio)studio.classList.add('result-theme');collagePreparing=state.selected.length>1;render();
   return collagePreparing?composeResultCollage(generation):Promise.resolve();
  }
  function onVisibility(){
   if(document.hidden&&activeIO&&activeIO.type==='share'&&!activeIO.submitted)cancelIO();
   if(!disposed&&visible&&state.page==='sharePage'&&sharePreparing){
    if(document.hidden){shareEpoch++;cancelResourceWaits();}
    else refreshSharePage();
   }
  }
  function onPageHide(){hide();}
  function release(){if(disposed)return;hide();disposed=true;container.removeEventListener('click',onClick);window.removeEventListener('pagehide',onPageHide);document.removeEventListener('visibilitychange',onVisibility);}
  container.addEventListener('click',onClick);window.addEventListener('pagehide',onPageHide);document.addEventListener('visibilitychange',onVisibility);
  return {showResults:showResults,release:release,hide:hide,saveAll:saveAll,diagnostics:function(){return {visible:visible,cacheBytes:cacheBytes,cacheLimit:CACHE_LIMIT,ownedURLs:ownedURLs.size,preparing:sharePreparing,ioBusy:ioBusy};}};
 }
 return {create:create};
})();

