'use strict';
// Original versus recipe, with centered in-photo labels and neutral paper margins.
window.FilmifyCompare=(function(){
 function caption(g,r,opts,effect){
  var D=window.FilmifyPrintDesign,text=effect?D.recipe(opts):'ORIGINAL';
  var band=Math.min(96,r.h*.17),gradient=g.createLinearGradient(0,r.y+r.h-band,0,r.y+r.h);
  gradient.addColorStop(0,'rgba(0,0,0,0)');gradient.addColorStop(1,'rgba(0,0,0,.28)');
  g.fillStyle=gradient;g.fillRect(r.x,r.y+r.h-band,r.w,band);
  g.save();g.shadowColor='rgba(0,0,0,.6)';g.shadowBlur=5;g.shadowOffsetY=1;
  D.draw(g,D.fitRun(g,text,26,r.w-32),r.x+r.w/2,r.y+r.h-24,effect?D.recipeColors(text,false,true):D.colors.overlay,'center');g.restore();
 }
 function render(src,eff,opts){return window.FilmifyPrintDesign.ready().then(function(){
  var w=eff.naturalWidth||eff.width,h=eff.naturalHeight||eff.height,portrait=h>w;
  var pw=portrait?528:1080,ph=pw*h/w,H=portrait?ph+120:ph*2+148;
  var cells=portrait?[{x:60,y:60,w:pw,h:ph},{x:612,y:60,w:pw,h:ph}]:[{x:60,y:60,w:pw,h:ph},{x:60,y:ph+88,w:pw,h:ph}];
  var c=document.createElement('canvas');c.width=1200;c.height=Math.round(H);
  try{
   var g=c.getContext('2d',{alpha:false});g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';g.fillStyle=window.FilmifyPrintDesign.colors.paper;g.fillRect(0,0,c.width,c.height);
   cells.forEach(function(r,i){g.drawImage(i?eff:src,r.x,r.y,r.w,r.h);caption(g,r,opts,!!i);});
   return window.FilmifyPrintDesign.toBlob(c,'对比图生成失败，请重试',.94);
  }catch(error){c.width=c.height=1;throw error;}
 });}
 return {render:render};
})();
