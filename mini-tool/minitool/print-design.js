'use strict';
// Shared print geometry, typography and branding for preview, stills and video.
window.FilmifyPrintDesign=(function(){
 var C={black:'#1c1c1c',paper:'#f3f3f0',ink:'#484848',sub:'#707070',light:'#d6d6d6',lightSub:'#b8b8b8',overlay:'#f2f2f0',overlaySub:'#dcdcd8'};
 var FONT='"Filmify Caption",Georgia,serif',logo=null,logoURL='',readyTask=null;
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
 function matFooter(g,L,opts,live){
  var dark=opts.theme==='black',text=recipe(opts),size=(live?26:30)*L.scale,center=(L.y+L.ch+L.H-(dark?0:15*L.scale))/2;
  var r=fitRun(g,text,size,live?L.cw-160*L.scale:L.cw),baseline=center+(r.ascent-r.descent)/2;
  draw(g,r,live?L.x:L.W/2,baseline,colors(text,dark),live?'left':'center');
  if(live)brand(g,L.x+L.cw,center,26*L.scale);
 }
 function toBlob(c,message,quality){return new Promise(function(resolve,reject){c.toBlob(function(blob){c.width=c.height=1;if(blob)resolve(blob);else reject(new Error(message));},'image/jpeg',quality||.94);});}
 function compose(effect,opts,live){return ready().then(function(){
  var L=matLayout(effect.naturalWidth||effect.width,effect.naturalHeight||effect.height,!!live),c=document.createElement('canvas');c.width=L.W;c.height=L.H;
  try{var g=c.getContext('2d',{alpha:false});matBase(g,L,opts.theme==='black');g.drawImage(effect,L.x,L.y,L.cw,L.ch);matFooter(g,L,opts,!!live);return toBlob(c,'装裱生成失败');}
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
 return {colors:C,ready:ready,logoURL:function(){return logoURL||source;},run:run,draw:draw,fitRun:fitRun,recipe:recipe,recipeColors:colors,brand:brand,matLayout:matLayout,matBase:matBase,matFooter:matFooter,compose:compose,toBlob:toBlob,scatter:scatter};
})();
