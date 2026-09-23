'use strict';
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
// The same browser-side suite also runs over CDP on the attached Android phone.
async function suite(fixture){
 const results={};const canvas=document.createElement('canvas'),r=new FilmifyMobile.Renderer(canvas),gl=r.gl;
 const must=(b,m)=>{if(!b)throw Error(m);};
 const make=(w,h,data)=>{const t=gl.createTexture();gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,w,h,0,gl.RGBA,gl.FLOAT,data);return t;};
 const read=(t,w,h)=>r.readFieldPixels({texture:t,w,h});
 // Detect every active sampler alias, including ones disabled by a uniform.
 const originalDraw=gl.drawArrays.bind(gl);gl.drawArrays=function(){
  if(gl.getParameter(gl.FRAMEBUFFER_BINDING)){
   const target=gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME),program=gl.getParameter(gl.CURRENT_PROGRAM),active=gl.getParameter(gl.ACTIVE_TEXTURE);
   for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++){const u=gl.getActiveUniform(program,i);if(u.type!==gl.SAMPLER_2D)continue;const unit=gl.getUniform(program,gl.getUniformLocation(program,u.name));gl.activeTexture(gl.TEXTURE0+unit);must(gl.getParameter(gl.TEXTURE_BINDING_2D)!==target,'active sampler feedback: '+u.name);}gl.activeTexture(active);
  }return originalDraw(...arguments);
 };
 try{
 results.native=[];
 for(let ch=0;ch<3;ch++){
  const {w,h,um}=fixture,d=new Float32Array(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++)d[(y*w+x)*4+c]=.2+((x*13+y*29)%31)/31;
  const src=make(w,h,d),out=make(w,h,null);try{
   await r.diffuseGPU(src,out,w,h,um,ch,{diffusion:.5});const v=read(out,w,h);must(v,'FFT readback');let max=0;fixture.indices.forEach((i,k)=>max=Math.max(max,Math.abs(v[i*4+ch]-fixture.expected[ch][k])));must(max<2e-6,'pinned native FFT '+max);results.native.push(max);
  }finally{gl.deleteTexture(src);gl.deleteTexture(out);}
 }
 results.planes=[];
 for(const [w,h,kind,um,strength] of [[65,49,'edges',35e3/512,.5],[31,67,'flat',16e3/512,.125],[512,384,'edges',35e3/512,.5],[384,512,'impulse',35e3/512,1],[7,2,'flat',100,.5]]){
  const d=new Float32Array(w*h*4),p=new Float32Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x,v=kind==='flat'?.37:kind==='impulse'?((x===0&&y===0)||(x===w-1&&y===h-1)?2:0):x<w/2?.000001:((x+y)%7?1:3);p[i]=v;d[i*4]=d[i*4+1]=d[i*4+2]=v;}
  const src=make(w,h,d),out=make(w,h,null);try{
   await r.diffuseGPU(src,out,w,h,um,0,{diffusion:strength});const v=read(out,w,h);await FilmifyMobileOptics.diffusePlane(p,w,h,um,0,{diffusion:strength});let max=0,sum=0;for(let i=0;i<p.length;i++){const e=Math.abs(v[i*4]-p[i]);max=Math.max(max,e);sum+=e;}must(max<1e-5,'FFT plane '+kind+' '+w+' '+max);results.planes.push({w,h,kind,max,mae:sum/p.length});
  }finally{gl.deleteTexture(src);gl.deleteTexture(out);}
 }
 // Allocation ledger proves cleanup during cancellation and GL allocation failure.
 const create=gl.createTexture.bind(gl),del=gl.deleteTexture.bind(gl),live=new Set();gl.createTexture=()=>{const t=create();live.add(t);return t;};gl.deleteTexture=t=>{live.delete(t);return del(t);};
 const src=make(48,36,new Float32Array(48*36*4).fill(.2)),out=make(48,36,null);const base=live.size;let draws=0;
 const draw=gl.drawArrays;gl.drawArrays=function(){draws++;return draw.apply(gl,arguments);};
 let cancelled=false;try{await r.diffuseGPU(src,out,48,36,30,0,{diffusion:.5,cancelled:()=>draws>=3});}catch(e){cancelled=e.message==='已取消';}must(cancelled&&live.size===base,'FFT cancellation releases textures');
 const status=gl.checkFramebufferStatus.bind(gl);gl.checkFramebufferStatus=()=>gl.FRAMEBUFFER_UNSUPPORTED;let failed=false;try{await r.diffuseGPU(src,out,48,36,30,0,{diffusion:.5});}catch(e){failed=true;}finally{gl.checkFramebufferStatus=status;}must(failed&&live.size===base,'FFT allocation failure releases textures');gl.deleteTexture(src);gl.deleteTexture(out);results.cleanup=true;
 gl.createTexture=create;gl.deleteTexture=del;
 }finally{r.dispose();canvas.width=canvas.height=1;}
 FilmifyEngine.init(document.createElement('canvas'),'/dist/xhs-tool/');
 const source=document.createElement('canvas');source.width=769;source.height=513;const ctx=source.getContext('2d'),data=ctx.createImageData(769,513);for(let y=0;y<513;y++)for(let x=0;x<769;x++){const i=(y*769+x)*4;data.data[i]=x<385?5:240;data.data[i+1]=(x+y)%37?75:255;data.data[i+2]=y<256?25:215;data.data[i+3]=255;}ctx.putImageData(data,0,0);
 async function pixels(blob){const b=await createImageBitmap(blob),c=document.createElement('canvas');c.width=b.width;c.height=b.height;const x=c.getContext('2d');x.drawImage(b,0,0);b.close();const d=x.getImageData(0,0,c.width,c.height).data;c.width=c.height=1;return d;}
 results.frames=[];
 for(const [stock,halation] of [['gold',true],['velvia',true],['trix',true],['gold',false]]){
  const frames=[],times=[];for(const gpuOptics of [true,false]){FilmifyEngine.setImage(source);const result=await FilmifyEngine.develop(stock,null,{paper:stock==='gold'?'kodak_portra_endura':null,filmFormatMm:stock==='trix'?16:35,diffusion:.5,spatialDir:true,autoExposure:false,masterPNG:true,gpuOptics,optics:halation});frames.push(await pixels(result.blob));times.push(result.timings);must(result.width===769&&result.height===513,'output dimensions');if(gpuOptics)must(result.timings.diffusionGPU,'GPU path must run: '+JSON.stringify(window.FILMIFY_DIAG));}
  let max=0,sum=0,tail=0;for(let i=0;i<frames[0].length;i++)if(i%4!==3){const d=Math.abs(frames[0][i]-frames[1][i]);max=Math.max(max,d);sum+=d;if(d>1)tail++;}const mae=sum/(769*513*3);must(max<=3&&mae<.1&&tail<200,'final pixels '+stock+' '+JSON.stringify({max,mae,tail}));results.frames.push({stock,halation,max,mae,tail,times});
 }
 // Missing float32 rendering must use the intact CPU path, with identical PNG.
 const build=FilmifyMobile.Renderer.prototype.buildOpticsGPU;FilmifyMobile.Renderer.prototype.buildOpticsGPU=async function(){const cap=this.caps.colorBufferFloat;this.caps.colorBufferFloat=false;try{return await build.apply(this,arguments);}finally{this.caps.colorBufferFloat=cap;}};
 source.width=96;source.height=64;ctx.fillStyle='#805c40';ctx.fillRect(0,0,96,64);const fallback=[];
 try{for(const gpuOptics of [true,false]){FilmifyEngine.setImage(source);const out=await FilmifyEngine.develop('gold',null,{paper:'kodak_portra_endura',diffusion:.5,gpuOptics,autoExposure:false,masterPNG:true});must(!out.timings.diffusionGPU,'float32 missing fallback');fallback.push(await pixels(out.blob));}}finally{FilmifyMobile.Renderer.prototype.buildOpticsGPU=build;}
 must(fallback[0].every((v,i)=>v===fallback[1][i]),'fallback output unchanged');results.fallback=true;FilmifyEngine.release();
 // Deliberate silent corruption must fail the bounded runtime self-check.
 const diffuse=FilmifyMobile.Renderer.prototype.diffuseGPU;FilmifyMobile.Renderer.prototype.diffuseGPU=async function(){await diffuse.apply(this,arguments);return 0;};
 try{FilmifyEngine.setImage(source);const out=await FilmifyEngine.develop('gold',null,{paper:'kodak_portra_endura',diffusion:.5,autoExposure:false,masterPNG:true});must(!out.timings.diffusionGPU&&out.timings.gpuOpticsBroken,'corrupted GPU diffusion must fall back');must(window.FILMIFY_DIAG.diffusionCheckError,'failed self-check diagnostic');results.corruptionFallback=true;}
 finally{FilmifyMobile.Renderer.prototype.diffuseGPU=diffuse;FilmifyEngine.release();source.width=source.height=1;}
 return results;
}
module.exports={suite};
if(require.main===module)(async()=>{
 const root=path.resolve(__dirname,'..'),server=http.createServer((req,res)=>{const file=path.join(root,req.url.split('?')[0]);fs.readFile(file,(e,d)=>{res.statusCode=e?404:200;res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(e?'':d);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{browser=await require('../scripts/launch-browser.cjs').launchBrowser();const page=await browser.newPage();page.on('pageerror',e=>console.error(e));await page.goto('http://127.0.0.1:'+server.address().port+'/validation/sample-grid.html');const result=await page.evaluate(suite,JSON.parse(fs.readFileSync(path.join(__dirname,'diffusion-native-fixture.json'),'utf8')));fs.mkdirSync(path.join(__dirname,'gpu-diffusion'),{recursive:true});fs.writeFileSync(path.join(__dirname,'gpu-diffusion/desktop.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));console.log('PASS GPU diffusion: pinned native, boundaries, full FFT dimensions, final frames, cleanup, fallback');}
 finally{if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
