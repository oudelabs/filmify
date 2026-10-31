'use strict';
/* Static print-room pages. Logical 900 × 1200, export 2400 × 3200.
   One seeded scene per batch; rope coordinates continue between pages.
   Paper finishes are display treatments, not measured stock properties. */
window.FilmifyClothesline=(function(){
 var W=900,H=1200,atlas=null,readyTask=null,tile=null;
 var themes=[
  {id:'light',wall:'#e7e5df',shade:'#cac8be',light:'#fffef8',texture:.55,rope:['#9b9380','#dbd4bd','#fff9de'],width:4.7,clip:0},
  {id:'dark',wall:'#393c38',shade:'#1f2421',light:'#a7ac9f',texture:.6,rope:['#8c7959','#c2a67c','#e1c398'],width:5.5,clip:1},
  {id:'lime',wall:'#dedbd0',shade:'#c0bcac',light:'#faf6e8',texture:.8,rope:['#9c8c70','#bfb293','#e8ddc2'],width:3.5,clip:2},
  {id:'concrete',wall:'#b7bcba',shade:'#8e9694',light:'#ecf0ee',texture:.7,rope:['#555e5d','#9da7a5','#e7efed'],width:2,clip:3}
 ];
 var boxes=[[87,85,174,807],[443,85,176,807],[710,182,387,690],[1138,184,373,690]];
 // Only known photographic paper IDs use a paper-specific backing. Cine print
 // film and direct scans use neutral display paper, never counterfeit film stock.
 var papers={
  'endura-premier':['#fffef9','#f8f7f2','#eeede6'],
  'ektacolor-edge':['#fffdf5','#f7f4ea','#ede9de'],
  'crystal-archive':['#fefefb','#f5f6f1','#e9ece5']
 };
 function ready(){
  if(readyTask)return readyTask;
  var task=new Promise(function(resolve,reject){
   var root=(document.getElementById('studio')||{}).dataset,image=new Image(),done=false;
   var timer=setTimeout(function(){finish(new Error('晾片素材加载超时，请重试'));},30000);
   function finish(error){
    if(done)return;done=true;clearTimeout(timer);image.onload=image.onerror=null;
    if(error){image.src='';reject(error);}else{atlas=image;resolve();}
   }
   image.onload=function(){finish();};
   image.onerror=function(){finish(new Error('晾片素材加载失败，请重试'));};
   try{image.src=(root&&root.assetRoot||'./')+'assets/clothesline-clips.png';}catch(error){finish(error);}
  });
  readyTask=task;task.then(null,function(){if(readyTask===task)readyTask=null;});return task;
 }
 function random(seed){var a=seed>>>0;return function(){a+=0x6D2B79F5;var t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
 function scene(seed,count,paperId){
  var r=random(seed^0x729a31),theme=Math.floor(r()*themes.length),angles=[];
  for(var i=0;i<count;i++)angles.push((r()-.5)*5);
  return {theme:theme,count:count,angles:angles,paperId:paperId||null};
 }
 function ropeY(x,s){var t=x/(W*s.count);return (s.theme>=2?183:238)+240*t*(1-t);}
 function geometry(w,h,index,s){
  var wide=w>h,iw=Math.min((wide?636:528)-34,696*w/h),ih=iw*h/w,pw=iw+34,ph=ih+34;
  var cx=index*W+450,span=pw*.33,metal=s.theme>=2;
  var angle=wide?Math.atan2(ropeY(cx+span,s)-ropeY(cx-span,s),2*span):s.angles[index]*Math.PI/180;
  // Use the chord of the two rope contacts, not the curve midpoint. Both
  // jaws must overlap the same straight paper edge, including short batches.
  var dx=span*Math.cos(angle),cy=wide?(ropeY(cx-dx,s)+ropeY(cx+dx,s))/2:ropeY(cx,s);
  return {cx:cx,cy:cy,iw:iw,ih:ih,pw:pw,ph:ph,span:span,angle:angle,top:metal?52:-3,wide:wide};
 }
 function grain(){
  if(tile)return tile;tile=document.createElement('canvas');tile.width=tile.height=256;
  var g=tile.getContext('2d'),d=g.createImageData(256,256),r=random(41);
  for(var i=0;i<d.data.length;i+=4){var v=Math.floor(r()*256);d.data[i]=d.data[i+1]=d.data[i+2]=v;d.data[i+3]=12;}
  g.putImageData(d,0,0);return tile;
 }
 function path(g,x0,x1,s,offset){
  g.beginPath();for(var x=x0;x<=x1;x+=3){var y=ropeY(x,s)+(offset||0);if(x===x0)g.moveTo(x,y);else g.lineTo(x,y);}g.lineTo(x1,ropeY(x1,s)+(offset||0));
 }
 function wall(g,index,s,c){
  g.fillStyle=c.wall;g.fillRect(0,0,W,H);
  // Global gradient and grain origin remain continuous at every page boundary.
  g.save();g.translate(-index*W,0);
  var grad=g.createLinearGradient(0,0,W*s.count*.6,H);grad.addColorStop(0,c.light);grad.addColorStop(.55,c.wall);grad.addColorStop(1,c.shade);
  g.globalAlpha=.32;g.fillStyle=grad;g.fillRect(index*W,0,W,H);
  g.globalAlpha=c.texture;g.fillStyle=g.createPattern(grain(),'repeat');g.fillRect(index*W,0,W,H);g.restore();
 }
 function cord(g,index,s,c,scale){
  var x0=index*W-30,x1=(index+1)*W+30,r=c.width/2;
  g.save();g.translate(-index*W,0);g.lineCap='round';
  g.save();g.shadowBlur=4*scale;g.shadowOffsetX=3*scale;g.shadowOffsetY=10*scale;g.shadowColor='rgba(39,37,29,.25)';path(g,x0,x1,s);g.strokeStyle=c.rope[0];g.lineWidth=c.width;g.stroke();g.restore();
  path(g,x0,x1,s);g.strokeStyle=c.rope[1];g.lineWidth=c.width*.74;g.stroke();
  path(g,x0,x1,s,-.8);g.strokeStyle=c.rope[2];g.lineWidth=c.width*.2;g.stroke();
  var step=s.theme===3?6:3.8;
  for(var x=Math.floor(x0/step)*step;x<x1;x+=step){
   var y=ropeY(x,s),slope=240*(1-2*x/(W*s.count))/(W*s.count),dx=r*.72,dy=r*.88;
   g.globalAlpha=.56;g.strokeStyle=c.rope[0];g.lineWidth=s.theme===3?.35:.65;
   g.beginPath();g.moveTo(x-dx,y-dy-dx*slope);g.quadraticCurveTo(x,y-.6,x+dx,y+dy+dx*slope);g.stroke();
   g.globalAlpha=.68;g.strokeStyle=c.rope[2];g.lineWidth=.42;
   g.beginPath();g.moveTo(x-dx+.9,y-dy+.15-dx*slope);g.quadraticCurveTo(x+.6,y-.45,x+dx+.6,y+dy-.5+dx*slope);g.stroke();
  }g.restore();
 }
 function sheet(g,img,L,s,scale){
  var p=papers[s.paperId]||['#fdfdfa','#f5f5f1','#ebebe5'],x=-L.pw/2,y=L.top;
  g.save();g.translate(450,L.cy);g.rotate(L.angle);
  // Complete square corners, thin physical edge; no cutouts or fake folds.
  g.save();g.shadowBlur=15*scale;g.shadowOffsetX=8*scale;g.shadowOffsetY=14*scale;g.shadowColor='rgba(42,38,30,.22)';g.fillStyle=p[1];g.fillRect(x,y,L.pw,L.ph);g.restore();
  g.save();g.shadowBlur=2.5*scale;g.shadowOffsetX=1.8*scale;g.shadowOffsetY=2.3*scale;g.shadowColor='rgba(42,38,30,.2)';g.fillStyle=p[2];g.fillRect(x+.25,y+.85,L.pw,L.ph);g.restore();
  var grad=g.createLinearGradient(x,y,x+L.pw,y+L.ph);grad.addColorStop(0,p[0]);grad.addColorStop(.65,p[1]);grad.addColorStop(1,p[2]);
  g.fillStyle=grad;g.fillRect(x,y,L.pw,L.ph);
  g.save();g.globalAlpha=.36;g.fillStyle=g.createPattern(grain(),'repeat');g.fillRect(x,y,L.pw,L.ph);g.restore();
  // Photo pixels retain the rendered recipe. Surface texture belongs to the margin.
  g.drawImage(img,x+17,y+17,L.iw,L.ih);
  g.strokeStyle='rgba(135,131,119,.35)';g.lineWidth=.65;g.beginPath();g.moveTo(x,y+L.ph);g.lineTo(x+L.pw,y+L.ph);g.stroke();g.restore();
 }
 function peg(g,x,y,angle,c,scale){
  var metal=c.clip>=2,b=boxes[c.clip],height=metal?58:79,width=height*b[2]/b[3],top=metal?10:-66;
  g.save();g.translate(x,y);g.rotate(angle);g.shadowBlur=1.5*scale;g.shadowOffsetX=2.4*scale;g.shadowOffsetY=2.8*scale;g.shadowColor='rgba(41,37,29,.36)';
  if(metal){
   for(var i=0;i<2;i++){g.beginPath();g.moveTo(-2,-4);g.bezierCurveTo(-8,-5,-8,3,-3,5);g.bezierCurveTo(3,7,4,12,1,16);g.bezierCurveTo(-4,22,-1,25,3,22);g.strokeStyle=i?'#dce0d7':'#525953';g.lineWidth=i?.8:2.3;g.stroke();}
  }
  g.drawImage(atlas,b[0],b[1],b[2],b[3],-width/2,top,width,height);g.restore();
 }
 function draw(g,img,index,s,scale){
  scale=scale||1;
  var c=themes[s.theme],L=geometry(img.naturalWidth||img.width,img.naturalHeight||img.height,index,s);
  g.save();g.scale(4/3*scale,4/3*scale);g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';wall(g,index,s,c);cord(g,index,s,c,scale);sheet(g,img,L,s,scale);
  if(L.wide){[-1,1].forEach(function(sign){var x=L.cx+sign*L.span*Math.cos(L.angle);peg(g,x-index*W,ropeY(x,s),L.angle,c,scale);});}
  else peg(g,450,L.cy,L.angle,c,scale);
  g.restore();
 }
 function compose(img,index,s,guard){return ready().then(function(){
  if(guard)guard();
  // Keep the existing 7.68 MP drawing surface as the delivery image. Scaling
  // it down discarded most photo detail; no larger scratch surface is needed.
  var canvas=document.createElement('canvas');canvas.width=2400;canvas.height=3200;
  try{
   draw(canvas.getContext('2d',{alpha:false}),img,index,s,2);
   return window.FilmifyPrintDesign.toBlob(canvas,'晾片生成失败',.95,guard);
  }
  catch(error){canvas.width=canvas.height=1;throw error;}
 });}
 return {ready:ready,scene:scene,geometry:geometry,ropeY:ropeY,compose:compose,draw:draw};
})();
