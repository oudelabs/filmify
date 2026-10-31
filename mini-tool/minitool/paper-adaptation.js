/* Original analytic print demonstrations. GPL-3.0-only.
 * These are not the product print LUTs or Fotufilm print responses.
 * Data is generated below from elementary functions, never sampled from a catalog.
 * Int8 deltas / 510 retain the existing CPU/GPU paper interface. */
(function(root){
 'use strict';
 const SIZE=9,SCALE=510;
 const scan={id:'scan',name:'直接扫描',kind:'保留演示色彩',carrier:'直接扫描',mono:false};
 const prints=[
  {id:'demo-paper-warm',name:'暖纸演示',kind:'原创数学演示',carrier:'暖纸演示',mono:false,sw:'linear-gradient(135deg,#f5ead1,#dccba9)'},
  {id:'demo-paper-cool',name:'冷纸演示',kind:'原创数学演示',carrier:'冷纸演示',mono:false,sw:'linear-gradient(135deg,#e5edf1,#b9ccd9)'},
  {id:'graded-print',name:'灰阶演示',kind:'原创数学演示',carrier:'灰阶演示',mono:true,sw:'linear-gradient(135deg,#ddd,#555)'}
 ];
 const tables=new Map(),mono=new Float64Array(1025),clamp=x=>Math.max(0,Math.min(1,x));
 for(const row of prints.filter(p=>!p.mono)){
  const table=new Int8Array(SIZE*SIZE*SIZE*3),direction=row.id==='demo-paper-warm'?1:-1;
  for(let b=0;b<SIZE;b++)for(let g=0;g<SIZE;g++)for(let r=0;r<SIZE;r++){
   const p=((b*SIZE+g)*SIZE+r)*3,rr=r/(SIZE-1),bb=b/(SIZE-1);
   table[p]=Math.round(direction*.04*rr*(1-rr)*SCALE);
   table[p+1]=0;table[p+2]=Math.round(-direction*.04*bb*(1-bb)*SCALE);
  }tables.set(row.id,table);
 }
 for(let i=0;i<mono.length;i++){const x=i/1024;mono[i]=x+.12*x*(1-x)*(2*x-1);}
 const decode=x=>x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4);
 const encode=x=>x<=.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-.055;
 function finishedRGB(r,g,b,id,out){
  out=out||[0,0,0];if(!id||id==='scan'){out[0]=r;out[1]=g;out[2]=b;return out;}
  if(![r,g,b].every(Number.isFinite))throw new Error('印相输入数值异常');r=clamp(r);g=clamp(g);b=clamp(b);
  if(id==='graded-print'){const y=clamp(encode(.2126*decode(r)+.7152*decode(g)+.0722*decode(b))),x=y*1024,i=Math.min(1023,Math.floor(x)),v=mono[i]+(x-i)*(mono[i+1]-mono[i]);out[0]=out[1]=out[2]=v;return out;}
  const table=tables.get(id);if(!table)throw new Error('未知演示印相');
  const x=r*(SIZE-1),y=g*(SIZE-1),z=b*(SIZE-1),ix=Math.min(SIZE-2,Math.floor(x)),iy=Math.min(SIZE-2,Math.floor(y)),iz=Math.min(SIZE-2,Math.floor(z)),fx=x-ix,fy=y-iy,fz=z-iz,p=((iz*SIZE+iy)*SIZE+ix)*3,dy=SIZE*3,dz=SIZE*SIZE*3;
  for(let c=0;c<3;c++){const a=table[p+c]+fx*(table[p+3+c]-table[p+c]),bb=table[p+dy+c]+fx*(table[p+dy+3+c]-table[p+dy+c]),d=table[p+dz+c]+fx*(table[p+dz+3+c]-table[p+dz+c]),e=table[p+dz+dy+c]+fx*(table[p+dz+dy+3+c]-table[p+dz+dy+c]);const delta=((a+fy*(bb-a))+fz*((d+fy*(e-d))-(a+fy*(bb-a))))/SCALE;out[c]=clamp([r,g,b][c]+delta);}
  return out;
 }
 const api={version:'analytic-demo-paper-1',definitions:[scan].concat(prints),prints:prints,get:id=>prints.find(p=>p.id===id)||scan,finishedRGB:finishedRGB,apply:finishedRGB,_testing:{size:SIZE,scale:SCALE,tables:tables,mono:mono}};
 root.FilmifyPaperAdaptation=root.FilmifyFinishedPaper=api;
 if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
