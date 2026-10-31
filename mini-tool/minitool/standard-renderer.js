/* Fotufilm Standard full-quality WebGL2 renderer, Apache-2.0, MUAStudio Inc.
 * Three Float32 passes preserve seeded clump fields and normalized frame-edge
 * Gaussian filtering. Intermediate targets never use RGBA8 or half precision.
 * One instance belongs to one render and must be disposed by its owner's finally. */
'use strict';
(function(root){
 function create(config,seed,material,options){
  options=options||{};const linear=!!options.linear,borrowed=!!options.gl;
  const shaders=root.FilmifyStandardGLSL;if(!shaders)throw new Error('Standard GPU模块尚未准备');
  if(!material||typeof material.glsl!=='string'||typeof material.createBinding!=='function')throw new Error('JPG材料尚未准备');
  const parameters=shaders.parameters(config,seed),radius=parameters.radius,canvas=borrowed?null:document.createElement('canvas');
  let gl=options.gl||null,disposed=false,materialBinding=null,framebuffer=null,vertexArray=null,revision=0;
  const programs=[],textures=[];let noiseTexture=null,horizontalTexture=null,sourceTexture=null,outputTexture=null;
  let noiseWidth=0,noiseHeight=0,horizontalWidth=0,horizontalHeight=0,imageWidth=0,imageHeight=0,sourceWidth=0,sourceHeight=0,readbackWidth=0,readbackHeight=0,gpuReadback=null;
  function dispose(){
   if(disposed)return;disposed=true;revision++;gpuReadback=null;
   noiseWidth=noiseHeight=horizontalWidth=horizontalHeight=imageWidth=imageHeight=sourceWidth=sourceHeight=readbackWidth=readbackHeight=0;
   if(materialBinding){materialBinding.dispose();materialBinding=null;}
   if(gl){programs.forEach(p=>gl.deleteProgram(p));textures.forEach(t=>gl.deleteTexture(t));if(framebuffer)gl.deleteFramebuffer(framebuffer);if(vertexArray)gl.deleteVertexArray(vertexArray);if(!borrowed){const lose=gl.getExtension('WEBGL_lose_context');if(lose)lose.loseContext();}}
   programs.length=textures.length=0;if(canvas)canvas.width=canvas.height=1;
  }
  function workingBytes(){return disposed?0:16*(noiseWidth*noiseHeight+horizontalWidth*horizontalHeight)+(linear?16:4)*(sourceWidth*sourceHeight+imageWidth*imageHeight)+(gpuReadback?gpuReadback.byteLength:0)+parameters.kernel.byteLength;}
  try{
   if(!borrowed)gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
   if(!gl)throw new Error('Standard GPU需要WebGL2');
   if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('Standard GPU需要Float32渲染目标');
   if(borrowed){gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER,null);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_ROW_LENGTH,0);gl.pixelStorei(gl.UNPACK_SKIP_PIXELS,0);gl.pixelStorei(gl.UNPACK_SKIP_ROWS,0);}
   const maxEdge=gl.getParameter(gl.MAX_TEXTURE_SIZE);if(radius*2+1>maxEdge)throw new Error('Standard GPU场半径超过设备限制');
   function shader(type,source){const result=gl.createShader(type);if(!result)throw new Error('Standard GPU shader空间不足');try{gl.shaderSource(result,source);gl.compileShader(result);if(!gl.getShaderParameter(result,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(result)||'Standard GPU shader编译失败');return result;}catch(error){gl.deleteShader(result);throw error;}}
   function program(fragment){const vs=shader(gl.VERTEX_SHADER,shaders.vertex);let fs=null,p=null;try{fs=shader(gl.FRAGMENT_SHADER,fragment);p=gl.createProgram();if(!p)throw new Error('Standard GPU程序空间不足');programs.push(p);gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p)||'Standard GPU程序链接失败');return p;}finally{gl.deleteShader(vs);if(fs)gl.deleteShader(fs);}}
   const noiseProgram=program(shaders.noiseFragment),horizontalProgram=program(shaders.horizontalFragment(radius)),finalProgram=program(shaders.finalFragment(radius,material.glsl,linear));
   framebuffer=gl.createFramebuffer();vertexArray=gl.createVertexArray();if(!framebuffer||!vertexArray)throw new Error('Standard GPU渲染空间不足');
   gl.bindVertexArray(vertexArray);gl.disable(gl.DITHER);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.STENCIL_TEST);
   function texture(){const result=gl.createTexture();if(!result)throw new Error('Standard GPU纹理空间不足');textures.push(result);gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,result);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return result;}
   noiseTexture=texture();horizontalTexture=texture();sourceTexture=texture();outputTexture=texture();
   materialBinding=material.createBinding(gl,finalProgram,2);
   const locations=new Map();
   function location(p,name){let cache=locations.get(p);if(!cache){cache=new Map();locations.set(p,cache);}if(!cache.has(name))cache.set(name,gl.getUniformLocation(p,name));return cache.get(name);}
   function uniform(p,name,type,value){const key=location(p,name);if(key===null)return;if(type==='1i')gl.uniform1i(key,value);else if(type==='1ui')gl.uniform1ui(key,value);else if(type==='1f')gl.uniform1f(key,value);else if(type==='2iv')gl.uniform2iv(key,value);else if(type==='2fv')gl.uniform2fv(key,value);else if(type==='3fv')gl.uniform3fv(key,value);}
   for(const p of [noiseProgram,horizontalProgram,finalProgram]){gl.useProgram(p);uniform(p,'uStdFrameSize','2iv',parameters.frameSize);uniform(p,'uStdKernel[0]','3fv',parameters.kernel);}
   gl.useProgram(noiseProgram);uniform(noiseProgram,'uStdSeed','1ui',parameters.seed);
   for(const name of ['lambda','poissonLimit','poissonSD','ownGain','sharedGain'])uniform(noiseProgram,'uStd'+name[0].toUpperCase()+name.slice(1),'1f',parameters[name]);
   uniform(noiseProgram,'uStdMonochrome','1i',parameters.monochrome?1:0);
   gl.useProgram(horizontalProgram);uniform(horizontalProgram,'uStdInput','1i',1);
   gl.useProgram(finalProgram);uniform(finalProgram,'uStdInput','1i',1);uniform(finalProgram,'uImage','1i',0);uniform(finalProgram,'uStdEnabled','1i',1);uniform(finalProgram,'uStdNeutral','1i',parameters.neutral?1:0);
   for(const name of ['strength','dMin','densityRange','anchor','fog','amplitude','toe','decay','hump','humpDensity','humpWidth'])uniform(finalProgram,'uStd'+name[0].toUpperCase()+name.slice(1),'3fv',parameters[name]);
   uniform(finalProgram,'uStdReversalProfile','2fv',parameters.reversalProfile);uniform(finalProgram,'uStdDensityLaw','1f',parameters.densityLaw);
   function allocate(target,w,h,float){gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,target);if(borrowed)gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER,null);gl.texImage2D(gl.TEXTURE_2D,0,float?gl.RGBA32F:gl.RGBA8,w,h,0,gl.RGBA,float?gl.FLOAT:gl.UNSIGNED_BYTE,null);}
   function attach(target){gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Standard GPU渲染目标不可用');}
   // Exercise a real Float32 attachment now; extension presence alone does not
   // prove that this host can render to the required intermediate format.
   allocate(noiseTexture,1,1,true);attach(noiseTexture);noiseWidth=noiseHeight=1;
   if(gl.getError()!==gl.NO_ERROR)throw new Error('Standard GPU Float32目标初始化失败');
   function alive(){
    if(disposed)throw new Error('已取消');if(gl.isContextLost())throw new Error('Standard GPU渲染中断，请重试');
   }
   function layout(w,h,x,y){
    alive();if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||!Number.isInteger(x)||!Number.isInteger(y))throw new Error('Standard GPU输入尺寸不符');
    if(x<0||y<0||x+w>config.sourceWidth||y+h>config.sourceHeight)throw new Error('Standard GPU分块必须位于完整源图内');
    const nw=w+radius*2,nh=h+radius*2,hw=w,hh=h+radius*2;
    if(Math.max(nw,nh,w,h)>maxEdge)throw new Error('Standard GPU分块超过设备限制');
    return {nw,nh,hw,hh};
   }
   function drawPasses(inputTexture,w,h,x,y,size){
    revision++;
    const {nw,nh,hw,hh}=size;
    if(noiseWidth!==nw||noiseHeight!==nh){allocate(noiseTexture,nw,nh,true);noiseWidth=nw;noiseHeight=nh;}
    if(horizontalWidth!==hw||horizontalHeight!==hh){allocate(horizontalTexture,hw,hh,true);horizontalWidth=hw;horizontalHeight=hh;}
    if(imageWidth!==w||imageHeight!==h){allocate(outputTexture,w,h,linear);imageWidth=w;imageHeight=h;}
    // A borrowed context may have been used by a different stage since the
    // preceding tile. Each pass owns its VAO/FBO and binds every sampled input.
    if(borrowed){gl.disable(gl.DITHER);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.STENCIL_TEST);gl.disable(gl.SCISSOR_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.RASTERIZER_DISCARD);gl.colorMask(true,true,true,true);for(let unit=0;unit<3;unit++)gl.bindSampler(unit,null);}
    gl.bindVertexArray(vertexArray);gl.useProgram(noiseProgram);uniform(noiseProgram,'uStdOrigin','2iv',new Int32Array([x-radius,y-radius]));attach(noiseTexture);gl.viewport(0,0,nw,nh);gl.drawArrays(gl.TRIANGLES,0,3);
    gl.useProgram(horizontalProgram);uniform(horizontalProgram,'uStdOrigin','2iv',new Int32Array([x,y-radius]));uniform(horizontalProgram,'uStdInputOrigin','2iv',new Int32Array([x-radius,y-radius]));gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,noiseTexture);attach(horizontalTexture);gl.viewport(0,0,hw,hh);gl.drawArrays(gl.TRIANGLES,0,3);
    gl.useProgram(finalProgram);uniform(finalProgram,'uStdOrigin','2iv',new Int32Array([x,y]));uniform(finalProgram,'uStdInputOrigin','2iv',new Int32Array([x,y-radius]));gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,horizontalTexture);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,inputTexture);materialBinding.bind();attach(outputTexture);gl.viewport(0,0,w,h);gl.drawArrays(gl.TRIANGLES,0,3);
   }
   function draw(data,w,h,x,y){
    const size=layout(w,h,x,y);if(!data||data.length!==w*h*4)throw new Error('Standard GPU输入尺寸不符');
    if(sourceWidth!==w||sourceHeight!==h){allocate(sourceTexture,w,h,linear);sourceWidth=w;sourceHeight=h;}
    if(readbackWidth!==w||readbackHeight!==h){gpuReadback=linear?new Float32Array(w*h*4):new Uint8ClampedArray(w*h*4);readbackWidth=w;readbackHeight=h;}
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,sourceTexture);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    if(borrowed){gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER,null);gl.pixelStorei(gl.UNPACK_ROW_LENGTH,0);gl.pixelStorei(gl.UNPACK_SKIP_PIXELS,0);gl.pixelStorei(gl.UNPACK_SKIP_ROWS,0);}
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,w,h,gl.RGBA,linear?gl.FLOAT:gl.UNSIGNED_BYTE,data);
    drawPasses(sourceTexture,w,h,x,y,size);
    if(borrowed){gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);gl.pixelStorei(gl.PACK_ALIGNMENT,1);gl.pixelStorei(gl.PACK_ROW_LENGTH,0);gl.pixelStorei(gl.PACK_SKIP_PIXELS,0);gl.pixelStorei(gl.PACK_SKIP_ROWS,0);}
    gl.readPixels(0,0,w,h,gl.RGBA,linear?gl.FLOAT:gl.UNSIGNED_BYTE,gpuReadback);if(gl.getError()!==gl.NO_ERROR)throw new Error('Standard GPU渲染空间不足');
    return gpuReadback;
   }
   function drawTexture(desc,w,h,x,y){
    const size=layout(w,h,x,y);
    if(!linear||!desc||desc.gl!==gl||!desc.texture||desc.texture===outputTexture||desc.width!==w||desc.height!==h||desc.channels!==4||typeof desc.assert!=='function')throw new Error('Standard GPU纹理输入不符');
    desc.assert();drawPasses(desc.texture,w,h,x,y,size);if(gl.getError()!==gl.NO_ERROR)throw new Error('Standard GPU渲染空间不足');
    const current=revision;return {gl,texture:outputTexture,width:w,height:h,channels:4,encoding:'linear-rec2020-float32',assert(){alive();if(revision!==current)throw new Error('Standard GPU纹理结果已过期');}};
   }
   return {draw,drawTexture,dispose,workingBytes};
  }catch(error){dispose();throw error;}
 }
 const api={version:'fotufilm-standard-renderer-1',create};root.FilmifyStandardRenderer=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:typeof global!=='undefined'?global:{});
