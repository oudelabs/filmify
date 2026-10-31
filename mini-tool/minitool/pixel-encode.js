/* Filmify original-size SDR encoding. Optional WebGL2 path, bounded per tile. */
(function(root){
 'use strict';
 function create(options){
  if(typeof document==='undefined')return null;
  options=options||{};const borrowed=!!options.gl,canvas=borrowed?null:document.createElement('canvas');if(canvas)canvas.width=canvas.height=1;
  const gl=options.gl||canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true});
  let vertex,fragment,program,texture,vao,framebuffer,outputTexture,released=false,generation=0,peakBytes=0,textureWidth=0,textureHeight=0,textureInternal=0,outputWidth=0,outputHeight=0,sourceBytes=0,outputBytes=0;
  function dispose(){if(released)return;released=true;generation++;if(gl){if(texture)gl.deleteTexture(texture);if(outputTexture)gl.deleteTexture(outputTexture);if(framebuffer)gl.deleteFramebuffer(framebuffer);if(vao)gl.deleteVertexArray(vao);if(program)gl.deleteProgram(program);if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);if(!borrowed){const lose=gl.getExtension('WEBGL_lose_context');if(lose)lose.loseContext();}}sourceBytes=outputBytes=0;if(canvas)canvas.width=canvas.height=1;}
  if(!gl){dispose();return null;}
  const vertexSource='#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
  const fragmentSource=`#version 300 es
   precision highp float;precision highp int;precision highp sampler2D;
   uniform sampler2D source;out vec4 frag;
   float encoded(float v){return v<=.0031308?12.92*v:1.055*pow(v,1./2.4)-.055;}
   void main(){vec4 sampleValue=texelFetch(source,ivec2(gl_FragCoord.xy),0);vec3 s=sampleValue.rgb;
    vec3 v=vec3(dot(s,vec3(1.6604909896850586,-.587641179561615,-.07284986227750778)),dot(s,vec3(-.1245504766702652,1.1328998804092407,-.008349422365427017)),dot(s,vec3(-.01815076172351837,-.10057889670133591,1.118729591369629)));
    if(!(sampleValue.a==1.)||any(isnan(v))||any(isinf(v))){frag=vec4(0.);return;}
    if(min(min(v.r,v.g),v.b)<0.||max(max(v.r,v.g),v.b)>1.){float y=clamp(dot(v,vec3(.2126,.7152,.0722)),0.,1.),sat=1.;for(int i=0;i<3;i++){if(v[i]<0.)sat=min(sat,y/max(y-v[i],1e-12));if(v[i]>1.)sat=min(sat,(1.-y)/max(v[i]-y,1e-12));}v=vec3(y)+sat*(v-vec3(y));}
    vec3 e=clamp(vec3(encoded(v.r),encoded(v.g),encoded(v.b)),0.,1.);frag=vec4(floor(e*255.+.5)/255.,1.);
   }`;
  try{
   function compile(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw Error(error||'成片编码 GPU 编译失败');}return shader;}
   vertex=compile(gl.VERTEX_SHADER,vertexSource);fragment=compile(gl.FRAGMENT_SHADER,fragmentSource);program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('成片编码 GPU 链接失败');
   texture=gl.createTexture();vao=gl.createVertexArray();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.disable(gl.DITHER);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);if(!borrowed&&'drawingBufferColorSpace' in gl)gl.drawingBufferColorSpace='srgb';
   function alive(){if(released||gl.isContextLost())throw Error('成片编码 GPU 已释放');}
   function prepare(w,h,forceTexture){
    alive();generation++;if(borrowed||forceTexture){
     if(!framebuffer){framebuffer=gl.createFramebuffer();outputTexture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+7);gl.bindTexture(gl.TEXTURE_2D,outputTexture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}
     gl.activeTexture(gl.TEXTURE0+7);gl.bindTexture(gl.TEXTURE_2D,outputTexture);if(outputWidth!==w||outputHeight!==h){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);outputWidth=w;outputHeight=h;}
     gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,outputTexture,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('成片编码 GPU 缓冲不可用');
    }else{if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;gl.bindFramebuffer(gl.FRAMEBUFFER,null);}
    gl.useProgram(program);gl.bindVertexArray(vao);gl.disable(gl.DITHER);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.SCISSOR_TEST);gl.disable(gl.STENCIL_TEST);gl.colorMask(true,true,true,true);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.PACK_ALIGNMENT,1);outputBytes=w*h*4;peakBytes=Math.max(peakBytes,sourceBytes+outputBytes);
   }
   function draw(source,w,h,count){gl.useProgram(program);gl.bindVertexArray(vao);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,source);gl.uniform1i(gl.getUniformLocation(program,'source'),0);gl.viewport(0,0,w,h);gl.drawArrays(gl.TRIANGLES,0,3);const out=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,out);if(gl.getError()!==gl.NO_ERROR)throw Error('成片编码 GPU 读取失败');return new Uint8ClampedArray(out.buffer,0,count*4);}
   function encodeTextureDraw(desc,withResult){
    alive();if(!desc||desc.gl!==gl||!desc.texture||desc.channels!==4||typeof desc.assert!=='function'||!Number.isInteger(desc.width)||!Number.isInteger(desc.height)||desc.width<1||desc.height<1||desc.width*desc.height>512*2048||Math.max(desc.width,desc.height)>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw Error('成片编码 GPU 纹理输入无效');if(withResult&&desc.encoding!=='linear-rec2020-float32')throw Error('成片编码 GPU 纹理输入色彩域无效');desc.assert();if(desc.texture===outputTexture)throw Error('成片编码 GPU 纹理输入与输出冲突');
    prepare(desc.width,desc.height,true);const bytes=draw(desc.texture,desc.width,desc.height,desc.width*desc.height);if(!withResult)return bytes;
    const current=generation,encodedTexture=outputTexture;let opaque=true;
    // Capture validity before publishing the independent bytes. Later caller
    // edits to that array cannot change the contents of the GPU texture.
    for(let i=3;i<bytes.length;i+=4)if(bytes[i]!==255){opaque=false;break;}
    function assertEncoded(){alive();if(generation!==current||outputTexture!==encodedTexture)throw Error('成片编码 GPU 纹理结果已失效');}
    return {bytes,encoded:{gl,texture:encodedTexture,width:desc.width,height:desc.height,channels:4,encoding:'srgb8',assert:assertEncoded,assertValidPixels(){assertEncoded();if(!opaque)throw Error('成片编码 GPU 纹理存在非有限颜色或非法透明度');}}};
   }
   return {encode(data){alive();const channels=data.channels||3,count=data.length/channels,w=Math.min(512,count),h=Math.ceil(count/w);if(!Number.isInteger(count)||count<1||h>2048)throw Error('成片编码图块尺寸无效');
    const input=count===w*h?data:new Float32Array(w*h*channels);if(input!==data)input.set(data);prepare(w,h,false);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);const internal=channels===4?gl.RGBA32F:gl.RGB32F,format=channels===4?gl.RGBA:gl.RGB;if(textureWidth===w&&textureHeight===h&&textureInternal===internal)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,w,h,format,gl.FLOAT,input);else{gl.texImage2D(gl.TEXTURE_2D,0,internal,w,h,0,format,gl.FLOAT,input);textureWidth=w;textureHeight=h;textureInternal=internal;}sourceBytes=w*h*channels*4;peakBytes=Math.max(peakBytes,w*h*20);return draw(texture,w,h,count);
   },encodeTexture(desc){return encodeTextureDraw(desc,false);},encodeTextureResult(desc){return encodeTextureDraw(desc,true);},dispose,get context(){return gl;},get peakBytes(){return peakBytes;},get gpuBytes(){return sourceBytes+outputBytes;}};
  }catch(error){dispose();return null;}
 }
 root.FilmifyPixelEncode={create};
})(typeof window!=='undefined'?window:globalThis);
