/* Display-only analytic negative demonstration. GPL-3.0-only.
 * No negative-preview LUT is loaded; original photographs remain untouched. */
'use strict';
const FilmNegativePreview=(()=>{
 let generation=0;
 const stopped=(epoch,options)=>epoch!==generation||!!(options&&options.cancelled&&options.cancelled());
 function encode(canvas,epoch,options){return new Promise((resolve,reject)=>{
  let settled=false;const finish=(error,blob)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);error?reject(error):resolve(blob);};
  const timer=setTimeout(()=>finish(new Error('负片预览编码超时，请重试')),options&&options.timeout||20000),poll=setInterval(()=>{if(stopped(epoch,options))finish(new Error('cancelled'));},25);
  if(stopped(epoch,options)){finish(new Error('cancelled'));return;}
  try{canvas.toBlob(blob=>{if(stopped(epoch,options)){finish(new Error('cancelled'));return;}finish(blob?null:new Error('负片预览编码失败，请重试'),blob);},'image/jpeg',.9);}catch(error){finish(error);}
 });}
 function revoke(urls){if(!urls)return;for(const key of ['color','bw'])if(urls[key]){URL.revokeObjectURL(urls[key]);urls[key]=null;}}
 async function render(canvas,root,mode,options){
  mode=mode||'both';if(!['both','color','bw'].includes(mode))throw new Error('未知负片演示模式');
  const epoch=generation,urls={color:null,bw:null};let out=null;
  try{
   if(stopped(epoch,options))throw new Error('cancelled');
   const w=canvas.width,h=canvas.height,src=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data;
   out=document.createElement('canvas');out.width=w;out.height=h;const ctx=out.getContext('2d'),pixels=ctx.createImageData(w,h);
   for(const key of mode==='both'?['color','bw']:[mode]){
    for(let y=0;y<h;y++){
     if(stopped(epoch,options))throw new Error('cancelled');
     for(let x=0;x<w;x++){const p=(y*w+x)*4;if(key==='bw'){const value=255-(.2126*src[p]+.7152*src[p+1]+.0722*src[p+2]);pixels.data[p]=pixels.data[p+1]=pixels.data[p+2]=value;}else{pixels.data[p]=255-.82*src[p];pixels.data[p+1]=225-.76*src[p+1];pixels.data[p+2]=190-.66*src[p+2];}pixels.data[p+3]=255;}
     if(y%32===31)await filmifyYield();
    }
    if(stopped(epoch,options))throw new Error('cancelled');ctx.putImageData(pixels,0,0);const blob=await encode(out,epoch,options);if(stopped(epoch,options))throw new Error('cancelled');urls[key]=URL.createObjectURL(blob);
   }return urls;
  }catch(error){revoke(urls);throw error;}finally{if(out)out.width=out.height=1;}
 }
 return {render:render,revoke:revoke,release:()=>{generation++;}};
})();
