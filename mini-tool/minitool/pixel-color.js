/* Optional tile-local WebGL2 stock/print/palette conversion. Pure JS fallback.
 * Float32 GLSL differs from the original Double expressions; final quality
 * must be verified separately. Frozen LUT and print tables are not changed. */
(function(root){
 'use strict';
 const VERSION='gpu-color-tile-v1',LUT_SIZE=64,LUT_VALUES=64*64*64*3;
 const TO=[.6274039149284363,.3292830288410187,.04331306740641594,.06909728795289993,.9195404052734375,.011362316086888313,.016391439363360405,.08801330626010895,.8955952525138855];
 const VERTEX='#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
 const FRAGMENT=`#version 300 es
 precision highp float;precision highp int;precision highp sampler2D;precision highp sampler3D;
 uniform sampler2D source,monoTable;
 uniform sampler3D stockTable,printTable;
 uniform int printKind,printSize;
 uniform vec4 adjustment;
 out vec4 frag;
 bool finite3(vec3 v){return !any(isnan(v))&&!any(isinf(v));}
 float decode(float v){return v<=.04045?v/12.92:pow((v+.055)/1.055,2.4);}
 float encode(float v){return v<=.0031308?12.92*v:1.055*pow(v,1./2.4)-.055;}
 vec3 trilinear(sampler3D table,vec3 color,int size){
  vec3 v=clamp(color,0.,1.)*float(size-1);ivec3 p=min(ivec3(floor(v)),ivec3(size-2));vec3 f=v-vec3(p);
  vec3 v000=texelFetch(table,p,0).rgb,v100=texelFetch(table,p+ivec3(1,0,0),0).rgb;
  vec3 v010=texelFetch(table,p+ivec3(0,1,0),0).rgb,v110=texelFetch(table,p+ivec3(1,1,0),0).rgb;
  vec3 v001=texelFetch(table,p+ivec3(0,0,1),0).rgb,v101=texelFetch(table,p+ivec3(1,0,1),0).rgb;
  vec3 v011=texelFetch(table,p+ivec3(0,1,1),0).rgb,v111=texelFetch(table,p+ivec3(1,1,1),0).rgb;
  vec3 a=v000+f.x*(v100-v000),b=v010+f.x*(v110-v010);
  vec3 d=v001+f.x*(v101-v001),e=v011+f.x*(v111-v011);
  return (a+f.y*(b-a))+f.z*((d+f.y*(e-d))-(a+f.y*(b-a)));
 }
 vec3 printed(vec3 color){
  if(printKind==0)return color;
  vec3 v=clamp(color,0.,1.);
  if(printKind==2){
   float y=clamp(encode(.2126*decode(v.r)+.7152*decode(v.g)+.0722*decode(v.b)),0.,1.);
   float x=y*1024.;int i=min(1023,int(floor(x)));float a=texelFetch(monoTable,ivec2(i,0),0).r,b=texelFetch(monoTable,ivec2(i+1,0),0).r;
   return vec3(a+(x-float(i))*(b-a));
  }
  return clamp(v+trilinear(printTable,v,printSize)/510.,0.,1.);
 }
 void main(){
  vec3 inputColor=texelFetch(source,ivec2(gl_FragCoord.xy),0).rgb;
  if(!finite3(inputColor)){frag=vec4(0.);return;}
  vec3 stock=trilinear(stockTable,inputColor,64);if(!finite3(stock)){frag=vec4(0.);return;}
  vec3 v=printed(stock);if(!finite3(v)){frag=vec4(0.);return;}
  vec3 linear=vec3(decode(v.r),decode(v.g),decode(v.b));
  float y=.2126*linear.r+.7152*linear.g+.0722*linear.b;
  linear*=adjustment.yzw;
  float changed=.2126*linear.r+.7152*linear.g+.0722*linear.b,n=changed>1e-8?y/changed:1.;
  linear*=n*adjustment.x;
  vec3 result=vec3(
   .6274039149284363*linear.r+.3292830288410187*linear.g+.04331306740641594*linear.b,
   .06909728795289993*linear.r+.9195404052734375*linear.g+.011362316086888313*linear.b,
   .016391439363360405*linear.r+.08801330626010895*linear.g+.8955952525138855*linear.b);
  frag=finite3(result)?vec4(result,1.):vec4(0.);
 }`;
 function cancelledError(){const error=new Error('色彩处理已取消');error.cancelled=true;return error;}
 function fromHalf(bits){const sign=bits&32768?-1:1,e=(bits>>>10)&31,m=bits&1023;return e===31?(m?NaN:sign*Infinity):e===0?sign*m*Math.pow(2,-24):sign*(1+m/1024)*Math.pow(2,e-15);}
 const clamp=x=>Math.max(0,Math.min(1,x));
 const decode=x=>x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4);
 const encode=x=>x<=.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-.055;
 function sample(table,size,r,g,b,out){
  const x=clamp(r)*(size-1),y=clamp(g)*(size-1),z=clamp(b)*(size-1),ix=Math.min(size-2,Math.floor(x)),iy=Math.min(size-2,Math.floor(y)),iz=Math.min(size-2,Math.floor(z)),fx=x-ix,fy=y-iy,fz=z-iz,p=((iz*size+iy)*size+ix)*3,dy=size*3,dz=size*size*3;
  for(let c=0;c<3;c++){const a=table[p+c]+fx*(table[p+3+c]-table[p+c]),bb=table[p+dy+c]+fx*(table[p+dy+3+c]-table[p+dy+c]),d=table[p+dz+c]+fx*(table[p+dz+3+c]-table[p+dz+c]),e=table[p+dz+dy+c]+fx*(table[p+dz+dy+3+c]-table[p+dz+dy+c]);out[c]=(a+fy*(bb-a))+fz*((d+fy*(e-d))-(a+fy*(bb-a)));}return out;
 }
 function create(table,settings,options){
  options=options||{};settings=settings||{};
  if(!(table instanceof Float32Array)||table.length!==LUT_VALUES)throw new Error('色彩 LUT 尺寸无效');
  const maxBytes=options.maxBytes===undefined?64*1024*1024:options.maxBytes,maxPixels=options.maxPixels===undefined?1024*1024:options.maxPixels,rgbaOutput=!!options.rgba;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxPixels)||maxPixels<1)throw new Error('色彩图块预算无效');
  const tone=settings.tone===undefined?0:settings.tone,color=settings.color===undefined?0:settings.color;
  const adjust=settings._adjustment?Array.from(settings._adjustment):[Math.pow(2,tone/100*.70),Math.exp(.11*color/100),Math.exp(.015*color/100),Math.exp(-.14*color/100)];
  if(adjust.length!==4||!adjust.every(Number.isFinite))throw new Error('色彩调整数值异常');
  const paperId=settings.paper||'scan',paper=options.paper||root.FilmifyPaperAdaptation||root.FilmifyFinishedPaper;
  const printSize=paper&&paper._testing?paper._testing.size:13;
  let kind=paperId==='scan'?0:paperId==='graded-print'?2:1,printData=null,monoData=null;
  if(kind){if(!paper||!paper._testing)throw new Error('印相载体资源未准备');if(kind===1){printData=paper._testing.tables.get(paperId);if(!printData||!Number.isInteger(printSize)||printSize<2||printSize>64||printData.length!==printSize*printSize*printSize*3)throw new Error('该印相载体尚未准备');}else{monoData=paper._testing.mono;if(!monoData||monoData.length!==1025)throw new Error('黑白印相资源尺寸异常');}}
  const frozenBytes=table.byteLength+(printData?printData.length*4:12)+(monoData?monoData.length*4:4);
  if(frozenBytes>maxBytes)throw new Error('色彩资源超出内存预算');
  let canvas=null,gl=null,program=null,vertex=null,fragment=null,vao=null,framebuffer=null,source=null,stock=null,print=null,mono=null,target=null;
  let released=false,busy=false,fallbackReason=null,peakBytes=0,gpuBytes=0,sourceShape='',targetShape='',gpuCalls=0,cpuCalls=0,generation=0;
  const ownedTextures=[],uniforms={};
  function alive(){if(released)throw new Error('色彩模块已释放');if(options.cancelled&&options.cancelled())throw cancelledError();}
  function freeGPU(){
   generation++;
   if(gl){for(const texture of ownedTextures)gl.deleteTexture(texture);ownedTextures.length=0;if(framebuffer)gl.deleteFramebuffer(framebuffer);if(vao)gl.deleteVertexArray(vao);if(program)gl.deleteProgram(program);if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);const lose=gl.getExtension('WEBGL_lose_context');if(lose)lose.loseContext();}
   if(canvas)canvas.width=canvas.height=1;
   gl=canvas=program=vertex=fragment=vao=framebuffer=source=stock=print=mono=target=null;gpuBytes=0;sourceShape=targetShape='';
  }
  function disable(error){fallbackReason=error&&error.message||String(error);freeGPU();}
  function dispose(){if(released)return;released=true;freeGPU();}
  function checkGL(message){if(gl.isContextLost()||gl.getError()!==gl.NO_ERROR)throw new Error(message);}
  try{
   alive();if(typeof document==='undefined')throw new Error('WebGL2 环境不可用');
   canvas=document.createElement('canvas');canvas.width=canvas.height=1;
   gl=canvas.getContext('webgl2',{alpha:false,premultipliedAlpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
   if(!gl||!gl.getExtension('EXT_color_buffer_float'))throw new Error('浮点色彩 GPU 不可用');
   if(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)<64||gl.getParameter(gl.MAX_TEXTURE_SIZE)<1025&&kind===2)throw new Error('色彩 GPU 纹理尺寸不足');
   function compile(type,text){const shader=gl.createShader(type);if(!shader)throw new Error('色彩 GPU Shader 分配失败');gl.shaderSource(shader,text);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const log=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(log||'色彩 GPU 编译失败');}return shader;}
   vertex=compile(gl.VERTEX_SHADER,VERTEX);fragment=compile(gl.FRAGMENT_SHADER,FRAGMENT);program=gl.createProgram();if(!program)throw new Error('色彩 GPU 程序分配失败');gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'色彩 GPU 链接失败');
   vao=gl.createVertexArray();framebuffer=gl.createFramebuffer();if(!vao||!framebuffer)throw new Error('色彩 GPU 图块分配失败');
   gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.PACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
   gl.disable(gl.DITHER);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.SCISSOR_TEST);
   function texture(type){const value=gl.createTexture();if(!value)throw new Error('色彩 GPU 纹理分配失败');ownedTextures.push(value);gl.bindTexture(type,value);gl.texParameteri(type,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(type,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(type,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(type,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);if(type===gl.TEXTURE_3D)gl.texParameteri(type,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);return value;}
   source=texture(gl.TEXTURE_2D);target=texture(gl.TEXTURE_2D);
   stock=texture(gl.TEXTURE_3D);gl.texImage3D(gl.TEXTURE_3D,0,gl.RGB32F,64,64,64,0,gl.RGB,gl.FLOAT,table);
   print=texture(gl.TEXTURE_3D);const printedFloats=printData?new Float32Array(printData):new Float32Array(3),printTextureSize=printData?printSize:1;gl.texImage3D(gl.TEXTURE_3D,0,gl.RGB32F,printTextureSize,printTextureSize,printTextureSize,0,gl.RGB,gl.FLOAT,printedFloats);
   mono=texture(gl.TEXTURE_2D);const monoFloats=monoData?new Float32Array(monoData):new Float32Array(1);gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,monoFloats.length,1,0,gl.RED,gl.FLOAT,monoFloats);
   gl.useProgram(program);for(const name of ['source','stockTable','printTable','monoTable','printKind','printSize','adjustment'])uniforms[name]=gl.getUniformLocation(program,name);
   gl.uniform1i(uniforms.source,0);gl.uniform1i(uniforms.stockTable,1);gl.uniform1i(uniforms.printTable,2);gl.uniform1i(uniforms.monoTable,3);gl.uniform1i(uniforms.printKind,kind);gl.uniform1i(uniforms.printSize,printSize);gl.uniform4fv(uniforms.adjustment,new Float32Array(adjust));
   checkGL('色彩 GPU 初始化失败');gpuBytes=frozenBytes;peakBytes=frozenBytes+printedFloats.byteLength+monoFloats.byteLength;
  }catch(error){if(error.cancelled){dispose();throw error;}disable(error);}
  function dimensions(bytes,mode,width,height){
   if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isSafeInteger(width*height)||width*height>maxPixels)throw new Error('色彩图块尺寸超出预算');
   const half=mode==='srgb-float16';if(!half&&mode!=='srgb-unorm8')throw new Error('色彩图块输入模式无效');
   if(!ArrayBuffer.isView(bytes)||bytes instanceof DataView||bytes.length!==width*height*4||bytes.BYTES_PER_ELEMENT!==(half?2:1))throw new Error('色彩图块输入尺寸无效');
   const tag=Object.prototype.toString.call(bytes);if(half?tag!=='[object Uint16Array]'&&tag!=='[object Float16Array]':tag!=='[object Uint8Array]'&&tag!=='[object Uint8ClampedArray]')throw new Error('色彩图块输入类型无效');
   const count=width*height,bytesRequired=frozenBytes+count*((half?8:4)+16+16+(rgbaOutput?0:12));if(bytesRequired>maxBytes)throw new Error('色彩图块超出内存预算');
   peakBytes=Math.max(peakBytes,bytesRequired);return {count,half,bytesRequired};
  }
  function jsColor(bytes,mode,width,height,shape){
   const result=new Float32Array(shape.count*(rgbaOutput?4:3)),input=shape.half?new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.length):bytes,rgb=[0,0,0],delta=[0,0,0];
   for(let i=0;i<shape.count;i++){
    if((i&4095)===0)alive();const p=i*4,r=shape.half?fromHalf(input[p]):input[p]/255,g=shape.half?fromHalf(input[p+1]):input[p+1]/255,b=shape.half?fromHalf(input[p+2]):input[p+2]/255;
    if(!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b))throw new Error('色彩输入存在非有限值');sample(table,64,r,g,b,rgb);
    if(kind){rgb[0]=clamp(rgb[0]);rgb[1]=clamp(rgb[1]);rgb[2]=clamp(rgb[2]);if(kind===2){const x=clamp(encode(.2126*decode(rgb[0])+.7152*decode(rgb[1])+.0722*decode(rgb[2])))*1024,j=Math.min(1023,Math.floor(x)),v=monoData[j]+(x-j)*(monoData[j+1]-monoData[j]);rgb[0]=rgb[1]=rgb[2]=v;}else{sample(printData,printSize,rgb[0],rgb[1],rgb[2],delta);for(let c=0;c<3;c++)rgb[c]=clamp(rgb[c]+delta[c]/510);}}
    let a=decode(rgb[0]),bb=decode(rgb[1]),c=decode(rgb[2]),y=.2126*a+.7152*bb+.0722*c;a*=adjust[1];bb*=adjust[2];c*=adjust[3];const changed=.2126*a+.7152*bb+.0722*c,n=changed>1e-8?y/changed:1;a*=n*adjust[0];bb*=n*adjust[0];c*=n*adjust[0];const q=i*(rgbaOutput?4:3);
    result[q]=TO[0]*a+TO[1]*bb+TO[2]*c;result[q+1]=TO[3]*a+TO[4]*bb+TO[5]*c;result[q+2]=TO[6]*a+TO[7]*bb+TO[8]*c;
    if(!Number.isFinite(result[q])||!Number.isFinite(result[q+1])||!Number.isFinite(result[q+2]))throw new Error('色彩输出存在非有限值');if(rgbaOutput)result[q+3]=1;
   }
   if(rgbaOutput)result.channels=4;return result;
  }
  function gpuColor(bytes,mode,width,height,shape,textureOnly){
   if(gl.isContextLost())throw new Error('色彩 GPU 上下文已丢失');if(width>gl.getParameter(gl.MAX_TEXTURE_SIZE)||height>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw new Error('色彩 GPU 图块尺寸不足');
   const current=++generation,context=gl,texture=target;
   const key=mode+':'+width+':'+height,data=shape.half?new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.length):new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);
   gl.disable(gl.DITHER);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.SCISSOR_TEST);gl.disable(gl.STENCIL_TEST);gl.colorMask(true,true,true,true);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.PACK_ALIGNMENT,1);
   gl.useProgram(program);gl.bindVertexArray(vao);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,source);
   if(sourceShape===key)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,width,height,gl.RGBA,shape.half?gl.HALF_FLOAT:gl.UNSIGNED_BYTE,data);else{gl.texImage2D(gl.TEXTURE_2D,0,shape.half?gl.RGBA16F:gl.RGBA8,width,height,0,gl.RGBA,shape.half?gl.HALF_FLOAT:gl.UNSIGNED_BYTE,data);sourceShape=key;}
   gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,stock);gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_3D,print);gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,mono);
   const outShape=width+':'+height;gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,target);if(targetShape!==outShape){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,width,height,0,gl.RGBA,gl.FLOAT,null);targetShape=outShape;}
   gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('色彩 GPU 浮点图块不可读取');
   gl.viewport(0,0,width,height);gl.drawArrays(gl.TRIANGLES,0,3);alive();checkGL('色彩 GPU 图块渲染失败');gpuBytes=frozenBytes+shape.count*((shape.half?8:4)+16);
   if(textureOnly)return {gl:context,texture,width,height,channels:4,encoding:'linear-rec2020-float32',assert(){alive();if(gl!==context||context.isContextLost()||target!==texture||generation!==current)throw new Error('色彩 GPU 纹理已失效');}};
   const out=new Float32Array(shape.count*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.FLOAT,out);checkGL('色彩 GPU 图块读取失败');alive();
   if(rgbaOutput){for(let i=3;i<out.length;i+=4){if(out[i]!==1)throw new Error('色彩 GPU 输出存在非法值');}out.channels=4;gpuBytes=frozenBytes+shape.count*((shape.half?8:4)+16);return out;}
   const rgb=new Float32Array(shape.count*3);for(let i=0,j=0;i<out.length;i+=4,j+=3){if(out[i+3]!==1)throw new Error('色彩 GPU 输出存在非法值');rgb[j]=out[i];rgb[j+1]=out[i+1];rgb[j+2]=out[i+2];}gpuBytes=frozenBytes+shape.count*((shape.half?8:4)+16);return rgb;
  }
  return {color(bytes,mode,width,height){
   alive();if(busy)throw new Error('色彩模块已有处理中图块');const shape=dimensions(bytes,mode,width,height);busy=true;
   try{if(gl){try{const out=gpuColor(bytes,mode,width,height,shape);gpuCalls++;return out;}catch(error){if(error.cancelled||released)throw error;disable(error);}}
    alive();cpuCalls++;const out=options.fallback?options.fallback(bytes,mode,width,height,{rgba:rgbaOutput}):jsColor(bytes,mode,width,height,shape);
    if(!(out instanceof Float32Array)||out.length!==shape.count*(rgbaOutput?4:3))throw new Error('色彩回退图块尺寸异常');
    if(options.fallback){const channels=rgbaOutput?4:3;for(let i=0;i<out.length;i+=channels){if((i&16383)===0)alive();if(!Number.isFinite(out[i])||!Number.isFinite(out[i+1])||!Number.isFinite(out[i+2])||(rgbaOutput&&out[i+3]!==1))throw new Error('色彩回退输出存在非法值');}}
    if(rgbaOutput)out.channels=4;alive();return out;
   }finally{busy=false;}
  },colorTexture(bytes,mode,width,height){
   alive();if(busy)throw new Error('色彩模块已有处理中图块');const shape=dimensions(bytes,mode,width,height);if(!gl)throw new Error('浮点色彩 GPU 不可用');busy=true;
   try{const out=gpuColor(bytes,mode,width,height,shape,true);gpuCalls++;return out;}catch(error){if(!error.cancelled&&!released)disable(error);throw error;}finally{busy=false;}
  },dispose,get context(){return gl;},get path(){return gl?'webgl2-color-tile':'javascript';},get fallback(){return fallbackReason;},get peakBytes(){return peakBytes;},get gpuBytes(){return gpuBytes;},get gpuCalls(){return gpuCalls;},get cpuCalls(){return cpuCalls;},version:VERSION};
 }
 const api={version:VERSION,create,_testing:{vertex:VERTEX,fragment:FRAGMENT,fromHalf,sample}};root.FilmifyPixelColor=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
