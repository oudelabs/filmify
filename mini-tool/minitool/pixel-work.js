/* Filmify optional bounded WebGL pixel pipeline. GPL-3.0-only. */
(function(root){
 'use strict';
 async function create(table,s,options){
  options=options||{};if(options.exact||options.forceCPU||!root.FilmifyPixelColor||!root.FilmifyPixelRender||!root.FilmifyPixelEncode)return null;
  let color=null,render=null,encoder=null,grain=null,gl=null;
  const pipeline=!!options.tilePipeline,direct=pipeline&&options.textureDirect!==false,counts={tiles:0,readbacks:0,linearReadbacks:0,residentColorTiles:0},directCounts={baseTiles:0,linearAreaTiles:0,previewTiles:0,encodedTiles:0};
  function discard(){if(grain)grain.dispose();if(encoder)encoder.dispose();if(render)render.dispose();if(color)color.dispose();}
  try{
   color=root.FilmifyPixelColor.create(table,s,{rgba:true,cancelled:options.cancelled});if(!color||color.path!=='webgl2-color-tile')throw Error('浮点颜色 GPU 不可用');
   if(pipeline){gl=color.context;if(!gl||typeof color.colorTexture!=='function')throw Error('共享颜色 GPU 不可用');}
   render=root.FilmifyPixelRender.create(gl?{gl}:undefined);if(!render)throw Error('像素 GPU 不可用');
   encoder=root.FilmifyPixelEncode.create(gl?{gl}:undefined);if(!encoder)throw Error('编码 GPU 不可用');
   if(pipeline&&(!render.mixTexture||!render.readTexture||!encoder.encodeTexture))throw Error('纹理流水线未准备');
   if(direct&&(!render.areaTexture||!encoder.encodeTextureResult))throw Error('面积纹理直传未准备');
   if(pipeline&&s.grain){
    if(!root.FilmifyGrain||!root.FilmifyGrain.createSharedRenderer)throw Error('共享颗粒 GPU 未准备');
    grain=await root.FilmifyGrain.createSharedRenderer({gl,sourceWidth:options.sourceWidth,sourceHeight:options.sourceHeight,params:options.grainParams,grainFormatMm:s.grainFormatMm,grainFrameHeightMm:s.grainFrameHeightMm,seed:options.seed,cancelled:options.cancelled});
   }
   if(options.cancelled&&options.cancelled())throw Error('已取消');
  }catch(error){discard();if(error.cancelled||error.message==='已取消'||options.cancelled&&options.cancelled())throw Error('已取消');if(pipeline)return create(table,s,Object.assign({},options,{tilePipeline:false,pipelineFallback:error.message}));return null;}
  let released=false;const areas=new Map();
  function check(){if(released||options.cancelled&&options.cancelled())throw Error('已取消');}
  function call(fn){check();try{const value=fn();check();return value;}catch(error){if(error.message!=='已取消')error.pixelStage=true;throw error;}}
  function opaque(data){for(let i=3;i<data.length;i+=4)if(data[i]!==1)throw Error('效果产生非有限颜色');data.channels=4;return data;}
  function encodedOutput(out,finalTile,validated){if(!validated)for(let i=3;i<out.length;i+=4)if(out[i]!==255)throw Error('效果产生非有限颜色');if(finalTile!==false){counts.tiles++;counts.readbacks++;}return out;}
  return {preferRGBA:true,mode:'webgl2-pixels',encodePath:'webgl2-pixel-encode',approximate:true,tilePipeline:pipeline,textureDirect:direct,
   get context(){return gl;},
   get tilePipelineStats(){return Object.assign({enabled:pipeline,reason:options.pipelineFallback||(!pipeline?'disabled':''),readbackScope:'Final RGB8 tiles; QA Float32 reads separate; excludes base/preview field passes and creation self-check.',bytesEstimate:released?0:color.gpuBytes+render.peakBytes+encoder.peakBytes+(grain?grain.workingBytes():0),bytesAreEstimate:true},counts);},
   get textureDirectStats(){return Object.assign({enabled:direct,used:directCounts.baseTiles+directCounts.previewTiles>0,scope:'Direct area inputs; contribution readbacks retained. previewTiles includes optional base-color and final encoded preview contributions.'},directCounts);},
   colorTexture(bytes,mode,w,h){return call(()=>{if(!pipeline)throw Error('纹理流水线未启用');const tile=color.colorTexture(bytes,mode,w,h);counts.residentColorTiles++;return tile;});},
   mixTexture(){const args=arguments;return call(()=>render.mixTexture.apply(render,args));},
   grainTexture(tile,w,h,x,y){return call(()=>{if(!grain)throw Error('共享颗粒 GPU 未准备');return grain.drawTexture(tile,w,h,x,y);});},
   readTexture(tile){return call(()=>{const data=render.readTexture(tile);counts.linearReadbacks++;for(let i=0;i<data.length;i+=4)if(!Number.isFinite(data[i])||!Number.isFinite(data[i+1])||!Number.isFinite(data[i+2])||data[i+3]!==1)throw Error('效果产生非有限颜色');return data;});},
   encodeTexture(tile){return call(()=>encodedOutput(encoder.encodeTexture(tile)));},
   encodeTextureResult(tile,finalTile){return call(()=>{if(!direct)throw Error('面积纹理直传未启用');const result=encoder.encodeTextureResult(tile);result.encoded.assertValidPixels();encodedOutput(result.bytes,finalTile,true);directCounts.encodedTiles++;return result;});},
   color(bytes,mode,w,h){return call(()=>{const data=color.color(bytes,mode,w,h);if(color.path!=='webgl2-color-tile')throw Error(color.fallback||'色彩 GPU 已回退');return data;});},
   pad(data,cw,left,top,x,y,w,h,pad,sw,sh){return call(()=>render.pad(data,cw,data.length/(cw*(data.channels||3)),left,top,x,y,w,h,pad,sw,sh));},
   areaBegin(target,dw,dh,channels,sw,sh){check();if(areas.has(target)||target.length!==dw*dh*channels)throw Error('面积缩算目标无效');areas.set(target,[dw,dh,channels,sw,sh]);},
   areaFinish(target){check();if(!areas.delete(target))throw Error('面积缩算尚未开始');},
   area(data,tw,th,x,y,sw,sh,target,dw,dh,channels,sourceChannels,endpointWeights){return call(()=>render.area(data,tw,th,x,y,sw,sh,target,dw,dh,channels,sourceChannels,undefined,endpointWeights));},
   areaFields(data,tw,th,x,y,sw,sh,field,highlights,dw,dh){return call(()=>render.area(data,tw,th,x,y,sw,sh,field,dw,dh,3,data.channels||3,highlights));},
   areaTexture(desc,tw,th,x,y,sw,sh,target,dw,dh,channels,highlights,endpointWeights){return call(()=>{if(!direct)throw Error('面积纹理直传未启用');render.areaTexture(desc,tw,th,x,y,sw,sh,target,dw,dh,channels,highlights,endpointWeights);if(desc.encoding==='srgb8')directCounts.previewTiles++;else directCounts.linearAreaTiles++;});},
   areaFieldsTexture(desc,tw,th,x,y,sw,sh,field,highlights,dw,dh){return call(()=>{if(!direct||!desc||desc.encoding!=='linear-rec2020-float32')throw Error('基础场纹理数据域无效');render.areaTexture(desc,tw,th,x,y,sw,sh,field,dw,dh,3,highlights);directCounts.baseTiles++;});},
   mix(){const args=arguments;return call(()=>render.mix.apply(render,args));},
   encode(data){return call(()=>{const out=encoder.encode(data);for(let i=3;i<out.length;i+=4)if(out[i]!==255)throw Error('效果产生非有限颜色');return out;});},
   pack(data,width,height,channels,stride,ox,oy,w,h,alpha){check();if(data.channels===4&&ox===0&&oy===0&&w===width&&h===height)return data;const out=new Float32Array(w*h*4),sourceChannels=data.channels||channels,sourceStride=data.channels===4?width*4:stride;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(oy+y)*sourceStride+(ox+x)*sourceChannels,p=(y*w+x)*4;out[p]=data[i];out[p+1]=data[i+1];out[p+2]=data[i+2];out[p+3]=1;}out.channels=4;return out;},
   unpack(data,w,h,target,width,ox,oy,validate){check();for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=(y*w+x)*4,i=((oy+y)*width+ox+x)*3;for(let c=0;c<3;c++){if(validate&&!Number.isFinite(data[p+c]))throw Error('效果产生非有限颜色');target[i+c]=data[p+c];}}},
   acceptRGBA(data){check();return opaque(data);},
   dispose(){if(released)return;released=true;areas.clear();discard();},
   get bytes(){return released?0:color.gpuBytes+render.peakBytes+encoder.peakBytes+(grain?grain.workingBytes():0);},get colorPath(){return color.path;},get encodeGPUBytes(){return released?0:encoder.peakBytes;}
  };
 }
 root.FilmifyPixelOps={create};
})(typeof window!=='undefined'?window:globalThis);
