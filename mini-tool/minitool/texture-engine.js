/* Filmify finished-photo editor. GPL-3.0-only.
 * Selected style PNG: 64^3 cube, 8x8 blue slices, red x / green y.
 * Encoded sRGB -> trilinear LUT -> palette -> linear Rec.2020 optics/grain.
 * Effects stay Float32/linear until a single source-pixel SDR gamut fit and
 * sRGB encoding. Stable preview is area lowpass of that final source RGB8,
 * matching the delivered mother image instead of averaging clipped-away
 * highlight energy into shadows. No intermediate JPEG roundtrip.
 * Original-sized float planes are never retained; width/height describe the
 * complete oriented image independently of the current tile/preview.
 */
'use strict';
const FilmifyTextureEngine=(()=>{
 const VERSION='finished-photo-texture-direct-1',SIZE=64,LUT_URL='./assets/demo/identity.png',LUT_ENTRIES=2,LUT_BYTES=6*1024*1024;
 const TO2020=[.6274039149284363,.3292830288410187,.04331306740641594,.06909728795289993,.9195404052734375,.011362316086888313,.016391439363360405,.08801330626010895,.8955952525138855];
 const FROM2020=[1.6604909896850586,-.587641179561615,-.07284986227750778,-.1245504766702652,1.1328998804092407,-.008349422365427017,-.01815076172351837,-.10057889670133591,1.118729591369629];
 // The colour LUT and print adaptation stay in their established domain.
 // Spatial effects use Fotufilm Standard / particle diffusion / Legacy return
 // geometry, with the finished-photo exposure compensation documented below.
 const GRAIN=[0,35,65,100];
 const TILE=384,FIELD_EDGE=512,PREVIEW_EDGE=1152,PREVIEW_PIXELS=1048576,COLOR_EDGE=640,FINAL_PREVIEW_ENTRIES=4,FINAL_PREVIEW_BYTES=12*1024*1024;
 // Keep the padded near-field GPU FFT at 512 where a core of at least
 // 128 pixels remains. The base-field scan and every CPU scan retain 384.
 function renderTileEdge(near,backend,opts,pixelOps){
  if(!pixelOps||!near||!backend||backend.path!=='webgl2'||opts.forceCPU||opts.disableAdaptiveTile)return TILE;
  for(const fftEdge of [512,1024]){const edge=fftEdge-4*near.radius;if(edge>=128)return Math.min(TILE,edge);}return TILE;
 }
 // Only the smooth scattered component is sampled on a shared field. The
 // unscattered colour, Standard grain and output stay at source resolution.
 // Small Gaussians use exact separable source tiles; broad ones target at
 // least 16 samples per sigma, bounded to a 1536-pixel field edge.
 function nearPlan(s,opts,geometry,backend,sw,sh){
  if(!s.soft||opts.exactNear||!backend||!backend.gaussianRGB||!FilmifyTextureOptics.gaussianAxis)return null;
  const profile=FilmifyTextureOptics.profile(s.softFamily,s.softNeutral,geometry.focalLengthMm),sigma=profile.sigmasMM[0]*Math.min(sw,sh)/geometry.frameHeightMm;
  const field=sigma>=24,d=field?fit(sw,sh,Math.min(1536,Math.ceil(16*Math.max(sw,sh)/sigma)),1536*1536):{width:sw,height:sh};
  const x=FilmifyTextureOptics.gaussianAxis(sigma*d.width/sw),y=FilmifyTextureOptics.gaussianAxis(sigma*d.height/sh);
  return {field,width:d.width,height:d.height,sigma,axes:{x,y,halfMirror:field},radius:Math.max(x.radius,y.radius),nearEnergyRGB:profile.nearEnergyRGB,key:[s.softFamily||'black_pro_mist',geometry.id,d.width,d.height,!!s.softNeutral].join(':')};
 }
 // Only completed tables enter this global LRU. Sessions never retain a
 // table after their current render, so inactive photos cannot pin seven LUTs.
 const luts=new Map(),lutPending=new Map();
 const yieldNow=()=>new Promise(resolve=>setTimeout(resolve,0));
 const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
 const decode=x=>x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4);
 const encode=x=>x<=.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-.055;
 function check(cancelled){if(cancelled&&cancelled())throw new Error('已取消');}
 function styleResource(value){
  const requested=typeof value==='string'?value:value&&value.style,catalog=typeof FilmifyStyles!=='undefined'?FilmifyStyles:null;
  const fallback={id:'demo-identity',name:'恒等演示',lut:LUT_URL},selected=catalog&&typeof catalog.get==='function'?catalog.get(requested||catalog.defaultId):null;
  return selected&&typeof selected.id==='string'&&typeof selected.lut==='string'?selected:fallback;
 }
 function paperModule(){return typeof FilmifyPaperAdaptation!=='undefined'?FilmifyPaperAdaptation:typeof FilmifyFinishedPaper!=='undefined'?FilmifyFinishedPaper:null;}
 function paperId(value){
  const id=value&&value.paper||'scan',paper=paperModule(),catalog=paper&&(paper.definitions||paper.prints);
  return !catalog||catalog.some(item=>item.id===id)?id:'scan';
 }
 function applyPaper(r,g,b,s,out){
  if(!s.paper||s.paper==='scan'){out[0]=r;out[1]=g;out[2]=b;return out;}
  const paper=paperModule();if(!paper)throw new Error('印相模块未准备');
  return (paper.finishedRGB||paper.apply)(r,g,b,s.paper,out);
 }
 function resourceKey(value){const resource=styleResource(value);return resource.id+':'+resource.lut+':paper='+paperId(value);}
 function settings(value){value=value||{};const number=(x,d,a,b)=>Number.isFinite(Number(x))?clamp(Number(x),a,b):d;
  const result={style:styleResource(value).id,tone:number(value.tone,0,-100,100),color:number(value.color,0,-100,100),grain:Math.round(number(value.grain,0,0,3)),soft:Math.round(number(value.soft===undefined?value.softness:value.soft,0,0,3)),halation:Math.round(number(value.halation,0,0,3)),grainFormatMm:number(value.grainFormatMm,35,1,200)};
  // Optional recipe inputs leave the established no-recipe contract intact.
  if(value.softFamily!==undefined)result.softFamily=['black_pro_mist','glimmerglass','pro_mist','cinebloom'].includes(value.softFamily)?value.softFamily:'black_pro_mist';
  if(value.softStrength!==undefined)result.softStrength=number(value.softStrength,0,0,2);
  if(value.opticsFormatMm!==undefined)result.opticsFormatMm=number(value.opticsFormatMm,35,1,200);
  if(value.opticsFormatId!==undefined&&['35mm','120','4x5','super8','16mm','super35','instaxmini','instaxsquare','instaxwide'].includes(value.opticsFormatId))result.opticsFormatId=value.opticsFormatId;
  if(value.grainFrameHeightMm!==undefined)result.grainFrameHeightMm=number(value.grainFrameHeightMm,24,1,200);
  if(value.grainSize!==undefined)result.grainSize=number(value.grainSize,1,.5,4);
  if(value.grainAmountScale!==undefined)result.grainAmountScale=number(value.grainAmountScale,1,0,1);
  if(value.softNeutral!==undefined)result.softNeutral=!!value.softNeutral;
  if(value.paper!==undefined)result.paper=paperId(value);
  if(value.halationNeutral!==undefined)result.halationNeutral=!!value.halationNeutral;
  return result;
 }
 function grainParams(s){return {amount:GRAIN[s.grain]*(s.grainAmountScale===undefined?1:s.grainAmountScale),size:s.grainSize===undefined?1:s.grainSize,chroma:styleResource(s).blackAndWhite?0:100,softness:1};}
 function fit(w,h,edge,pixels){const scale=Math.min(1,edge/Math.max(w,h),Math.sqrt(pixels/(w*h)));return {width:Math.max(1,Math.floor(w*scale)),height:Math.max(1,Math.floor(h*scale))};}
 function lutFromPixels(bytes,width,height){
  if(width!==512||height!==512||bytes.length!==512*512*4)throw new Error('风格 LUT尺寸不符');
  const out=new Float32Array(SIZE*SIZE*SIZE*3);
  for(let z=0;z<SIZE;z++)for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){
   const i=(((z>>3)*SIZE+y)*512+(z%8)*SIZE+x)*4,p=((z*SIZE+y)*SIZE+x)*3;
   out[p]=bytes[i]/255;out[p+1]=bytes[i+1]/255;out[p+2]=bytes[i+2]/255;
  }return out;
 }
 function lutCacheBytes(){let bytes=0;for(const table of luts.values())bytes+=table.byteLength;return bytes;}
 function lutStats(){return {entries:luts.size,bytes:lutCacheBytes(),keys:Array.from(luts.keys()),pending:Array.from(lutPending.keys())};}
 function prepareLUT(value){
  const resource=styleResource(value),key=resource.id+':'+resource.lut;
  if(luts.has(key)){const table=luts.get(key);luts.delete(key);luts.set(key,table);return Promise.resolve(table);}if(lutPending.has(key))return lutPending.get(key);
  const operation=(async()=>{const image=new Image();let canvas=null,timer=null;
   try{await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error(resource.name+' LUT读取超时')),20000);image.onload=resolve;image.onerror=()=>reject(new Error(resource.name+' LUT读取失败'));image.src=resource.lut;});
    canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d',{colorSpace:'srgb',willReadFrequently:true});ctx.drawImage(image,0,0);const table=lutFromPixels(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);
    // Commit only this still-current resource load. Failed/retired operations
    // never overwrite a newer retry or evict a successfully completed table.
    if(lutPending.get(key)===operation){luts.set(key,table);while(luts.size>LUT_ENTRIES||lutCacheBytes()>LUT_BYTES)luts.delete(luts.keys().next().value);}return table;
   }finally{if(timer!==null)clearTimeout(timer);image.onload=image.onerror=null;image.src='';if(canvas)canvas.width=canvas.height=1;}
  })();lutPending.set(key,operation);const settled=()=>{if(lutPending.get(key)===operation)lutPending.delete(key);};operation.then(settled,settled);return operation;
 }
 function sampleLUT(table,r,g,b,out){
  const x=clamp(r,0,1)*63,y=clamp(g,0,1)*63,z=clamp(b,0,1)*63,ix=Math.min(62,Math.floor(x)),iy=Math.min(62,Math.floor(y)),iz=Math.min(62,Math.floor(z)),fx=x-ix,fy=y-iy,fz=z-iz;
  const p=((iz*64+iy)*64+ix)*3,dx=3,dy=192,dz=12288;
  for(let c=0;c<3;c++){
   const a=table[p+c]+fx*(table[p+dx+c]-table[p+c]),bb=table[p+dy+c]+fx*(table[p+dy+dx+c]-table[p+dy+c]);
   const d=table[p+dz+c]+fx*(table[p+dz+dx+c]-table[p+dz+c]),e=table[p+dz+dy+c]+fx*(table[p+dz+dy+dx+c]-table[p+dz+dy+c]);
   out[c]=(a+fy*(bb-a))+fz*((d+fy*(e-d))-(a+fy*(bb-a)));
  }return out;
 }
 function grade(r,g,b,s,out){
  // Relative virtual print rendering is applied once to the stock's
  // completed encoded-sRGB output, before the linear effect workspace.
  if(s.paper&&s.paper!=='scan'){applyPaper(r,g,b,s,out);r=out[0];g=out[1];b=out[2];}
  // Palette vertical axis is a restrained light/dark adjustment. Horizontal
  // axis changes warm/cool balance with luminance compensation, not a tint.
  const adjustment=s._adjustment||[Math.pow(2,s.tone/100*.70),Math.exp(.11*s.color/100),Math.exp(.015*s.color/100),Math.exp(-.14*s.color/100)],gain=adjustment[0];
  let a=decode(r),bb=decode(g),c=decode(b),y=.2126*a+.7152*bb+.0722*c;
  a*=adjustment[1];bb*=adjustment[2];c*=adjustment[3];
  const changed=.2126*a+.7152*bb+.0722*c,n=changed>1e-8?y/changed:1;
  a*=n*gain;bb*=n*gain;c*=n*gain;
  out[0]=TO2020[0]*a+TO2020[1]*bb+TO2020[2]*c;
  out[1]=TO2020[3]*a+TO2020[4]*bb+TO2020[5]*c;
  out[2]=TO2020[6]*a+TO2020[7]*bb+TO2020[8]*c;return out;
 }
 function highlight(r,g,b){
  const y=Math.max(0,.2627002*r+.6779981*g+.0593017*b),peak=Math.max(0,FROM2020[0]*r+FROM2020[1]*g+FROM2020[2]*b,FROM2020[3]*r+FROM2020[4]*g+FROM2020[5]*b,FROM2020[6]*r+FROM2020[7]*g+FROM2020[8]*b),drive=.4*y+.6*peak,t=clamp((drive-.48)/.40,0,1);
  return drive*t*t*(3-2*t);
 }
 function outputRGB(r,g,b,out,index){
  let a=FROM2020[0]*r+FROM2020[1]*g+FROM2020[2]*b,bb=FROM2020[3]*r+FROM2020[4]*g+FROM2020[5]*b,c=FROM2020[6]*r+FROM2020[7]*g+FROM2020[8]*b;
  if(!Number.isFinite(a)||!Number.isFinite(bb)||!Number.isFinite(c))throw new Error('效果产生非有限颜色');
  // One final hue-preserving SDR gamut fit. In-gamut LUT colors pass through.
  const min=Math.min(a,bb,c),max=Math.max(a,bb,c);
  if(min<0||max>1){const y=clamp(.2126*a+.7152*bb+.0722*c,0,1);let sat=1;
   for(const v of [a,bb,c]){if(v<0)sat=Math.min(sat,y/Math.max(y-v,1e-12));if(v>1)sat=Math.min(sat,(1-y)/Math.max(v-y,1e-12));}
   a=y+sat*(a-y);bb=y+sat*(bb-y);c=y+sat*(c-y);
  }
  out[index]=Math.round(255*clamp(encode(a),0,1));out[index+1]=Math.round(255*clamp(encode(bb),0,1));out[index+2]=Math.round(255*clamp(encode(c),0,1));out[index+3]=255;
 }
 function makeCanvas(width,height){const c=document.createElement('canvas');c.width=width;c.height=height;return c;}
 // These surfaces contain encoded sRGB for the LUT, independently of the
 // Float32 linear Rec.2020 effect workspace. Requesting float readback from
 // an RGB8 surface alone cannot restore precision already discarded there.
 function inputContext(canvas,mode){
  return canvas.getContext('2d',{colorSpace:'srgb',colorType:mode==='srgb-float16'?'float16':'unorm8',willReadFrequently:true});
 }
 function floatInputValid(ctx,pixels){
  const attrs=typeof ctx.getContextAttributes==='function'?ctx.getContextAttributes():null;
  return !!(attrs&&attrs.colorSpace==='srgb'&&attrs.colorType==='float16'&&pixels.colorSpace==='srgb'&&pixels.pixelFormat==='rgba-float16'&&typeof Float16Array!=='undefined'&&pixels.data instanceof Float16Array);
 }
 function inputCapability(){
  const a=makeCanvas(1,1),b=makeCanvas(1,1);
  try{
   const source=inputContext(a,'srgb-float16'),target=inputContext(b,'srgb-float16');if(!source||!target)return false;
   // A drawImage positive control must retain non-RGB8 values. Some hosts
   // silently ignore either option; a container/type check is insufficient.
   source.fillStyle='color(srgb 0.12345 0.45678 0.78901)';source.fillRect(0,0,1,1);target.drawImage(a,0,0);
   const pixels=target.getImageData(0,0,1,1,{colorSpace:'srgb',pixelFormat:'rgba-float16'});if(!floatInputValid(target,pixels))return false;
   const expected=[.12345,.45678,.78901];
   return expected.every((v,i)=>Math.abs(pixels.data[i]-v)<=1/4096&&Math.abs(pixels.data[i]*255-Math.round(pixels.data[i]*255))>.01)&&pixels.data[3]===1;
  }catch(error){return false;}finally{a.width=a.height=b.width=b.height=1;}
 }
 function inputPixels(ctx,w,h,mode,generation){
  try{
   if(!ctx)throw new Error('照片输入 Canvas不可用');
   const pixels=mode==='srgb-float16'?ctx.getImageData(0,0,w,h,{colorSpace:'srgb',pixelFormat:'rgba-float16'}):ctx.getImageData(0,0,w,h);
   if(pixels.data.length!==w*h*4||(mode==='srgb-float16'?!floatInputValid(ctx,pixels):!(pixels.data instanceof Uint8ClampedArray)))throw new Error('照片输入精度不符');
   return pixels.data;
  }catch(error){if(mode==='srgb-float16'){const failure=new Error('高精度照片读取失败：'+error.message);failure.inputReadFailure=true;failure.inputGeneration=generation;throw failure;}throw error;}
 }
 function canvasFromRGB(data,w,h){const c=makeCanvas(w,h),ctx=c.getContext('2d',{colorSpace:'srgb'}),pixels=new Uint8ClampedArray(w*h*4);for(let i=0;i<w*h;i++)outputRGB(data[i*3],data[i*3+1],data[i*3+2],pixels,i*4);ctx.putImageData(new ImageData(pixels,w,h),0,0);return c;}
 function canvasFromEncoded(data,w,h){const c=makeCanvas(w,h),ctx=c.getContext('2d',{colorSpace:'srgb'}),pixels=new Uint8ClampedArray(w*h*4);for(let i=0;i<w*h;i++){pixels[i*4]=Math.round(data[i*3]);pixels[i*4+1]=Math.round(data[i*3+1]);pixels[i*4+2]=Math.round(data[i*3+2]);pixels[i*4+3]=255;}ctx.putImageData(new ImageData(pixels,w,h),0,0);return c;}
 function encodeTile(data,w,h){const bytes=new Uint8ClampedArray(w*h*4);for(let i=0;i<w*h;i++)outputRGB(data[i*3],data[i*3+1],data[i*3+2],bytes,i*4);return bytes;}
 // Exact pixel-area reduction. Average AFTER nonlinear color/highlight/grain;
 // every destination cell has equal source area, including fractional edges.
 function accumulate(tile,tw,th,x0,y0,sw,sh,target,dw,dh,channels,sourceChannels,endpointWeights){
  const sx=dw/sw,sy=dh/sh;
  for(let y=0;y<th;y++){
   const ya=(y+y0)*sy,yb=(y+y0+1)*sy,iy0=Math.floor(ya),iy1=Math.min(dh-1,Math.ceil(yb)-1);
   for(let x=0;x<tw;x++){
    const xa=(x+x0)*sx,xb=(x+x0+1)*sx,ix0=Math.floor(xa),ix1=Math.min(dw-1,Math.ceil(xb)-1),p=(y*tw+x)*(sourceChannels||channels);
    for(let iy=iy0;iy<=iy1;iy++)for(let ix=ix0;ix<=ix1;ix++){
     const weight=Math.max(0,Math.min(xb,ix+1)-Math.max(xa,ix))*Math.max(0,Math.min(yb,iy+1)-Math.max(ya,iy)),d=(iy*dw+ix)*channels;
     const endpoint=endpointWeights?((x+x0===0||x+x0===sw-1)?.5:1)*((y+y0===0||y+y0===sh-1)?.5:1):1;
     for(let ch=0;ch<channels;ch++)target[d+ch]+=tile[p+ch]*weight*endpoint;
    }
   }
  }
 }
 // Keep RGB8 preview accumulation separate from Float32 optical fields.
 function accumulateEncoded(tile,tw,th,x0,y0,sw,sh,target,dw,dh,channels,sourceChannels){
  const sx=dw/sw,sy=dh/sh;
  for(let y=0;y<th;y++){
   const ya=(y+y0)*sy,yb=(y+y0+1)*sy,iy0=Math.floor(ya),iy1=Math.min(dh-1,Math.ceil(yb)-1);
   for(let x=0;x<tw;x++){
    const xa=(x+x0)*sx,xb=(x+x0+1)*sx,ix0=Math.floor(xa),ix1=Math.min(dw-1,Math.ceil(xb)-1),p=(y*tw+x)*(sourceChannels||channels);
    for(let iy=iy0;iy<=iy1;iy++)for(let ix=ix0;ix<=ix1;ix++){
     const weight=Math.max(0,Math.min(xb,ix+1)-Math.max(xa,ix))*Math.max(0,Math.min(yb,iy+1)-Math.max(ya,iy)),d=(iy*dw+ix)*channels;
     for(let ch=0;ch<channels;ch++)target[d+ch]+=tile[p+ch]*weight;
    }
   }
  }
 }
 function sampleField(field,w,h,x,y,sw,sh,ch){
  const qx=clamp((x+.5)*w/sw-.5,0,w-1),qy=clamp((y+.5)*h/sh-.5,0,h-1),ix=Math.floor(qx),iy=Math.floor(qy),jx=Math.min(w-1,ix+1),jy=Math.min(h-1,iy+1),fx=qx-ix,fy=qy-iy;
  const channels=field.length/(w*h),a=field[(iy*w+ix)*channels+ch],b=field[(iy*w+jx)*channels+ch],c=field[(jy*w+ix)*channels+ch],d=field[(jy*w+jx)*channels+ch];return (a+(b-a)*fx)*(1-fy)+(c+(d-c)*fx)*fy;
 }
 // Three-channel field sampling shares the same coordinate/index calculation.
 // Ordinary JS numbers preserve each channel's double-precision expression;
 // only the existing destination assignment rounds to Float32.
 function sampleFieldRGB(field,w,h,x,y,sw,sh,out){
  const qx=clamp((x+.5)*w/sw-.5,0,w-1),qy=clamp((y+.5)*h/sh-.5,0,h-1),ix=Math.floor(qx),iy=Math.floor(qy),jx=Math.min(w-1,ix+1),jy=Math.min(h-1,iy+1),fx=qx-ix,fy=qy-iy;
  const channels=field.length/(w*h),i00=(iy*w+ix)*channels,i10=(iy*w+jx)*channels,i01=(jy*w+ix)*channels,i11=(jy*w+jx)*channels;
  for(let ch=0;ch<3;ch++){
   const a=field[i00+ch],b=field[i10+ch],c=field[i01+ch],d=field[i11+ch];out[ch]=(a+(b-a)*fx)*(1-fy)+(c+(d-c)*fx)*fy;
  }
 }
 // Dragging is a separate immutable proxy channel. Its source is prepared
 // once; only palette uniforms change while the stable source-size pipeline
 // is running. Default RGBA8 framebuffer needs no float-render extension.
 function colorGPU(source,w,h){
  const canvas=makeCanvas(w,h),gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true});
  let vertex=null,fragment=null,program=null,texture=null,vao=null,released=false;
  if(!gl){drop();return null;}
  const vertexSource='#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
  const fragmentSource=`#version 300 es
   precision highp float;precision highp int;precision highp sampler2D;
   out vec4 frag;uniform sampler2D source;uniform vec4 adjustment;uniform int height;
   vec3 rec2020(vec3 v){return vec3(dot(v,vec3(.6274039149284363,.3292830288410187,.04331306740641594)),dot(v,vec3(.06909728795289993,.9195404052734375,.011362316086888313)),dot(v,vec3(.016391439363360405,.08801330626010895,.8955952525138855)));}
   vec3 srgb(vec3 v){return vec3(dot(v,vec3(1.6604909896850586,-.587641179561615,-.07284986227750778)),dot(v,vec3(-.1245504766702652,1.1328998804092407,-.008349422365427017)),dot(v,vec3(-.01815076172351837,-.10057889670133591,1.118729591369629)));}
   float encoded(float v){return v<=.0031308?12.92*v:1.055*pow(v,1./2.4)-.055;}
   void main(){ivec2 q=ivec2(gl_FragCoord.xy);q.y=height-1-q.y;vec3 v=texelFetch(source,q,0).rgb;
    float y=dot(v,vec3(.2126,.7152,.0722));v*=adjustment.yzw;float changed=dot(v,vec3(.2126,.7152,.0722));v*=(changed>1e-8?y/changed:1.)*adjustment.x;v=srgb(rec2020(v));
    if(min(min(v.r,v.g),v.b)<0.||max(max(v.r,v.g),v.b)>1.){float l=clamp(dot(v,vec3(.2126,.7152,.0722)),0.,1.),sat=1.;for(int i=0;i<3;i++){if(v[i]<0.)sat=min(sat,l/max(l-v[i],1e-12));if(v[i]>1.)sat=min(sat,(1.-l)/max(v[i]-l,1e-12));}v=vec3(l)+sat*(v-vec3(l));}
    vec3 e=clamp(vec3(encoded(v.r),encoded(v.g),encoded(v.b)),0.,1.);frag=vec4(floor(e*255.+.5)/255.,1.);
   }`;
  function drop(){if(gl){if(texture)gl.deleteTexture(texture);if(vao)gl.deleteVertexArray(vao);if(program)gl.deleteProgram(program);if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);const ext=gl.getExtension('WEBGL_lose_context');if(ext)ext.loseContext();}canvas.width=canvas.height=1;released=true;}
  try{
   vertex=gl.createShader(gl.VERTEX_SHADER);fragment=gl.createShader(gl.FRAGMENT_SHADER);gl.shaderSource(vertex,vertexSource);gl.compileShader(vertex);gl.shaderSource(fragment,fragmentSource);gl.compileShader(fragment);
   if(!gl.getShaderParameter(vertex,gl.COMPILE_STATUS)||!gl.getShaderParameter(fragment,gl.COMPILE_STATUS))throw new Error('调色GPU编译失败');program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('调色GPU链接失败');
   vao=gl.createVertexArray();texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   const rgba=new Float32Array(w*h*4);for(let i=0;i<w*h;i++){rgba[i*4]=source[i*3];rgba[i*4+1]=source[i*3+1];rgba[i*4+2]=source[i*3+2];rgba[i*4+3]=1;}gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,w,h,0,gl.RGBA,gl.FLOAT,rgba);if(gl.getError()!==gl.NO_ERROR)throw new Error('调色GPU源读取失败');
   if('drawingBufferColorSpace' in gl)gl.drawingBufferColorSpace='srgb';gl.disable(gl.DITHER);gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'source'),0);gl.uniform1i(gl.getUniformLocation(program,'height'),h);const uniform=gl.getUniformLocation(program,'adjustment');
   return {canvas,bytes:w*h*16,render(adjustment){if(released||gl.isContextLost())throw new Error('调色GPU已释放');gl.useProgram(program);gl.bindVertexArray(vao);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform4fv(uniform,adjustment);gl.viewport(0,0,w,h);gl.drawArrays(gl.TRIANGLES,0,3);gl.flush();if(gl.getError()!==gl.NO_ERROR)throw new Error('调色GPU绘制失败');return canvas;},release:drop};
  }catch(error){drop();return null;}
 }
 function createSession(image,options){
  options=options||{};const sw=Math.round(options.sourceWidth||image.naturalWidth||image.width),sh=Math.round(options.sourceHeight||image.naturalHeight||image.height);
  if(!(sw>0&&sh>0))throw new Error('照片尺寸无效');
  const pd=fit(sw,sh,Math.min(PREVIEW_EDGE,Math.max(1,options.previewEdge||PREVIEW_EDGE)),Math.min(PREVIEW_PIXELS,Math.max(1,options.previewPixels||PREVIEW_PIXELS))),fd=fit(sw,sh,FIELD_EDGE,FIELD_EDGE*FIELD_EDGE),seed=(options.seed===undefined?291:options.seed)>>>0;
  // A session selects one input mode for all tiles and both preview lanes.
  // Small gallery JPEGs already contain RGB8; keep their existing contract.
  let inputMode=options.inputMode==='srgb-unorm8'||options.thumbnail?'srgb-unorm8':inputCapability()?'srgb-float16':'srgb-unorm8',inputFallback=inputMode==='srgb-unorm8'&&!options.thumbnail&&options.inputMode!=='srgb-unorm8'?'浏览器不支持高精度照片读取':'',inputRevision=0;
  let sourceCanvas=null,sourceCtx=null,pixelOps=null;
  let epoch=0,released=false,currentStyle=null,backend=null,backendForceCPU=false,baseCache=null,fieldCache=null,colorCanvas=null,colorCanvasKey=null,colorCanvasSnapshot=null,active=false,colorPreviewDeferredKey=null;
  // Complete, original-source results only. Keep one palette's recent texture
  // selections; changing its base invalidates every dependent result.
  const finalPreviews=new Map(),finalColors=new Map();
  const cd=fit(sw,sh,COLOR_EDGE,COLOR_EDGE*COLOR_EDGE);
  let colorSource=null,colorPending=null,colorPublicPending=null,colorPublicKey=null,colorRenderer=null,colorCPUCanvas=null,colorActive=false,colorFallback='',colorPreparationCount=0;
  const wakeups=new Set();
  function alive(cancelled,generation){check(()=>released||generation!==epoch||(cancelled&&cancelled()));}
  function pause(cancelled,generation){return new Promise((resolve,reject)=>{let cancelTask=null,done=false;const finish=error=>{if(done)return;done=true;if(cancelTask)cancelTask();wakeups.delete(abort);if(error)reject(error);else resolve();};const abort=()=>finish(new Error('已取消'));wakeups.add(abort);const resume=()=>{try{alive(cancelled,generation);finish();}catch(error){finish(error);}};if(typeof filmifyScheduleTask==='function')cancelTask=filmifyScheduleTask(resume);else{const timer=setTimeout(resume,0);cancelTask=()=>clearTimeout(timer);}});}
  function waitResource(promise,cancelled,generation){return new Promise((resolve,reject)=>{let timer=null,done=false;const finish=(error,result)=>{if(done)return;done=true;if(timer!==null)clearTimeout(timer);wakeups.delete(abort);if(error)reject(error);else resolve(result);};const abort=()=>finish(new Error('已取消'));wakeups.add(abort);const poll=()=>{try{alive(cancelled,generation);timer=setTimeout(poll,32);}catch(error){finish(error);}};poll();promise.then(result=>{try{alive(cancelled,generation);finish(null,result);}catch(error){finish(error);}},error=>finish(error));});}
  function dropCanvas(canvas){if(canvas)canvas.width=canvas.height=1;}
  function finalPreviewBytes(){let bytes=0;for(const entry of finalPreviews.values())bytes+=entry.canvas.width*entry.canvas.height*4;return bytes;}
  function finalColorPreviewBytes(){let bytes=0;for(const rgba of finalColors.values())bytes+=rgba.byteLength;return bytes;}
  function pruneFinalColors(){const used=new Set(Array.from(finalPreviews.values(),entry=>entry.colorKey));for(const key of finalColors.keys())if(!used.has(key))finalColors.delete(key);}
  function clearFinalPreviews(){for(const entry of finalPreviews.values())dropCanvas(entry.canvas);finalPreviews.clear();finalColors.clear();colorCanvasSnapshot=null;}
  function clearInputDependents(){
   baseCache=fieldCache=null;colorPreviewDeferredKey=null;dropCanvas(colorCanvas);colorCanvas=null;colorCanvasKey=null;colorCanvasSnapshot=null;clearFinalPreviews();colorSource=null;colorPending=null;colorPublicPending=null;colorPublicKey=null;
   if(colorRenderer)colorRenderer.release();colorRenderer=null;dropCanvas(colorCPUCanvas);colorCPUCanvas=null;colorFallback='';
  }
  function inputStats(){return {inputMode,inputFallback,inputRevision,inputBytesPerPixel:inputMode==='srgb-float16'?8:4};}
  function downgradeInput(error){
   if(released||inputMode!=='srgb-float16'||!error.inputReadFailure||error.inputGeneration!==epoch)return;
   // Retire every dependent result before retrying the whole transaction.
   // An in-flight sibling lane observes this revision and also starts over.
   inputMode='srgb-unorm8';inputFallback=error.message;inputRevision++;epoch++;
   for(const wake of Array.from(wakeups))wake();clearInputDependents();dropCanvas(sourceCanvas);sourceCanvas=sourceCtx=null;
  }
  async function withInputFallback(operation,value,opts){
   const revision=inputRevision,key=resourceKey(value);
   try{return await operation(value,opts);}catch(error){
    downgradeInput(error);
    if(inputRevision!==revision&&!released&&currentStyle&&currentStyle.key===key&&!(opts&&opts.cancelled&&opts.cancelled()))return operation(value,opts);
    throw error;
   }
  }
  function sessionInputContext(canvas,generation){
   try{const ctx=inputContext(canvas,inputMode);if(!ctx)throw new Error('照片输入 Canvas不可用');return ctx;}catch(error){if(inputMode==='srgb-float16'){const failure=new Error('高精度照片 Canvas创建失败：'+error.message);failure.inputReadFailure=true;failure.inputGeneration=generation;throw failure;}throw error;}
  }
  function sourceSurface(generation){if(!sourceCanvas){sourceCanvas=makeCanvas(TILE,TILE);sourceCtx=sessionInputContext(sourceCanvas,generation);}return sourceCtx;}
  function drawInput(ctx,w,h,generation,rect){
   try{
    ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);
    if(rect)ctx.drawImage(image,rect[0],rect[1],w,h,0,0,w,h);else ctx.drawImage(image,0,0,w,h);
    return inputPixels(ctx,w,h,inputMode,generation);
   }catch(error){if(inputMode==='srgb-float16'&&!error.inputReadFailure){const failure=new Error('高精度照片绘制失败：'+error.message);failure.inputReadFailure=true;failure.inputGeneration=generation;throw failure;}throw error;}
  }
  function activateStyle(value){
   const resource=styleResource(value),key=resourceKey(value);if(currentStyle&&currentStyle.key===key)return resource;
   if(currentStyle){
    // A style is upstream of every photo/color field. Invalidate both lanes
    // together and wake old waiters before a new revision can prepare data.
    epoch++;for(const wake of Array.from(wakeups))wake();clearInputDependents();
   }
   currentStyle={id:resource.id,paper:paperId(value),key};return resource;
  }
  function getFinalPreview(key){const entry=finalPreviews.get(key);if(!entry)return null;finalPreviews.delete(key);finalPreviews.set(key,entry);return entry;}
  function finalPreviewKey(s,opts,pixelMode){return [inputMode,pixelMode,opts.disableTilePipeline?'array-stages':'tile-pipeline',opts.disableTextureDirect?'array-areas':'texture-areas',s.style,s.tone,s.color,s.grain,s.soft,s.halation,s.grainFormatMm,seed,opts.forceCPU?'cpu':'auto',s.softFamily||'black_pro_mist',s.softStrength===undefined?'level':s.softStrength,s.opticsFormatMm||35,s.opticsFormatId||'inferred',paperId(s),!!s.halationNeutral,s.grainFrameHeightMm===undefined?'legacy':s.grainFrameHeightMm,...(s.softNeutral?['neutral']:[]),...(s.grainSize===undefined?[]:['grain-size',s.grainSize]),...(s.grainAmountScale===undefined?[]:['grain-amount-scale',s.grainAmountScale]),opts.disableAdaptiveTile?'fixed-grid':'adaptive-grid',opts.exactNear?'fft-reference':'separable'].join(':');}
  function cachedFinalPreview(key,t0,cancelled,generation){
   alive(cancelled,generation);alive(null,generation);const cached=finalPreviews.get(key);if(!cached)return null;
   if(cached.colorRGBA&&(!colorCanvas||colorCanvasKey!==cached.colorKey||colorCanvasSnapshot!==cached.colorRGBA)){
    const restored=makeCanvas(pd.width,pd.height);restored.getContext('2d',{colorSpace:'srgb'}).putImageData(new ImageData(cached.colorRGBA,pd.width,pd.height),0,0);
    try{alive(cancelled,generation);alive(null,generation);}catch(error){dropCanvas(restored);throw error;}
    dropCanvas(colorCanvas);colorCanvas=restored;colorCanvasKey=cached.colorKey;colorCanvasSnapshot=cached.colorRGBA;
   }
   alive(cancelled,generation);alive(null,generation);getFinalPreview(key);
   return {canvas:cached.canvas,width:pd.width,height:pd.height,colorCanvas,stats:Object.assign({},cached.stats,{path:'cache',computationPath:cached.stats.path,cacheHit:true,ms:performance.now()-t0,cacheBytes:cacheBytes(),finalPreviewEntries:finalPreviews.size,finalPreviewBytes:finalPreviewBytes(),finalColorPreviewBytes:finalColorPreviewBytes()})};
  }
  function keepFinalPreview(key,canvas,stats){
   const previous=finalPreviews.get(key);if(previous){finalPreviews.delete(key);if(previous.canvas!==canvas)dropCanvas(previous.canvas);}
   // Retain one encoded color snapshot per palette and pixel mode. Entries
   // share the bounded RGBA8 bytes; optical fields stay in the active mode.
   let colorRGBA=finalColors.get(baseCache.key);
   if(!colorRGBA){colorRGBA=new Uint8ClampedArray(pd.width*pd.height*4);for(let i=0;i<pd.width*pd.height;i++){colorRGBA[i*4]=Math.round(baseCache.preview[i*3]);colorRGBA[i*4+1]=Math.round(baseCache.preview[i*3+1]);colorRGBA[i*4+2]=Math.round(baseCache.preview[i*3+2]);colorRGBA[i*4+3]=255;}finalColors.set(baseCache.key,colorRGBA);}
   colorCanvasSnapshot=colorRGBA;
   finalPreviews.set(key,{canvas,stats:Object.assign({},stats),colorKey:baseCache.key,paletteKey:baseCache.paletteKey,colorRGBA});
   while(finalPreviews.size>FINAL_PREVIEW_ENTRIES||finalPreviewBytes()>FINAL_PREVIEW_BYTES){const oldest=finalPreviews.keys().next().value,entry=finalPreviews.get(oldest);finalPreviews.delete(oldest);dropCanvas(entry.canvas);}
   pruneFinalColors();
  }
  function colorCacheBytes(){return (colorSource?colorSource.byteLength:0)+(colorCPUCanvas?cd.width*cd.height*4:0)+(colorRenderer?cd.width*cd.height*4:0);}
  function cacheBytes(){let n=colorCacheBytes()+finalPreviewBytes()+finalColorPreviewBytes();if(baseCache)n+=(baseCache.preview?baseCache.preview.byteLength:0)+baseCache.field.byteLength+baseCache.highlights.byteLength+(baseCache.nearInput?baseCache.nearInput.byteLength:0);if(fieldCache){if(fieldCache.diffusion)n+=fieldCache.diffusion.byteLength;if(fieldCache.halation)n+=fieldCache.halation.byteLength;if(fieldCache.near)n+=fieldCache.near.byteLength;}if(colorCanvas)n+=colorCanvas.width*colorCanvas.height*4;return n;}
  function prepareColorOnce(value){
   if(released)return Promise.reject(new Error('照片会话已释放'));const s=settings(value);activateStyle(s);if(colorSource)return Promise.resolve(Object.assign({width:cd.width,height:cd.height,style:s.style},inputStats()));if(colorPending)return colorPending;
   const generation=epoch,operation=(async()=>{const table=await waitResource(prepareLUT(s),null,generation),staging=makeCanvas(cd.width,cd.height);
    try{alive(null,generation);const ctx=sessionInputContext(staging,generation),bytes=drawInput(ctx,cd.width,cd.height,generation),divisor=inputMode==='srgb-float16'?1:255,data=new Float32Array(cd.width*cd.height*3),rgb=[0,0,0];let last=performance.now();
     for(let y=0;y<cd.height;y++){for(let x=0;x<cd.width;x++){const i=(y*cd.width+x)*4,p=(y*cd.width+x)*3;sampleLUT(table,bytes[i]/divisor,bytes[i+1]/divisor,bytes[i+2]/divisor,rgb);applyPaper(rgb[0],rgb[1],rgb[2],s,rgb);data[p]=decode(rgb[0]);data[p+1]=decode(rgb[1]);data[p+2]=decode(rgb[2]);}if(performance.now()-last>6){await pause(null,generation);last=performance.now();}}
     alive(null,generation);colorSource=data;colorPreparationCount++;return Object.assign({width:cd.width,height:cd.height,style:s.style},inputStats());
    }finally{dropCanvas(staging);}
   })();colorPending=operation;operation.catch(()=>{if(colorPending===operation)colorPending=null;});return operation;
  }
  function prepareColor(value){
   if(released)return Promise.reject(new Error('照片会话已释放'));const s=settings(value),resource=activateStyle(s),key=[resource.id,resource.lut,paperId(s),inputMode,inputRevision].join(':');
   if(colorPublicPending&&colorPublicKey===key)return colorPublicPending;
   const operation=withInputFallback(prepareColorOnce,s);colorPublicPending=operation;colorPublicKey=key;
   operation.catch(()=>{if(colorPublicPending===operation){colorPublicPending=null;colorPublicKey=null;}});return operation;
  }
  async function renderColorOnce(value,opts){
   opts=opts||{};if(released)throw new Error('照片会话已释放');const s=settings(value);activateStyle(s);if(colorActive)throw new Error('调色会话已有处理中任务');colorActive=true;const generation=epoch,t0=performance.now(),adjustment=[Math.pow(2,s.tone/100*.70),Math.exp(.11*s.color/100),Math.exp(.015*s.color/100),Math.exp(-.14*s.color/100)];
   try{await waitResource(prepareColorOnce(s),opts.cancelled,generation);alive(opts.cancelled,generation);let output=null,path='cpu-color';
    if(!opts.forceCPU){if(!colorRenderer&&!colorFallback){colorRenderer=colorGPU(colorSource,cd.width,cd.height);if(!colorRenderer)colorFallback='调色GPU不可用';}if(colorRenderer){try{output=colorRenderer.render(adjustment);path='webgl2-color';}catch(error){colorFallback=error.message;colorRenderer.release();colorRenderer=null;}}}
    if(!output){if(!colorCPUCanvas)colorCPUCanvas=makeCanvas(cd.width,cd.height);const pixels=new Uint8ClampedArray(cd.width*cd.height*4);let last=performance.now();
     for(let y=0;y<cd.height;y++){for(let x=0;x<cd.width;x++){const p=(y*cd.width+x)*3;let r=colorSource[p],g=colorSource[p+1],b=colorSource[p+2],luma=.2126*r+.7152*g+.0722*b;r*=adjustment[1];g*=adjustment[2];b*=adjustment[3];const changed=.2126*r+.7152*g+.0722*b,n=(changed>1e-8?luma/changed:1)*adjustment[0];r*=n;g*=n;b*=n;
       outputRGB(TO2020[0]*r+TO2020[1]*g+TO2020[2]*b,TO2020[3]*r+TO2020[4]*g+TO2020[5]*b,TO2020[6]*r+TO2020[7]*g+TO2020[8]*b,pixels,(y*cd.width+x)*4);}
      if(performance.now()-last>6){await pause(opts.cancelled,generation);last=performance.now();}}
     alive(opts.cancelled,generation);colorCPUCanvas.getContext('2d',{colorSpace:'srgb'}).putImageData(new ImageData(pixels,cd.width,cd.height),0,0);output=colorCPUCanvas;
    }
    alive(opts.cancelled,generation);return {canvas:output,width:cd.width,height:cd.height,stats:Object.assign({path,version:VERSION,style:s.style,colorOnly:true,ms:performance.now()-t0,colorCacheBytes:colorCacheBytes(),colorGPUBytes:colorRenderer?colorRenderer.bytes:0,colorPreparationCount,cacheBytes:cacheBytes(),fallback:colorFallback},inputStats())};
   }finally{colorActive=false;}
  }
  function renderColor(value,opts){return withInputFallback(renderColorOnce,value,opts);}
  async function readTile(x,y,w,h,s,table,cancelled,generation,pad){
   pad=pad||0;const left=Math.max(0,x-pad),top=Math.max(0,y-pad),right=Math.min(sw,x+w+pad),bottom=Math.min(sh,y+h+pad),cw=right-left,ch=bottom-top;
   const ctx=sourceSurface(generation);sourceCanvas.width=cw;sourceCanvas.height=ch;const rgba=drawInput(ctx,cw,ch,generation,[left,top]),divisor=inputMode==='srgb-float16'?1:255,rgb=[0,0,0],linear=[0,0,0];let data=pixelOps&&pixelOps.preferRGBA?null:new Float32Array(cw*ch*3),last=performance.now();
   if(pixelOps){if(pixelOps.preferRGBA)data=pixelOps.color(rgba,inputMode,cw,ch);else data.set(pixelOps.color(rgba,inputMode));alive(cancelled,generation);await pause(cancelled,generation);}else{
   for(let yy=0;yy<ch;yy++){
    for(let xx=0;xx<cw;xx++){const i=(yy*cw+xx)*4,p=(yy*cw+xx)*3;sampleLUT(table,rgba[i]/divisor,rgba[i+1]/divisor,rgba[i+2]/divisor,rgb);grade(rgb[0],rgb[1],rgb[2],s,linear);data[p]=linear[0];data[p+1]=linear[1];data[p+2]=linear[2];}
    if(performance.now()-last>6){await pause(cancelled,generation);last=performance.now();}
   }
   }
   alive(cancelled,generation);if(!pad)return {data,width:w,height:h};
   const pw=w+pad*2,ph=h+pad*2;if(pixelOps)return {data:pixelOps.pad(data,cw,left,top,x,y,w,h,pad,sw,sh),width:pw,height:ph};const padded=new Float32Array(pw*ph*3);
   for(let yy=0;yy<ph;yy++)for(let xx=0;xx<pw;xx++){
    const sx=FilmifyTextureOptics.mirror(x-pad+xx,sw)-left,sy=FilmifyTextureOptics.mirror(y-pad+yy,sh)-top,i=(sy*cw+sx)*3,p=(yy*pw+xx)*3;padded[p]=data[i];padded[p+1]=data[i+1];padded[p+2]=data[i+2];
   }return {data:padded,width:pw,height:ph};
  }
  async function readResidentTile(x,y,w,h,cancelled,generation){
   const ctx=sourceSurface(generation);sourceCanvas.width=w;sourceCanvas.height=h;
   const rgba=drawInput(ctx,w,h,generation,[x,y]),data=pixelOps.colorTexture(rgba,inputMode,w,h);
   alive(cancelled,generation);await pause(cancelled,generation);return {data,width:w,height:h};
  }
  async function buildBase(s,table,cancelled,generation,progress,colorPreview,near){
   const direct=!!(pixelOps&&pixelOps.textureDirect),paletteKey=[inputMode,s.style,s.tone,s.color,paperId(s)].join(':'),key=paletteKey+':'+(s._pixelMode||'javascript');if(baseCache&&baseCache.key===key&&baseCache.textureDirect===direct&&(colorPreview===false||baseCache.preview)&&(!near||!near.field||baseCache.nearKey===near.key))return baseCache;
   // The active fields belong to one pixel mode. Completed finals in the
   // other mode remain valid for the same palette and have separate keys.
   const previous=finalPreviews.values().next().value;if(previous&&previous.paletteKey!==paletteKey)clearFinalPreviews();
   baseCache=fieldCache=null;
   const nearInput=near&&near.field?new Float32Array(near.width*near.height*3):null;
   const preview=colorPreview===false?null:new Float32Array(pd.width*pd.height*3),field=new Float32Array(fd.width*fd.height*3),highlights=new Float32Array(fd.width*fd.height);let count=0,total=Math.ceil(sw/TILE)*Math.ceil(sh/TILE);
   if(pixelOps){pixelOps.areaBegin(field,fd.width,fd.height,3,sw,sh);pixelOps.areaBegin(highlights,fd.width,fd.height,1,sw,sh);if(preview)pixelOps.areaBegin(preview,pd.width,pd.height,3,sw,sh);if(nearInput)pixelOps.areaBegin(nearInput,near.width,near.height,3,sw,sh);}
   for(let y=0;y<sh;y+=TILE)for(let x=0;x<sw;x+=TILE){
    alive(cancelled,generation);const w=Math.min(TILE,sw-x),h=Math.min(TILE,sh-y),tile=direct?await readResidentTile(x,y,w,h,cancelled,generation):await readTile(x,y,w,h,s,table,cancelled,generation),hs=pixelOps?null:new Float32Array(w*h);
    if(!pixelOps)for(let i=0;i<hs.length;i++)hs[i]=highlight(tile.data[i*3],tile.data[i*3+1],tile.data[i*3+2]);
    if(preview){if(direct){const encoded=pixelOps.encodeTextureResult(tile.data,false);pixelOps.areaTexture(encoded.encoded,w,h,x,y,sw,sh,preview,pd.width,pd.height,3);}else{const encoded=pixelOps?pixelOps.encode(tile.data):encodeTile(tile.data,w,h);if(pixelOps)pixelOps.area(encoded,w,h,x,y,sw,sh,preview,pd.width,pd.height,3,4);else accumulateEncoded(encoded,w,h,x,y,sw,sh,preview,pd.width,pd.height,3,4);}}
    if(direct)pixelOps.areaFieldsTexture(tile.data,w,h,x,y,sw,sh,field,highlights,fd.width,fd.height);else if(pixelOps)pixelOps.areaFields(tile.data,w,h,x,y,sw,sh,field,highlights,fd.width,fd.height);else{accumulate(tile.data,w,h,x,y,sw,sh,field,fd.width,fd.height,3);accumulate(hs,w,h,x,y,sw,sh,highlights,fd.width,fd.height,1);}
    if(nearInput){if(direct)pixelOps.areaTexture(tile.data,w,h,x,y,sw,sh,nearInput,near.width,near.height,3,undefined,true);else if(pixelOps)pixelOps.area(tile.data,w,h,x,y,sw,sh,nearInput,near.width,near.height,3,tile.data.channels||3,true);else accumulate(tile.data,w,h,x,y,sw,sh,nearInput,near.width,near.height,3,3,true);}
    if(progress)progress(.25*(++count/total));await pause(cancelled,generation);
   }
   alive(cancelled,generation);if(pixelOps){pixelOps.areaFinish(field);pixelOps.areaFinish(highlights);if(preview)pixelOps.areaFinish(preview);if(nearInput)pixelOps.areaFinish(nearInput);}baseCache={key,paletteKey,preview,field,highlights,nearInput,nearKey:nearInput?near.key:null,textureDirect:direct};dropCanvas(colorCanvas);colorCanvasSnapshot=null;colorCanvas=preview?canvasFromEncoded(preview,pd.width,pd.height):null;colorCanvasKey=preview?key:null;if(preview)colorPreviewDeferredKey=null;return baseCache;
  }
  async function opticalFields(base,s,cancelled,generation,forceCPU,near){
   if(!s.soft&&!s.halation)return null;
   if(!backend)backend=FilmifyTextureOptics.createBackend(forceCPU);
   const geometry=FilmifyTextureHalation.geometry(s);
   if(!fieldCache||fieldCache.key!==base.key)fieldCache={key:base.key,diffusion:null,halation:null,near:null};
   const current=fieldCache,w=fd.width,h=fd.height,diffusionKey=[s.softFamily||'black_pro_mist',geometry.id,!!s.softNeutral].join(':'),halationKey=[geometry.id,s.halation,!!s.halationNeutral].join(':');
   if(s.soft&&(!current.diffusion||current.diffusionKey!==diffusionKey)){
    const k=await FilmifyTextureOptics.kernel(w,h,geometry.frameHeightMm*1000/Math.min(w,h),'far',cancelled,s.softFamily,s.softNeutral,geometry.focalLengthMm);alive(cancelled,generation);const result=await backend.convolveRGB(base.field,w,h,k,cancelled,pixelOps);
    alive(cancelled,generation);current.diffusion=result;current.diffusionKey=diffusionKey;
   }
   if(near&&near.field&&(!current.near||current.nearKey!==near.key)){
    const result=await backend.gaussianRGB(base.nearInput,near.width,near.height,near.axes,cancelled,pixelOps);alive(cancelled,generation);await FilmifyTextureOptics.normalizeNearField(result,near.width,near.height,sw,sh,near.axes,cancelled);alive(cancelled,generation);current.near=result;current.nearKey=near.key;current.nearWidth=near.width;current.nearHeight=near.height;
   }
   if(s.halation&&(!current.halation||current.halationKey!==halationKey)){
    const result=await FilmifyTextureHalation.build(base.highlights,w,h,s,backend,cancelled);
    alive(cancelled,generation);current.halation=result;current.halationKey=halationKey;
   }return current;
  }
  async function quickColor(s,table,cancelled,generation){
   const staging=makeCanvas(pd.width,pd.height),c=makeCanvas(pd.width,pd.height),rgb=[0,0,0],linear=[0,0,0];let last=performance.now();
   try{const ctx=sessionInputContext(staging,generation),input=drawInput(ctx,c.width,c.height,generation),divisor=inputMode==='srgb-float16'?1:255,pixels=new Uint8ClampedArray(c.width*c.height*4);
    for(let y=0;y<c.height;y++){for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;sampleLUT(table,input[i]/divisor,input[i+1]/divisor,input[i+2]/divisor,rgb);grade(rgb[0],rgb[1],rgb[2],s,linear);outputRGB(linear[0],linear[1],linear[2],pixels,i);}if(performance.now()-last>6){await pause(cancelled,generation);last=performance.now();}}
    alive(cancelled,generation);c.getContext('2d',{colorSpace:'srgb'}).putImageData(new ImageData(pixels,c.width,c.height),0,0);dropCanvas(colorCanvas);colorCanvas=c;colorCanvasSnapshot=null;colorCanvasKey=[inputMode,s.style,s.tone,s.color,paperId(s),s._pixelMode||'javascript'].join(':');return c;
   }catch(error){dropCanvas(c);throw error;}finally{dropCanvas(staging);}
  }
  async function renderOnce(value,opts){
   opts=opts||{};if(released)throw new Error('照片会话已释放');const s=settings(value);activateStyle(s);if(active)throw new Error('照片会话已有处理中任务');active=true;
   s._adjustment=[Math.pow(2,s.tone/100*.70),Math.exp(.11*s.color/100),Math.exp(.015*s.color/100),Math.exp(-.14*s.color/100)];const generation=epoch,providedCancelled=opts.cancelled,cancelled=()=>released||generation!==epoch||(providedCancelled&&providedCancelled()),t0=performance.now(),preview=opts.preview!==false;const wantedCPU=!!opts.forceCPU;if(backend&&backendForceCPU!==wantedCPU){backend.release();backend=null;fieldCache=null;}backendForceCPU=wantedCPU;let output=null,previewCanvas=null,ownedOutput=false;const grainPaths=new Set();
   try{
    // A completed preview owns its pixels already. Match the requested lane
    // before allocating three GPU contexts; only a miss probes GPU support.
    if(preview&&!opts.colorOnly){
     const hasPixelModules=typeof FilmifyPixelOps!=='undefined'&&typeof FilmifyPixelColor!=='undefined'&&typeof FilmifyPixelRender!=='undefined'&&typeof FilmifyPixelEncode!=='undefined';
     const requestedMode=opts.disablePixelOps||opts.exactPixelOps||wantedCPU||!hasPixelModules?'javascript':'webgl2-pixels';
     const cached=cachedFinalPreview(finalPreviewKey(s,opts,requestedMode),t0,cancelled,generation);if(cached)return cached;
    }
    const table=await waitResource(prepareLUT(s),cancelled,generation);alive(cancelled,generation);
    if(!opts.disablePixelOps&&typeof FilmifyPixelOps!=='undefined'){
     let received=null,retired=false;const operation=FilmifyPixelOps.create(table,s,{exact:!!opts.exactPixelOps,forceCPU:wantedCPU,cancelled,tilePipeline:!opts.disableTilePipeline&&!opts.colorOnly,textureDirect:!opts.disableTextureDirect,sourceWidth:sw,sourceHeight:sh,seed,grainParams:grainParams(s)}).then(result=>{try{if(retired)throw new Error('已取消');alive(cancelled,generation);received=result;return result;}catch(error){if(result)result.dispose();throw error;}});
     try{pixelOps=await waitResource(operation,cancelled,generation);alive(cancelled,generation);}finally{retired=true;if(received&&received!==pixelOps)received.dispose();}
    }
    s._pixelMode=pixelOps?(pixelOps.mode||'webgl2-pixels'):'javascript';alive(cancelled,generation);
    // Resource/calibration preparation can use the existing asynchronous tile
    // waits. Its rejection is owned immediately; actual grain still awaits the
    // original shared resources and creates/validates its renderer itself.
    if(pixelOps&&!pixelOps.tilePipeline&&s.grain&&!opts.colorOnly&&!wantedCPU&&typeof FilmifyGrain!=='undefined'&&typeof FilmifyGrain.prepareLinear==='function'){
     FilmifyGrain.prepareLinear({sourceWidth:sw,sourceHeight:sh,params:grainParams(s),grainFormatMm:s.grainFormatMm,grainFrameHeightMm:s.grainFrameHeightMm,cancelled:()=>released||generation!==epoch||(providedCancelled&&providedCancelled())}).catch(()=>{});
     alive(cancelled,generation);
    }
    if(opts.colorOnly){
     const colorKey=[inputMode,s.style,s.tone,s.color,paperId(s),s._pixelMode||'javascript'].join(':');
     if((baseCache&&baseCache.key===colorKey)||colorPreviewDeferredKey===colorKey){if(!baseCache||baseCache.key!==colorKey||!baseCache.preview)await buildBase(s,table,cancelled,generation,null,true);if(colorCanvasKey!==baseCache.key||!colorCanvas){dropCanvas(colorCanvas);colorCanvas=canvasFromEncoded(baseCache.preview,pd.width,pd.height);colorCanvasSnapshot=null;colorCanvasKey=baseCache.key;}return {canvas:colorCanvas,width:pd.width,height:pd.height,colorCanvas,stats:Object.assign({path:'color-proxy',style:s.style,colorOnly:true,ms:performance.now()-t0,cacheBytes:cacheBytes()},inputStats())};}
     const canvas=await quickColor(s,table,cancelled,generation);return {canvas,width:pd.width,height:pd.height,colorCanvas:canvas,stats:Object.assign({path:'color-proxy',style:s.style,colorOnly:true,ms:performance.now()-t0,cacheBytes:cacheBytes()},inputStats())};
    }
    const key=finalPreviewKey(s,opts,s._pixelMode),cached=preview?cachedFinalPreview(key,t0,cancelled,generation):null;
    if(cached)return cached;
    // Original-sized app exports do not consume the extra color-only preview.
    // Keep the public default intact. The optional GPU performs the same area
    // weighting in Float32 blocks; the JS fallback retains per-pixel order.
    const colorPreview=preview||opts.colorPreview!==false,needsBase=colorPreview||s.soft||s.halation;
    if((s.soft||s.halation)&&!backend)backend=FilmifyTextureOptics.createBackend(wantedCPU);
    const geometry=FilmifyTextureHalation.geometry(s),plan=nearPlan(s,opts,geometry,backend,sw,sh);
    const base=needsBase?await buildBase(s,table,cancelled,generation,opts.onProgress,colorPreview,plan):null,fields=await opticalFields(base,s,cancelled,generation,opts.forceCPU,plan);
    alive(cancelled,generation);
    if(!s.soft&&!s.halation&&!s.grain&&preview){
     output=canvasFromEncoded(base.preview,pd.width,pd.height);ownedOutput=true;
    }else{
     const near=s.soft?(plan||await FilmifyTextureOptics.kernel(sw,sh,geometry.frameHeightMm*1000/Math.min(sw,sh),'near',cancelled,s.softFamily,s.softNeutral,geometry.focalLengthMm)):null,pad=near&&!(plan&&plan.field)?near.radius:0;
     // Compensate the filter's uniform light loss on this already developed
     // photo. Direct + scattered = 1 after compensation; a flat LUT colour
     // stays unchanged, while particle scattering still redistributes detail.
     const softness=FilmifyTextureOptics.scatterAmount(s.soft,s.softFamily,s.softStrength),nearEnergy=near?near.nearEnergyRGB:[0,0,0];
     const haloVector=[1,1,1],diffusionRGB=[0,0,0],haloRGB=[0,0,0],nearSample=[0,0,0];
     const accum=(preview||opts.includePreview)?new Float32Array(pd.width*pd.height*3):null;output=preview?null:makeCanvas(sw,sh);ownedOutput=!preview;const ctx=output?output.getContext('2d',{colorSpace:'srgb'}):null;
     if(pixelOps&&accum)pixelOps.areaBegin(accum,pd.width,pd.height,3,sw,sh);
     const tileEdge=plan?TILE:renderTileEdge(near,backend,opts,pixelOps),total=Math.ceil(sw/tileEdge)*Math.ceil(sh/tileEdge);let count=0;
     for(let y=0;y<sh;y+=tileEdge)for(let x=0;x<sw;x+=tileEdge){
      alive(cancelled,generation);const w=Math.min(tileEdge,sw-x),h=Math.min(tileEdge,sh-y),resident=!!(pixelOps&&pixelOps.tilePipeline&&(!near||plan&&plan.field)),input=resident?await readResidentTile(x,y,w,h,cancelled,generation):await readTile(x,y,w,h,s,table,cancelled,generation,pad);
      // GPU mix returns its own RGBA plane. Reserve a JS RGB plane only for
      // the CPU branch that fills it, rather than allocating then discarding
      // three Float32 channels for every source pixel.
      let rgb=!s.soft&&!s.halation?input.data:pixelOps?null:new Float32Array(w*h*3);let nearRGB=null;
      if(near&&!(plan&&plan.field)){nearRGB=plan?await backend.gaussianRGB(input.data,input.width,input.height,plan.axes,cancelled,pixelOps):await backend.convolveRGB(input.data,input.width,input.height,near,cancelled,pixelOps);alive(cancelled,generation);
       // A retired GPU must not continue a CPU scan with the adapted
       // grid. Discard this partial output, then retry the original grid.
       if(tileEdge!==TILE&&backend.path!=='webgl2'){const error=new Error('自适应图块GPU已回退');error.pixelStage=true;throw error;}
      }
      if(pixelOps&&(s.soft||s.halation))rgb=(pixelOps.tilePipeline?pixelOps.mixTexture:pixelOps.mix)(input.data,input.width,w,h,pad,nearRGB,fields,fd.width,fd.height,x,y,sw,sh,s,softness,nearEnergy,1,haloVector);
      else if(s.soft||s.halation)for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
       const i=(yy*w+xx)*3,si=((yy+pad)*input.width+xx+pad)*3,r=input.data[si],g=input.data[si+1],b=input.data[si+2],p=(yy+pad)*input.width+xx+pad;
       let receiver=0;if(s.halation){const y0=Math.max(0,.2627002*r+.6779981*g+.0593017*b);receiver=Math.pow(Math.max(0,1-clamp(y0/.85,0,1)),1.4);sampleFieldRGB(fields.halation,fd.width,fd.height,x+xx,y+yy,sw,sh,haloRGB);}
       if(s.soft){sampleFieldRGB(fields.diffusion,fd.width,fd.height,x+xx,y+yy,sw,sh,diffusionRGB);if(plan&&plan.field)sampleFieldRGB(fields.near,plan.width,plan.height,x+xx,y+yy,sw,sh,nearSample);}
       for(let ch=0;ch<3;ch++){
        const v=input.data[si+ch],scatter=s.soft?nearEnergy[ch]*(plan&&plan.field?nearSample[ch]:nearRGB[p*3+ch])+(1-nearEnergy[ch])*diffusionRGB[ch]:v;
        rgb[i+ch]=v+softness*(scatter-v)+(s.halation?haloRGB[ch]*receiver:0);
       }
      }
      let result=rgb,grainPath='none';
      if(s.grain){if(pixelOps&&pixelOps.tilePipeline){result=pixelOps.grainTexture(rgb,w,h,x,y);grainPath='webgl2';}else{if(typeof FilmifyGrain==='undefined'||!FilmifyGrain.renderLinear)throw new Error('颗粒模块未准备');const out=await FilmifyGrain.renderLinear({data:rgb,width:w,height:h,channels:rgb.channels||3,sourceWidth:sw,sourceHeight:sh,sourceOriginX:x,sourceOriginY:y,sourceStepX:1,sourceStepY:1},{params:grainParams(s),grainFormatMm:s.grainFormatMm,grainFrameHeightMm:s.grainFrameHeightMm,seed,cancelled:()=>released||generation!==epoch||(cancelled&&cancelled()),onProgress:null,forceCPU:opts.forceCPU,pixelOps});result=out.data;grainPath=out.path;}grainPaths.add(grainPath);}
      alive(cancelled,generation);
      if(opts.onLinearTile){const linear=pixelOps&&pixelOps.tilePipeline?pixelOps.readTexture(result):result;opts.onLinearTile({data:linear,width:w,height:h,x,y,sourceWidth:sw,sourceHeight:sh,channels:linear.channels||3});}alive(cancelled,generation);
      const encoded=pixelOps&&pixelOps.textureDirect&&accum?pixelOps.encodeTextureResult(result):null,bytes=encoded?encoded.bytes:pixelOps?(pixelOps.tilePipeline?pixelOps.encodeTexture(result):pixelOps.encode(result)):encodeTile(result,w,h);
      if(accum){if(encoded)pixelOps.areaTexture(encoded.encoded,w,h,x,y,sw,sh,accum,pd.width,pd.height,3);else if(pixelOps)pixelOps.area(bytes,w,h,x,y,sw,sh,accum,pd.width,pd.height,3,4);else accumulateEncoded(bytes,w,h,x,y,sw,sh,accum,pd.width,pd.height,3,4);}
      if(!preview)ctx.putImageData(new ImageData(bytes,w,h),x,y);
      if(opts.onProgress)opts.onProgress(.25+.73*(++count/total));await pause(cancelled,generation);
     }
     if(pixelOps&&accum)pixelOps.areaFinish(accum);
     if(preview){output=canvasFromEncoded(accum,pd.width,pd.height);ownedOutput=true;}else if(opts.includePreview)previewCanvas=canvasFromEncoded(accum,pd.width,pd.height);
    }
    alive(cancelled,generation);if(opts.onProgress)opts.onProgress(1);
    const opticsPath=s.soft&&backend?backend.path:'none',halationPath=s.halation&&backend?backend.gaussianPath:'none',grainPath=grainPaths.size?Array.from(grainPaths).join(','):'none',gpuUsed=[opticsPath,halationPath,grainPath].some(path=>path.includes('webgl2'));
    const stats=Object.assign({version:VERSION,grainModel:'Standard',nearMethod:plan?(plan.field?'shared-gaussian-field':'separable-source-tiles'):'fft-source-tiles',nearFieldWidth:plan&&plan.field?plan.width:0,nearFieldHeight:plan&&plan.field?plan.height:0,nearGaussianPath:plan?backend.nearGaussianPath:'none',opticsReference:'fotufilm-73dff127',halationModel:'Legacy SDR adaptation',opticsGeometry:FilmifyTextureHalation.geometry(s),style:s.style,paper:paperId(s),path:gpuUsed?'webgl2':s.soft||s.halation||s.grain?'cpu':'cpu-color',pixelOps:pixelOps?(pixelOps.mode||'webgl2-pixels'):'javascript',pixelOpsBytes:pixelOps?pixelOps.bytes:0,pixelOpsBytesAreEstimate:true,gpuMemoryEstimateScope:'Owned module working estimate; excludes driver overhead and process totals.',paths:{color:pixelOps?'webgl2':'cpu',softness:opticsPath,halation:halationPath,grain:grainPath,encode:pixelOps?(pixelOps.encodePath||'webgl2'):'cpu',previewArea:pixelOps?'webgl2':'cpu'},softFamily:s.softFamily||'black_pro_mist',softStrength:s.softStrength===undefined?null:s.softStrength,softNeutral:!!s.softNeutral,opticsFormatMm:s.opticsFormatMm||35,grainFrameHeightMm:s.grainFrameHeightMm===undefined?null:s.grainFrameHeightMm,halationLevel:s.halation,halationNeutral:!!s.halationNeutral,fallback:opts.pixelFallback|| (backend?backend.fallback:''),ms:performance.now()-t0,sourceWidth:sw,sourceHeight:sh,stablePreview:preview,previewDomain:'final-srgb8-area',fieldWidth:fd.width,fieldHeight:fd.height,cacheBytes:cacheBytes(),gpuOpticsPeakBytes:backend?backend.peakBytes:0,gpuOpticsPeakBytesAreEstimate:true},inputStats());
    stats.tilePipeline=pixelOps?Object.assign({used:!!(pixelOps.tilePipeline&&pixelOps.tilePipelineStats.tiles)},pixelOps.tilePipelineStats):{used:false,reason:opts.forceCPU?'forced CPU':opts.disablePixelOps?'pixel fallback':'pixel GPU unavailable',tiles:0,readbacks:0,linearReadbacks:0,residentColorTiles:0};
    stats.textureDirect=pixelOps?pixelOps.textureDirectStats:{enabled:false,used:false,baseTiles:0,linearAreaTiles:0,previewTiles:0,encodedTiles:0};
    if(s.grainSize!==undefined)stats.grainSize=s.grainSize;
    if(s.grainAmountScale!==undefined)stats.grainAmountScale=s.grainAmountScale;
    // A cancellation/release from a completion callback must not publish a
    // canvas or evict a previously completed selection from the LRU.
    alive(cancelled,generation);
    if(preview){keepFinalPreview(key,output,stats);ownedOutput=false;stats.cacheBytes=cacheBytes();}
    stats.finalPreviewEntries=finalPreviews.size;stats.finalPreviewBytes=finalPreviewBytes();stats.finalColorPreviewBytes=finalColorPreviewBytes();
    if(!colorPreview)colorPreviewDeferredKey=[inputMode,s.style,s.tone,s.color,paperId(s),s._pixelMode||'javascript'].join(':');
    return {canvas:output,previewCanvas,width:preview?pd.width:sw,height:preview?pd.height:sh,colorCanvas:colorPreview?colorCanvas:null,stats};
   }catch(error){if(ownedOutput&&output)dropCanvas(output);dropCanvas(previewCanvas);throw error;}finally{active=false;if(pixelOps)pixelOps.dispose();pixelOps=null;dropCanvas(sourceCanvas);}
  }
  async function render(value,opts){try{return await withInputFallback(renderOnce,value,opts);}catch(error){if(error.pixelStage&&!released&&!error.cancelled&&!(opts&&opts.disablePixelOps)&&!(opts&&opts.cancelled&&opts.cancelled()))return withInputFallback(renderOnce,value,Object.assign({},opts,{disablePixelOps:true,pixelFallback:error.message}));throw error;}}
  function release(){if(released)return;released=true;if(pixelOps)pixelOps.dispose();pixelOps=null;epoch++;for(const wake of Array.from(wakeups))wake();clearInputDependents();dropCanvas(sourceCanvas);sourceCanvas=sourceCtx=null;if(backend)backend.release();backend=null;}
  return {render,renderColor,prepareColor,release,getColorCanvas:()=>colorCanvas,getStats:()=>Object.assign({version:VERSION,style:currentStyle?currentStyle.id:null,released,active,colorActive,cacheBytes:cacheBytes(),finalPreviewEntries:finalPreviews.size,finalPreviewBytes:finalPreviewBytes(),finalColorPreviewBytes:finalColorPreviewBytes(),colorCacheBytes:colorCacheBytes(),colorGPUBytes:colorRenderer?colorRenderer.bytes:0,colorPreparationCount,colorWidth:cd.width,colorHeight:cd.height,previewWidth:pd.width,previewHeight:pd.height,sourceWidth:sw,sourceHeight:sh},inputStats())};
 }
 return {version:VERSION,createSession,prepare:prepareLUT,normalize:settings,_testing:{sampleLUT,lutFromPixels,grade,highlight,outputRGB,accumulate,fit,decode,encode,TO2020,FROM2020,lutStats,renderTileEdge,nearPlan}};
})();
if(typeof window!=='undefined')window.FilmifyTextureEngine=FilmifyTextureEngine;
if(typeof module!=='undefined'&&module.exports)module.exports=FilmifyTextureEngine;
