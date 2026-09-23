'use strict';
/* 负片预览使用 32³ LUT，256² PNG 按蓝切片打包；彩色为棕色负片，黑白为亮度取反。仅影响预览与动画首帧，显影使用原图。优先 WebGL，探针不通过时回退 CPU；调用方可按 color/bw/both 懒算。 */
const FilmNegativePreview=(()=>{
 let pending=null,directMap=null,lutBytes=null;
 function load(root){
  if(pending)return pending;
  pending=new Promise((resolve,reject)=>{
   const image=new Image();
   image.onload=()=>{
    try{
     if(image.naturalWidth!==256||image.naturalHeight!==256)throw new Error('负片色彩表尺寸不正确');
     const c=document.createElement('canvas');c.width=c.height=256;
     const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
     lutBytes=ctx.getImageData(0,0,256,256).data;
     /* 32³ 直查表:idx=(b5<<10)|(g5<<5)|r5 → RGB,CPU 路径每像素一次寻址 */
     directMap=new Uint8Array(32768*3);
     for(let b=0;b<32;b++)for(let g=0;g<32;g++)for(let r=0;r<32;r++){
      const src=(((b>>3)*32+g)*256+((b&7)*32)+r)*4,dst=((b<<10)|(g<<5)|r)*3;
      directMap[dst]=lutBytes[src];directMap[dst+1]=lutBytes[src+1];directMap[dst+2]=lutBytes[src+2];
     }
     resolve(directMap);
    }catch(error){reject(error);}
   };
   image.onerror=()=>reject(new Error('负片预览加载失败'));
   image.src=root+'assets/negative-picker-lut32.png';
  }).catch(error=>{pending=null;throw error;});
  return pending;
 }
 /* ---------- GPU 路径 ---------- */
 let glState=null;/* null=未初始化;'broken'=永久禁用;{...}=可用 */
 const VS='attribute vec2 a_pos;varying vec2 v_uv;void main(){v_uv=a_pos*0.5+0.5;gl_Position=vec4(a_pos,0.0,1.0);}';
 const FS='precision mediump float;varying vec2 v_uv;uniform sampler2D u_img;uniform sampler2D u_lut;uniform float u_mode;\n'+
  'void main(){vec3 c=texture2D(u_img,v_uv).rgb;\n'+
  ' if(u_mode>0.5){float l=dot(c,vec3(0.2126,0.7152,0.0722));gl_FragColor=vec4(vec3(1.0-l),1.0);return;}\n'+
  ' vec3 q=c*31.0;float b0=floor(q.b);float fb=q.b-b0;float b1=min(b0+1.0,31.0);\n'+
  ' vec2 t0=vec2((mod(b0,8.0)*32.0+q.r+0.5)/256.0,(floor(b0/8.0)*32.0+q.g+0.5)/256.0);\n'+
  ' vec2 t1=vec2((mod(b1,8.0)*32.0+q.r+0.5)/256.0,(floor(b1/8.0)*32.0+q.g+0.5)/256.0);\n'+
  ' gl_FragColor=vec4(mix(texture2D(u_lut,t0),texture2D(u_lut,t1),fb).rgb,1.0);}';
 function gpuSetup(){
  if(glState)return glState==='broken'?null:glState;
  try{
   const canvas=document.createElement('canvas');
   const opts={premultipliedAlpha:false,preserveDrawingBuffer:false,antialias:false,depth:false,stencil:false,alpha:false};
   const gl=canvas.getContext('webgl',opts)||canvas.getContext('experimental-webgl',opts);
   if(!gl)throw new Error('no webgl');
   function sh(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error('shader: '+gl.getShaderInfoLog(s));return s;}
   const prog=gl.createProgram();
   gl.attachShader(prog,sh(gl.VERTEX_SHADER,VS));gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,FS));
   gl.linkProgram(prog);
   if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw new Error('link: '+gl.getProgramInfoLog(prog));
   gl.useProgram(prog);
   const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
   gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
   const locPos=gl.getAttribLocation(prog,'a_pos');
   gl.enableVertexAttribArray(locPos);gl.vertexAttribPointer(locPos,2,gl.FLOAT,false,0,0);
   const texImg=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texImg);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   const texLut=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texLut);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
   gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,256,0,gl.RGBA,gl.UNSIGNED_BYTE,lutBytes);
   gl.uniform1i(gl.getUniformLocation(prog,'u_img'),0);
   gl.uniform1i(gl.getUniformLocation(prog,'u_lut'),1);
   gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,texLut);gl.activeTexture(gl.TEXTURE0);
   glState={canvas:canvas,gl:gl,texImg:texImg,locMode:gl.getUniformLocation(prog,'u_mode'),checked:false};
  }catch(error){glState='broken';return null;}
  return glState;
 }
 /* 首次使用自检:2×2 已知色板过 GPU,与 CPU 直查表比对(容差 16,GPU 三线性 vs CPU
    最近邻的正常插值差);黑图/坏 GL 病灶机会产出全零或乱码,此时永久回退 CPU */
 function gpuSelfCheck(S){
  const probe=document.createElement('canvas');probe.width=2;probe.height=2;
  const pctx=probe.getContext('2d');const pi=pctx.createImageData(2,2);
  const colors=[[20,200,90],[240,40,120],[128,128,128],[10,10,240]];
  for(let i=0;i<4;i++){pi.data[i*4]=colors[i][0];pi.data[i*4+1]=colors[i][1];pi.data[i*4+2]=colors[i][2];pi.data[i*4+3]=255;}
  pctx.putImageData(pi,0,0);
  const out=gpuRender(S,probe,0);probe.width=probe.height=1;
  if(!out)return false;
  const d=out.getContext('2d').getImageData(0,0,2,2).data;out.width=out.height=1;
  let allSame=true,maxDiff=0;
  for(let i=0;i<4;i++){
   const o=(((colors[i][2]>>3)<<10)|((colors[i][1]>>3)<<5)|(colors[i][0]>>3))*3;
   for(let ch=0;ch<3;ch++){
    const diff=Math.abs(d[i*4+ch]-directMap[o+ch]);
    if(diff>maxDiff)maxDiff=diff;
    if(ch===0&&Math.abs(d[i*4]-d[0])>2)allSame=false;
   }
  }
  return maxDiff<=16&&!allSame;
 }
 function gpuRender(S,srcCanvas,mode){
  const gl=S.gl,w=srcCanvas.width,h=srcCanvas.height;
  if(S.canvas.width!==w||S.canvas.height!==h){S.canvas.width=w;S.canvas.height=h;gl.viewport(0,0,w,h);}
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,S.texImg);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,srcCanvas);
  gl.uniform1f(S.locMode,mode);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  /* 同一任务内 drawImage 取帧缓冲,无需 preserveDrawingBuffer */
  const out=document.createElement('canvas');out.width=w;out.height=h;
  out.getContext('2d').drawImage(S.canvas,0,0);
  return out;
 }
 /* ---------- CPU 回退:32³ 直查表,零插值 ---------- */
 async function cpuRender(srcCanvas,mode){
  const w=srcCanvas.width,h=srcCanvas.height;
  const ctx=srcCanvas.getContext('2d');
  const color=ctx.getImageData(0,0,w,h);
  const neg=mode==='color'?null:ctx.createImageData(w,h);
  const rgb=color.data,nb=neg?neg.data:null;
  for(let y=0;y<h;y++){
   for(let x=0;x<w;x++){
    const p=(y*w+x)*4;
    if(nb){
     const inv=255-(.2126*rgb[p]+.7152*rgb[p+1]+.0722*rgb[p+2]);
     nb[p]=nb[p+1]=nb[p+2]=inv;nb[p+3]=255;
    }
    const o=(((rgb[p+2]>>3)<<10)|((rgb[p+1]>>3)<<5)|(rgb[p]>>3))*3;
    rgb[p]=directMap[o];rgb[p+1]=directMap[o+1];rgb[p+2]=directMap[o+2];rgb[p+3]=255;
   }
   if(y%32===31)await filmifyYield();
  }
  return {color:color,neg:neg,ctx:ctx};
 }
 /* canvas 已画好缩略尺寸原图;返回 {color,bw} blob URL(按 mode 可为 null)。 */
 async function render(canvas,root,mode){
  mode=mode||'both';
  await load(root);
  const w=canvas.width,h=canvas.height;
  let colorUrl=null,bwUrl=null;
  const S=gpuSetup();
  if(S){
   try{
    if(!S.checked){if(!gpuSelfCheck(S))throw new Error('GPU 负片自检失败');S.checked=true;}
    if(mode!=='bw'){const out=gpuRender(S,canvas,0);colorUrl=URL.createObjectURL(await canvasBlob(out,'image/jpeg'));out.width=out.height=1;}
    if(mode!=='color'){const out=gpuRender(S,canvas,1);bwUrl=URL.createObjectURL(await canvasBlob(out,'image/jpeg'));out.width=out.height=1;}
    return {color:colorUrl,bw:bwUrl};
   }catch(error){glState='broken';/* 落 CPU,以下重算缺失部分 */}
  }
  const r=await cpuRender(canvas,mode);
  if(mode!=='bw'&&!colorUrl){r.ctx.putImageData(r.color,0,0);colorUrl=URL.createObjectURL(await canvasBlob(canvas,'image/jpeg'));}
  if(mode!=='color'&&!bwUrl){r.ctx.putImageData(r.neg,0,0);bwUrl=URL.createObjectURL(await canvasBlob(canvas,'image/jpeg'));}
  return {color:colorUrl,bw:bwUrl};
 }
 return {render};
})();
