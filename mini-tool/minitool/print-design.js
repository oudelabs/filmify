'use strict';
// Shared print geometry, typography and branding for preview, stills and video.
window.FilmifyPrintDesign=(function(){
 var C={black:'#1c1c1c',paper:'#f3f3f0',ink:'#484848',sub:'#707070',light:'#d6d6d6',lightSub:'#b8b8b8',overlay:'#f2f2f0',overlaySub:'#dcdcd8'};
 var FONT='"Filmify Caption",Georgia,serif',logo=null,logoURL='',readyTask=null,previews=new WeakMap();
 var root=(document.getElementById('studio')||{}).dataset;
 var source=(root&&root.assetRoot||'./')+'assets/logo-mark-t-dark.png';
 function ready(){
  if(readyTask)return readyTask;
  var fontTask=document.fonts&&document.fonts.load?document.fonts.load('600 30px "Filmify Caption"','PORTRA 400 · ENDURA ORIGINAL'):Promise.resolve();
  var imageTask=new Promise(function(resolve,reject){
   var image=new Image();image.onload=function(){
    var canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    try{
     var g=canvas.getContext('2d'),d;g.drawImage(image,0,0);d=g.getImageData(0,0,278,130);
     // Neutral light gray on Film; preserve alpha, original texture, orange ify and underline.
     for(var i=0;i<d.data.length;i+=4){var gray=Math.round((d.data[i]*.2126+d.data[i+1]*.7152+d.data[i+2]*.0722)*.885);d.data[i]=d.data[i+1]=d.data[i+2]=gray;}
     g.putImageData(d,0,0);logoURL=canvas.toDataURL('image/png');
     var prepared=new Image();prepared.onload=function(){logo=prepared;canvas.width=canvas.height=1;resolve();};prepared.onerror=function(){canvas.width=canvas.height=1;reject(new Error('品牌标志加载失败，请重试'));};prepared.src=logoURL;
    }catch(error){canvas.width=canvas.height=1;reject(error);}finally{image.onload=image.onerror=null;image.src='';}
   };image.onerror=function(){reject(new Error('品牌标志加载失败，请重试'));};image.src=source;
  });
  readyTask=Promise.all([fontTask,imageTask]).then(function(){},function(error){readyTask=null;throw error;});return readyTask;
 }
 function run(g,text,size,spacing){
  g.font='600 '+size+'px '+FONT;g.textAlign='left';g.textBaseline='alphabetic';
  var pen=0,min=Infinity,max=-Infinity,ascent=0,descent=0,glyphs=[];
  for(var i=0;i<text.length;i++){
   var ch=text[i],m=g.measureText(ch);glyphs.push({ch:ch,x:pen});
   if(ch.trim()){
    min=Math.min(min,pen-(isFinite(m.actualBoundingBoxLeft)?m.actualBoundingBoxLeft:0));
    max=Math.max(max,pen+(isFinite(m.actualBoundingBoxRight)?m.actualBoundingBoxRight:m.width));
    ascent=Math.max(ascent,isFinite(m.actualBoundingBoxAscent)?m.actualBoundingBoxAscent:size*.75);
    descent=Math.max(descent,isFinite(m.actualBoundingBoxDescent)?m.actualBoundingBoxDescent:0);
   }pen+=m.width+spacing;
  }
  if(!isFinite(min))min=max=0;
  return {glyphs:glyphs,min:min,max:max,ascent:ascent,descent:descent,size:size};
 }
 function draw(g,r,x,y,color,align){
  g.font='600 '+r.size+'px '+FONT;g.textAlign='left';g.textBaseline='alphabetic';
  var offset=align==='center'?x-(r.min+r.max)/2:align==='right'?x-r.max:x-r.min;
  for(var i=0;i<r.glyphs.length;i++){g.fillStyle=typeof color==='function'?color(i):color;g.fillText(r.glyphs[i].ch,offset+r.glyphs[i].x,y);}
 }
 function recipe(opts){return String(opts.film||'').toUpperCase()+(opts.paper?' · '+String(opts.paper).toUpperCase():'');}
 function colors(text,dark,overlay){
  var split=text.indexOf(' · ');if(split<0)split=text.length;
  return function(i){return i<split?(overlay?C.overlay:dark?C.light:C.ink):(overlay?C.overlaySub:dark?C.lightSub:C.sub);};
 }
 function fitRun(g,text,size,maxWidth){
  var r=run(g,text,size,2.6*size/30),w=r.max-r.min;
  if(w>maxWidth)r=run(g,text,size*maxWidth/w,2.6*size/30*maxWidth/w);
  return r;
 }
 function brand(g,right,center,size){
  if(!logo)return;
  var scale=(100*(size||26)/26)/374;
  g.drawImage(logo,right-421*scale,center-86*scale,logo.naturalWidth*scale,logo.naturalHeight*scale);
 }
 function matLayout(w,h,aligned){
  var width=1200,height,x,y,pw,ph;
  if(w>=h){pw=976;ph=pw*h/w;x=112;y=116;height=Math.round(y+ph+230);}
  else{height=Math.round(width*h/w);pw=960;ph=pw*h/w;x=120;y=(height-ph)/3;}
  var scale=1;
  if(aligned){
   // Bound video backing stores and stay within AVC Level 4.0 on tall inputs.
   var fit=Math.min(1,1600/Math.max(width,height));
   var targetW=Math.max(16,Math.floor(width*fit/16)*16);scale=targetW/width;
   width=targetW;height=Math.max(16,Math.round(height*scale/16)*16);
   x*=scale;y*=scale;pw*=scale;ph*=scale;
  }
  return {W:width,H:height,x:x,y:y,cw:pw,ch:ph,scale:scale};
 }
 function matBase(g,L,dark){g.fillStyle=C.black;g.fillRect(0,0,L.W,L.H);if(!dark){g.fillStyle=C.paper;var edge=15*L.scale;g.fillRect(edge,edge,L.W-edge*2,L.H-edge*2);}}
 // Static sharing has its own pixel budget, independent of video alignment.
 function shareLayout(w,h,opts){
  if(opts&&opts.plainFrame){
   var photoWidth=960,photoHeight=photoWidth*h/w;
   var fit=Math.min(2,3200/Math.max(1200,photoHeight+240),2048/Math.max(photoWidth,photoHeight));
   var border=Math.max(1,Math.round(120*fit)),cw=Math.max(1,Math.round(photoWidth*fit)),ch=Math.max(1,Math.round(photoHeight*fit));
   return {W:cw+2*border,H:ch+2*border,x:border,y:border,cw:cw,ch:ch,scale:fit,sourceEdge:Math.max(cw,ch)};
  }
  var L=matLayout(w,h,false),scale=Math.min(2,3200/Math.max(L.W,L.H),2048/Math.max(L.cw,L.ch));
  ['W','H','x','y','cw','ch','scale'].forEach(function(key){L[key]*=scale;});
  L.W=Math.max(1,Math.round(L.W));L.H=Math.max(1,Math.round(L.H));
  L.sourceEdge=Math.min(2048,Math.ceil(Math.max(L.cw,L.ch)));return L;
 }
 function matFooter(g,L,opts,live){
  var dark=opts.theme==='black',text=recipe(opts),size=(live?26:30)*L.scale,center=(L.y+L.ch+L.H-(dark?0:15*L.scale))/2;
  var r=fitRun(g,text,size,live?L.cw-160*L.scale:L.cw),baseline=center+(r.ascent-r.descent)/2;
  draw(g,r,live?L.x:L.W/2,baseline,colors(text,dark),live?'left':'center');
  if(live)brand(g,L.x+L.cw,center,26*L.scale);
 }
 function jpeg(c,message,quality,guard){return new Promise(function(resolve,reject){
  var done=false,timer=0,poll=0;
  function finish(error,blob){if(done)return;done=true;clearTimeout(timer);clearInterval(poll);if(error)reject(error);else resolve(blob);}
  function check(){if(done)return false;try{if(guard)guard();return true;}catch(error){finish(error);return false;}}
  if(!check())return;
  timer=setTimeout(function(){finish(new Error('图片编码超时，请重试'));},30000);
  if(guard)poll=setInterval(check,25);
  try{c.toBlob(function(blob){if(!check())return;finish(blob?null:new Error(message),blob);},'image/jpeg',quality);}catch(error){finish(error);}
 });}
 async function toBlob(c,message,quality,guard){
  var preview=null,small=null;
  try{
   // Derive list previews from this exact composition before releasing pixels.
   // Only the current fullscreen page decodes the HD delivery; no HD bitmap cache.
   var scale=Math.min(1,1600/Math.max(c.width,c.height));
   if(scale<1){
    preview=document.createElement('canvas');preview.width=Math.max(1,Math.round(c.width*scale));preview.height=Math.max(1,Math.round(c.height*scale));
    var g=preview.getContext('2d',{alpha:false});g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';g.drawImage(c,0,0,preview.width,preview.height);
    small=await jpeg(preview,message,.92,guard);preview.width=preview.height=1;
   }
   var blob=await jpeg(c,message,quality||.94,guard);if(small)previews.set(blob,small);return blob;
  }finally{c.width=c.height=1;if(preview)preview.width=preview.height=1;}
 }
 function previewBlob(blob){return previews.get(blob)||blob;}
 function compose(effect,opts,branded,size,guard){return (opts&&opts.plainFrame?Promise.resolve():ready()).then(function(){
  if(guard)guard();
  var L=shareLayout(size?size.width:(effect.naturalWidth||effect.width),size?size.height:(effect.naturalHeight||effect.height),opts),c=document.createElement('canvas');c.width=L.W;c.height=L.H;
  try{var g=c.getContext('2d',{alpha:false});g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';matBase(g,L,opts.theme==='black');g.drawImage(effect,L.x,L.y,L.cw,L.ch);if(!opts.plainFrame)matFooter(g,L,opts,!!branded);return toBlob(c,'装裱生成失败',undefined,guard);}
  catch(error){c.width=c.height=1;throw error;}
 });}
 function random(seed){var a=seed>>>0;return function(){a+=0x6D2B79F5;var t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
 function scatter(n,seed){
  var rand=random(seed),ids=[],i,j,k;for(i=0;i<n;i++)ids.push(i);
  for(i=n-1;i>0;i--){j=Math.floor(rand()*(i+1));k=ids[i];ids[i]=ids[j];ids[j]=k;}
  var slots=[],w=n>4?860:720,h=n>4?910:740;
  for(var attempt=0;attempt<32;attempt++){
   slots=[];for(i=0;i<n;i++){
    var found=false;for(j=0;j<240;j++){
     var box={index:ids[i],x:rand()*(w-200),y:rand()*(h-200),w:200,h:200};
     if(slots.every(function(s){return Math.abs(s.x-box.x)>=228||Math.abs(s.y-box.y)>=228;})){slots.push(box);found=true;break;}
    }if(!found)break;
   }if(slots.length===n)break;
  }
  if(slots.length!==n){var cols=n>6?3:2;slots=ids.map(function(id,index){return{index:id,x:index%cols*270+rand()*30,y:Math.floor(index/cols)*280+rand()*40,w:200,h:200};});}
  var minX=Infinity,minY=Infinity,maxX=0,maxY=0;
  slots.forEach(function(s){minX=Math.min(minX,s.x);minY=Math.min(minY,s.y);maxX=Math.max(maxX,s.x+200);maxY=Math.max(maxY,s.y+200);});
  slots.forEach(function(s){s.x=Math.round(s.x+600-(minX+maxX)/2);s.y=Math.round(s.y+780-(minY+maxY)/2);});
  return {W:1200,H:1600,cell:200,cells:slots};
 }
 return {colors:C,ready:ready,logoURL:function(){return logoURL||source;},run:run,draw:draw,fitRun:fitRun,recipe:recipe,recipeColors:colors,brand:brand,matLayout:matLayout,shareLayout:shareLayout,matBase:matBase,matFooter:matFooter,compose:compose,encodeJPEG:jpeg,toBlob:toBlob,previewBlob:previewBlob,scatter:scatter};
})();
