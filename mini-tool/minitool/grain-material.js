/* Fotufilm JPG material response, adapted from revision 54064ece.
 * Engine Apache-2.0, MUAStudio Inc.; Portra profile CC BY-SA 4.0.
 * Float32 numerical data is carried losslessly in an opaque RGB PNG so the
 * offline ES2017 package loads the data through Image and canvas. */
'use strict';
window.FilmifyGrainMaterial=(function(){
 const meta=window.FilmifyGrainMaterialData;
 const dMin=meta.dMin,dMax=meta.dMax,segments=meta.segments,LOAD_TIMEOUT=20000;
 let data=null,pending=null,loadCancel=null,epoch=0,retry=0;
 const bindings=new Set(),decode=new Float64Array(256);
 for(let i=0;i<256;i++){const x=i/255;decode[i]=x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4);}
 function check(cancelled,generation){if(generation!==epoch||(cancelled&&cancelled()))throw new Error('已取消');}
 async function prepareShared(){
  if(data)return;if(pending)return pending;
  const generation=epoch;
  const operation=(async()=>{
   const img=new Image();let canvas=null;
   try{
    await new Promise((resolve,reject)=>{
     let done=false,timer=null;
     const finish=error=>{if(done)return;done=true;img.onload=img.onerror=null;if(timer!==null){clearTimeout(timer);timer=null;}if(loadCancel===cancel)loadCancel=null;if(error){img.src='';reject(error);}else resolve();};
     const cancel=()=>{retry++;finish(new Error('已取消'));};loadCancel=cancel;
     img.onload=()=>finish();img.onerror=()=>finish(new Error('材料数据读取失败'));
     // The shared load has its own deadline; canceling one caller only stops
     // that caller's wait and must not abandon another preview's resource.
     timer=setTimeout(()=>finish(new Error('材料数据读取超时，请重试')),LOAD_TIMEOUT);
     try{img.src='./grain-material.png'+(retry?'?retry='+retry:'');}catch(error){finish(error);}
    });
    check(null,generation);
    if(img.naturalWidth!==meta.imageWidth||img.naturalHeight!==meta.imageHeight)throw new Error('材料数据尺寸不符');
    canvas=document.createElement('canvas');canvas.width=meta.imageWidth;canvas.height=meta.imageHeight;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('材料数据读取失败');ctx.drawImage(img,0,0);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const raw=new Uint8Array(meta.floatCount*4);for(let i=0;i<raw.length;i++)raw[i]=pixels[Math.floor(i/3)*4+i%3];
    const view=new DataView(raw.buffer),values=new Float32Array(meta.floatCount);
    for(let i=0;i<values.length;i++){const value=view.getFloat32(i*4,true);if(!Number.isFinite(value))throw new Error('材料数据损坏');values[i]=value;}
    check(null,generation);data=values;
   }finally{if(canvas)canvas.width=canvas.height=1;img.src='';}
  })();pending=operation;
  operation.catch(error=>{if(pending===operation){pending=null;if(error.message!=='已取消')retry++;}});
  return operation;
 }
 function prepare(cancelled){
  const generation=epoch;check(cancelled,generation);const operation=prepareShared();
  if(!cancelled)return operation;
  return new Promise((resolve,reject)=>{
   let done=false;const finish=error=>{if(done)return;done=true;clearInterval(timer);if(error)reject(error);else resolve();};
   const timer=setInterval(()=>{try{check(cancelled,generation);}catch(error){finish(error);}},32);
   operation.then(()=>{try{check(cancelled,generation);finish();}catch(error){finish(error);}},finish);
  });
 }
 function curve(channel,x){
  const s=segments['curve'+channel],count=s.count/3,base=s.offset;
  if(x<=data[base])return data[base+1];const last=base+(count-1)*3;if(x>=data[last])return data[last+1];
  let low=0,high=count-1;while(high-low>1){const mid=(low+high)>>>1;if(data[base+mid*3]<=x)low=mid;else high=mid;}
  const i=base+low*3,j=i+3,h=Math.max(data[j]-data[i],1e-12),t=Math.max(0,Math.min(1,(x-data[i])/h));
  const y0=data[i+1],delta=data[j+1]-y0,a=h*data[i+2],b=h*data[j+2];
  return y0+t*(a+t*(3*delta-2*a-b+t*(-2*delta+a+b)));
 }
 function face(channel,u,v,layer){
  const qx=Math.max(0,Math.min(1,u))*32,qy=Math.max(0,Math.min(1,v))*32;
  const ix=Math.min(31,Math.floor(qx)),iy=Math.min(31,Math.floor(qy)),fx=qx-ix,fy=qy-iy;
  const i=segments.faces.offset+((channel*33+iy)*33+ix)*3+layer;
  const a=data[i],d=data[i+102];
  return fx>=fy?a+fx*(data[i+3]-a)+fy*(d-data[i+3]):a+fy*(data[i+99]-a)+fx*(d-data[i+99]);
 }
 function warp(channel,u){const q=Math.max(0,Math.min(127,(u-meta.warpMin)*(127/(meta.warpMax-meta.warpMin)))),i=Math.min(126,Math.floor(q)),f=q-i,base=segments.warp.offset+channel*128;return data[base+i]+f*(data[base+i+1]-data[base+i]);}
 function density(r8,g8,b8,outD0,outLinear2020){
  const a=decode[r8],b=decode[g8],c=decode[b8],m=meta.srgbTo2020;
  const r=m[0]*a+m[1]*b+m[2]*c,g=m[3]*a+m[4]*b+m[5]*c,bl=m[6]*a+m[7]*b+m[8]*c;
  outLinear2020[0]=r;outLinear2020[1]=g;outLinear2020[2]=bl;
  densityLinear2020(r,g,bl,outD0);
 }
 // The exposure faces store chromaticity, not a bounded RGB cube: radiance
 // remains separate, so positive linear values above 1 need no clipping.
 // Native exposure-domain gamut compression affects material response only;
 // the original signed linear source is retained for texture carry.
 function densityLinear2020(r,g,bl,outD0){
  const e=meta.toExposureDomain;let dr=e[0]*r+e[1]*g+e[2]*bl,dg=e[3]*r+e[4]*g+e[5]*bl,db=e[6]*r+e[7]*g+e[8]*bl;
  if(dr<0||dg<0||db<0){const y=.2627002*r+.6779981*g+.0593017*bl;if(y<=0){dr=dg=db=0;}else{const s=Math.min(dr<0?y/(y-dr):1,dg<0?y/(y-dg):1,db<0?y/(y-db):1);dr=y+s*(dr-y);dg=y+s*(dg-y);db=y+s*(db-y);}}
  const peak=Math.max(dr,dg,db),radiance=Math.max(peak,1e-6),gain=radiance*meta.exposureGain/.18;
  let l0,l1,l2;
  if(peak===0){const i=segments.blackExposure.offset;l0=Math.log10(Math.max(data[i]*gain,1e-6));l1=Math.log10(Math.max(data[i+1]*gain,1e-6));l2=Math.log10(Math.max(data[i+2]*gain,1e-6));}
  else{const f=dr>=dg&&dr>=db?0:dg>=db?1:2,u=f===0?dg/radiance:dr/radiance,v=f===2?dg/radiance:db/radiance;l0=Math.log10(Math.max(face(f,u,v,0)*gain,1e-6));l1=Math.log10(Math.max(face(f,u,v,1)*gain,1e-6));l2=Math.log10(Math.max(face(f,u,v,2)*gain,1e-6));}
  const r0=Math.max(0,Math.min(1,(curve(0,l0)-dMin[0])/(dMax[0]-dMin[0]))),r1=Math.max(0,Math.min(1,(curve(1,l1)-dMin[1])/(dMax[1]-dMin[1]))),r2=Math.max(0,Math.min(1,(curve(2,l2)-dMin[2])/(dMax[2]-dMin[2])));
  const k=meta.inhibition,s=meta.couplerScale,u0=l0-s*(k[0]*r0+k[1]*r1+k[2]*r2),u1=l1-s*(k[3]*r0+k[4]*r1+k[5]*r2),u2=l2-s*(k[6]*r0+k[7]*r1+k[8]*r2);
  outD0[0]=curve(0,u0+warp(0,u0));outD0[1]=curve(1,u1+warp(1,u1));outD0[2]=curve(2,u2+warp(2,u2));
 }
 function encode(x){return x<=.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-.055;}
 function carryLinear(source,delta,out){for(let ch=0;ch<3;ch++)out[ch]=source[ch]*Math.exp(delta[ch]*2.3025851);}
 function carry(source,delta,out){
  const r=source[0]*Math.exp(delta[0]*2.3025851),g=source[1]*Math.exp(delta[1]*2.3025851),b=source[2]*Math.exp(delta[2]*2.3025851),m=meta.from2020;
  out[0]=255*Math.max(0,Math.min(1,encode(m[0]*r+m[1]*g+m[2]*b)));out[1]=255*Math.max(0,Math.min(1,encode(m[3]*r+m[4]*g+m[5]*b)));out[2]=255*Math.max(0,Math.min(1,encode(m[6]*r+m[7]*g+m[8]*b)));
 }
 const number=x=>Number(x).toExponential(9),vec=x=>'vec3('+x.map(number).join(',')+')';
 const matrix=(name,m)=>'vec3 '+name+'(vec3 p){return vec3(dot(p,'+vec(m.slice(0,3))+'),dot(p,'+vec(m.slice(3,6))+'),dot(p,'+vec(m.slice(6,9))+'));}';
 const glsl=`
 uniform highp sampler2D uMaterial;
 float materialFloat(int i){return texelFetch(uMaterial,ivec2(i%1024,i/1024),0).r;}
 ${matrix('material2020',meta.srgbTo2020)}
 ${matrix('materialDomain',meta.toExposureDomain)}
 ${matrix('materialSRGB',meta.from2020)}
 ${matrix('materialInhibition',meta.inhibition)}
 float materialCurve(int ch,float x){
  int base=ch==0?${segments.curve0.offset}:ch==1?${segments.curve1.offset}:${segments.curve2.offset};
  int count=ch==0?${segments.curve0.count/3}:ch==1?${segments.curve1.count/3}:${segments.curve2.count/3};
  int low=0;for(int stride=512;stride>0;stride/=2){int candidate=min(low+stride,count-1);if(materialFloat(base+candidate*3)<=x)low=candidate;}
  int i=base+low*3,j=base+min(low+1,count-1)*3;
  float h=max(materialFloat(j)-materialFloat(i),1e-12),t=clamp((x-materialFloat(i))/h,0.,1.);
  float y=materialFloat(i+1),d=materialFloat(j+1)-y,a=h*materialFloat(i+2),b=h*materialFloat(j+2);
  if(x<=materialFloat(base))return materialFloat(base+1);if(x>=materialFloat(base+(count-1)*3))return materialFloat(base+(count-1)*3+1);
  return y+t*(a+t*(3.*d-2.*a-b+t*(-2.*d+a+b)));
 }
 float materialFace(int f,vec2 uv,int ch){
  vec2 q=clamp(uv,0.,1.)*32.;ivec2 i=min(ivec2(q),ivec2(31));vec2 p=q-vec2(i);
  int base=${segments.faces.offset}+((f*33+i.y)*33+i.x)*3+ch;
  float a=materialFloat(base),d=materialFloat(base+102);
  if(p.x>=p.y){float b=materialFloat(base+3);return a+p.x*(b-a)+p.y*(d-b);}
  float c=materialFloat(base+99);return a+p.y*(c-a)+p.x*(d-c);
 }
 float materialWarp(int ch,float u){float q=clamp((u-(${number(meta.warpMin)}))*${number(127/(meta.warpMax-meta.warpMin))},0.,127.);int i=min(126,int(q)),base=${segments.warp.offset}+ch*128;return mix(materialFloat(base+i),materialFloat(base+i+1),q-float(i));}
 float materialDecode(float x){return x<=.04045?x/12.92:pow((x+.055)/1.055,2.4);}
 float materialEncode(float x){return x<=.0031308?12.92*x:1.055*pow(x,1./2.4)-.055;}
 void nativeMaterialLinear(vec3 linear2020,out vec3 density){
  vec3 domain=materialDomain(linear2020);if(any(lessThan(domain,vec3(0)))){float y=dot(linear2020,vec3(.2627002,.6779981,.0593017));float s=min(domain.r<0.?y/(y-domain.r):1.,min(domain.g<0.?y/(y-domain.g):1.,domain.b<0.?y/(y-domain.b):1.));domain=y<=0.?vec3(0):vec3(y)+s*(domain-vec3(y));}
  float peak=max(domain.r,max(domain.g,domain.b)),radiance=max(peak,1e-6);vec3 raw;
  if(peak==0.)raw=vec3(materialFloat(${segments.blackExposure.offset}),materialFloat(${segments.blackExposure.offset+1}),materialFloat(${segments.blackExposure.offset+2}));
  else{int f=domain.r>=domain.g&&domain.r>=domain.b?0:domain.g>=domain.b?1:2;vec2 uv=f==0?domain.gb/radiance:f==1?domain.rb/radiance:domain.rg/radiance;raw=vec3(materialFace(f,uv,0),materialFace(f,uv,1),materialFace(f,uv,2));}
  vec3 logE=log(max(raw*radiance*${number(meta.exposureGain/.18)},vec3(1e-6)))/log(10.);
  vec3 formed=vec3(materialCurve(0,logE.r),materialCurve(1,logE.g),materialCurve(2,logE.b));
  vec3 release=clamp((formed-${vec(dMin)})/(${vec(dMax)}-${vec(dMin)}),0.,1.);
  vec3 u=logE-${number(meta.couplerScale)}*materialInhibition(release);
  density=vec3(materialCurve(0,u.r+materialWarp(0,u.r)),materialCurve(1,u.g+materialWarp(1,u.g)),materialCurve(2,u.b+materialWarp(2,u.b)));
 }
 void nativeMaterial(vec3 encoded,out vec3 density,out vec3 linear2020){
  linear2020=material2020(vec3(materialDecode(encoded.r),materialDecode(encoded.g),materialDecode(encoded.b)));
  nativeMaterialLinear(linear2020,density);
 }
 vec3 nativeCarryLinear(vec3 source,vec3 delta){return source*exp(delta*2.3025851);}
 vec3 nativeCarry(vec3 source,vec3 delta){vec3 s=materialSRGB(source*exp(delta*2.3025851));return clamp(vec3(materialEncode(s.r),materialEncode(s.g),materialEncode(s.b)),0.,1.);}
 `;
 function createBinding(gl,program,unit){
  if(!data)throw new Error('材料数据尚未准备');const texture=gl.createTexture();if(!texture)throw new Error('材料纹理创建失败');
  const height=Math.ceil(data.length/1024),padded=new Float32Array(height*1024);padded.set(data);
  gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,1024,height,0,gl.RED,gl.FLOAT,padded);
  let active=true;const location=gl.getUniformLocation(program,'uMaterial'),binding={bind(){if(!active)throw new Error('材料纹理已释放');gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform1i(location,unit);},dispose(){if(!active)return;active=false;bindings.delete(binding);gl.deleteTexture(texture);}};bindings.add(binding);return binding;
 }
 function release(){epoch++;if(loadCancel)loadCancel();pending=null;data=null;for(const binding of bindings)binding.dispose();}
 function workingBytes(){return (data?data.byteLength:0)+bindings.size*(data?Math.ceil(data.length/1024)*1024*4:0);}
 return {prepare,release,workingBytes,dMin,dMax,density,densityLinear2020,carry,carryLinear2020:carryLinear,glsl,createBinding};
})();
