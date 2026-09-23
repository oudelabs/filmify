'use strict';
// Native AE/scanner adaptations: spektrafilm by Andrea Volpato, GPL-3.0.
// Reference 6cd00c8; see styles/SPEKTRAFILM_CODE_LICENSE.txt.
// Native styles meter virtual-film raw using the pinned upstream formula.
const FilmifyExposure=(()=>{
 // Pinned spektrafilm raw-channel mean, centre weighting and target raw=1.
 // Meter LUT interpolation is the only colour approximation in this reduction.
 function nativeMeasure(pixels,width,height,style){
  if(!style.meterValues)throw new Error('胶卷测光资源尚未准备好');
  const n=style.meterSize,v=style.meterValues,scale=style.meterScale;
  const long=Math.max(width,height);let total=0,weight=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const i=(y*width+x)*4,r=pixels[i]/255*(n-1),g=pixels[i+1]/255*(n-1),b=pixels[i+2]/255*(n-1);
   const r0=Math.min(n-2,Math.floor(r)),g0=Math.min(n-2,Math.floor(g)),b0=Math.min(n-2,Math.floor(b));
   const rf=r-r0,gf=g-g0,bf=b-b0;let value=0;
   for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)
    value+=v[((b0+dz)*n*n+(g0+dy)*n+r0+dx)*3]*(dx?rf:1-rf)*(dy?gf:1-gf)*(dz?bf:1-bf);
   const xx=(x/width-.5)*width/long,yy=(y/height-.5)*height/long;
   const w=Math.exp(-(xx*xx+yy*yy)/(2*.2*.2));
   total+=value*scale*w;weight+=w;
  }
  const mean=total/weight,ev=mean>0?-Math.log2(mean):0;
  return {ev:Number.isFinite(ev)?ev:0,reason:'spektrafilm-center-weighted',rawMean:mean,samples:width*height,wb:{r:1,g:1,b:1}};
 }
 // Match upstream skimage rescale(order=0) on floating-point sRGB: Gaussian
 // antialias, sigma=(input/output-1)/2, truncate=4, whole-sample reflection,
 // then nearest pixel-centre sampling. Compute only the columns used by the
 // 256px meter and read source rows in strips, not a full-resolution CPU copy.
 function nativePreview(image){
  /* 同时接受 <img>(naturalWidth)与 canvas 源:canvas 没有 naturalWidth,直接读会得到
     undefined→NaN→测光环路全程空转,ev 静默为 0,自动曝光形同虚设(2026-09-22 实锤:
     批渲染 harness 与任何不落 <img> 的调用方全部中招;app 主路径因 cameraExposure
     预先对 <img> 测光并显式传 options.exposure 而未触发)。 */
  const w=image.naturalWidth||image.width,h=image.naturalHeight||image.height,scale=Math.min(1,256/Math.max(w,h));
  function roundEven(v){const low=Math.floor(v);return v-low===.5?low+low%2:Math.round(v);}
  const width=Math.max(1,roundEven(w*scale)),height=Math.max(1,roundEven(h*scale));
  const c=document.createElement('canvas');c.width=w;c.height=Math.min(64,h);
  try{
   const ctx=c.getContext('2d',{colorSpace:'srgb'});if(!ctx)throw new Error('设备无法创建测光画布');
   function taps(input,output){
    const sigma=Math.max(0,(input/output-1)/2),radius=Math.floor(4*sigma+.5),weights=[];let total=0;
    for(let i=-radius;i<=radius;i++){const v=sigma?Math.exp(-.5*i*i/(sigma*sigma)):1;weights.push(v);total+=v;}
    return Array.from({length:output},(_,i)=>{
     const center=Math.floor((i+.5)*input/output),indices=[],values=[];
     for(let k=-radius;k<=radius;k++){
      let pos=center+k;const period=2*(input-1);
      if(period){pos=((pos%period)+period)%period;if(pos>=input)pos=period-pos;}else pos=0;
      indices.push(pos);values.push(weights[k+radius]/total);
     }
     return {indices:indices,weights:values};
    });
   }
   const xs=taps(w,width),ys=taps(h,height),horizontal=new Float32Array(h*width*3);
   for(let first=0;first<h;first+=64){
    const rows=Math.min(64,h-first);ctx.clearRect(0,0,w,c.height);ctx.drawImage(image,0,first,w,rows,0,0,w,rows);
    const data=ctx.getImageData(0,0,w,rows).data;
    for(let y=0;y<rows;y++)for(let x=0;x<width;x++){
     const t=xs[x],dest=((first+y)*width+x)*3;let r=0,g=0,b=0;
     for(let k=0;k<t.indices.length;k++){const pos=(y*w+t.indices[k])*4,v=t.weights[k];r+=data[pos]*v;g+=data[pos+1]*v;b+=data[pos+2]*v;}
     horizontal[dest]=r;horizontal[dest+1]=g;horizontal[dest+2]=b;
    }
   }
   const pixels=new Float32Array(width*height*4);
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const t=ys[y],dest=(y*width+x)*4;let r=0,g=0,b=0;
    for(let k=0;k<t.indices.length;k++){const pos=(t.indices[k]*width+x)*3,v=t.weights[k];r+=horizontal[pos]*v;g+=horizontal[pos+1]*v;b+=horizontal[pos+2]*v;}
    pixels[dest]=r;pixels[dest+1]=g;pixels[dest+2]=b;pixels[dest+3]=255;
   }
   return {pixels:pixels,width:width,height:height};
  }finally{c.width=c.height=1;}
 }
 function analyze(image,style){
  const preview=nativePreview(image),result=nativeMeasure(preview.pixels,preview.width,preview.height,style);
  return result;
 }

 return {analyze:analyze,nativeMeasure:nativeMeasure};
})();
