'use strict';
// Original versus recipe, with centered in-photo labels and neutral paper margins.
window.FilmifyCompare=(function(){
 function caption(g,r,opts,effect,scale){
  var D=window.FilmifyPrintDesign,text=effect?(opts.effectLabel===undefined?D.recipe(opts):opts.effectLabel):'ORIGINAL';
  var band=Math.min(96,r.h*.17),gradient=g.createLinearGradient(0,r.y+r.h-band,0,r.y+r.h);
  gradient.addColorStop(0,'rgba(0,0,0,0)');gradient.addColorStop(1,'rgba(0,0,0,.28)');
  g.fillStyle=gradient;g.fillRect(r.x,r.y+r.h-band,r.w,band);
  g.save();g.shadowColor='rgba(0,0,0,.6)';g.shadowBlur=5*scale;g.shadowOffsetY=scale;
  D.draw(g,D.fitRun(g,text,26,r.w-32),r.x+r.w/2,r.y+r.h-24,effect?D.recipeColors(text,false,true):D.colors.overlay,'center');g.restore();
 }
 function layout(w,h){
  var portrait=h>w,pw=portrait?528:1080,ph=pw*h/w,H=portrait?ph+120:ph*2+148;
  // Keep portrait detail; raise landscape/square cells to 1620px wide without
  // doubling both decoded sources. Bound very tall exports as before.
  var scale=Math.min(portrait?2:1.5,4096/H);
  var cells=portrait?[{x:60,y:60,w:pw,h:ph},{x:612,y:60,w:pw,h:ph}]:[{x:60,y:60,w:pw,h:ph},{x:60,y:ph+88,w:pw,h:ph}];
  return {W:Math.max(1,Math.round(1200*scale)),H:Math.max(1,Math.round(H*scale)),scale:scale,cells:cells,sourceEdge:Math.ceil(Math.max(pw,ph)*scale)};
 }
 function render(src,eff,opts,size,guard){return window.FilmifyPrintDesign.ready().then(function(){
  if(guard)guard();
  var w=size?size.width:(eff.naturalWidth||eff.width),h=size?size.height:(eff.naturalHeight||eff.height),L=layout(w,h);
  var c=document.createElement('canvas');c.width=L.W;c.height=L.H;
  try{
   var g=c.getContext('2d',{alpha:false});g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';g.fillStyle=window.FilmifyPrintDesign.colors.paper;g.fillRect(0,0,c.width,c.height);
   g.scale(L.scale,L.scale);
   L.cells.forEach(function(r,i){g.drawImage(i?eff:src,r.x,r.y,r.w,r.h);caption(g,r,opts,!!i,L.scale);});
   return window.FilmifyPrintDesign.toBlob(c,'对比图生成失败，请重试',.94,guard);
  }catch(error){c.width=c.height=1;throw error;}
 });}
 return {render:render,layout:layout};
})();
