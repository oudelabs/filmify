// Full pipeline vs full-resolution native JS diffusion, including odd dimensions,
// saturated colour boundaries and 12MP-equivalent Tri-X pixel pitch.
// The fixed Python fixture additionally checks pinned upstream FIR/IIR boundaries.
const fs=require('fs'),http=require('http'),path=require('path'),assert=require('assert');const ROOT=process.cwd();
const server=http.createServer((req,res)=>{let file=path.join(ROOT,decodeURIComponent(req.url.split('?')[0]));fs.readFile(file,(e,b)=>{if(e){res.statusCode=404;return res.end();}res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(b);});});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await require('../scripts/launch-browser.cjs').launchBrowser();try{const page=await browser.newPage();page.on('pageerror',e=>console.log('ERROR',e));page.on('console',m=>{if(m.type()==='error')console.log(m.text());});await page.goto('http://127.0.0.1:'+server.address().port+'/validation/sample-grid.html');
const result=await page.evaluate(async()=>{
FilmifyEngine.init(document.createElement('canvas'),'/dist/xhs-tool/');const W=769,H=513,c=document.createElement('canvas');c.width=W;c.height=H;const ctx=c.getContext('2d'),im=ctx.createImageData(W,H);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;im.data[i]=x<384?30:220;im.data[i+1]=y<256?160:45;im.data[i+2]=(x%79<2||y%61<2)?255:95;im.data[i+3]=255;}ctx.putImageData(im,0,0);FilmifyEngine.setImage(c);
const original=FilmifyMobile.Renderer.prototype.render,records={};let pixels,source,core,fp,um,lastRenderer;
const capture=(r,t)=>{const gl=r.gl,fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);const d=new Float32Array(r.sourceW*r.sourceH*4);gl.readPixels(0,0,r.sourceW,r.sourceH,gl.RGBA,gl.FLOAT,d);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fb);return d;};
FilmifyMobile.Renderer.prototype.render=function(st,g,w,h,x,y,only){lastRenderer=this;original.call(this,st,g,w,h,x,y,only);if(!only&&this.spatialDir){fp=st.film;const d=this.spatialDir;um=d.um;const s=capture(this,this.dirBuffers.source.tex),v=capture(this,this.dirBuffers.core.tex);const gl=this.gl,fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,d.tail,0);const tail=new Float32Array(d.w*d.h*4);gl.readPixels(0,0,d.w,d.h,gl.RGBA,gl.FLOAT,tail);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fb);
for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){const k=((h-1-yy+this.sourceCrop.y)*this.sourceW+xx+this.sourceCrop.x)*4,j=((y+yy)*W+x+xx);for(let ch=0;ch<3;ch++){source[ch][j]=s[k+ch];core[ch][j]=v[k+ch];const qx=(x+xx+.5)/d.scale-.5,qy=(y+yy+.5)/d.scale-.5,ix=Math.floor(qx),iy=Math.floor(qy),fx=qx-ix,fy=qy-iy;const at=(a,b)=>tail[(Math.max(0,Math.min(d.h-1,b))*d.w+Math.max(0,Math.min(d.w-1,a)))*4+ch];const tv=(at(ix,iy)*(1-fx)+at(ix+1,iy)*fx)*(1-fy)+(at(ix,iy+1)*(1-fx)+at(ix+1,iy+1)*fx)*fy;pixels[ch][j]=(1-d.tailWeight)*v[k+ch]+d.tailWeight*tv;}}
}};
for(const stock of ['gold','velvia','trix']){
 const paper=stock==='gold'?'kodak_portra_endura':null,opts={paper,autoExposure:false,masterPNG:true,grain:false,optics:false,scatter:false,scannerUSM:false,filmFormatMm:stock==='trix'?3:35};const mk=()=>Array.from({length:3},()=>new Float32Array(W*H));pixels=mk();source=mk();core=mk();const progress=[];
 const out=await FilmifyEngine.develop(stock,p=>progress.push(p),Object.assign({},opts,{spatialDir:true}));
 const references=[];const sums=[];for(let ch=0;ch<3;ch++){const temp=new Float32Array(W*H),v=new Float32Array(W*H),ref=new Float32Array(W*H);FilmifyNativeFilm.gaussian(source[ch],W,H,fp.dir.diffusion_size_um/um,temp,v);ref.set(v);let coreMax=0;for(let i=0;i<ref.length;i++){coreMax=Math.max(coreMax,Math.abs(ref[i]-core[ch][i]));ref[i]*=1-fp.dir.diffusion_tail_weight;}
 for(const [a,r] of [[.1633,.536],[.6496,1.5236],[.187,2.7684]]){FilmifyNativeFilm.gaussian(source[ch],W,H,fp.dir.diffusion_tail_um/um*r,temp,v);for(let i=0;i<ref.length;i++)ref[i]+=a*fp.dir.diffusion_tail_weight*v[i];}
 references.push(ref);let max=0,mae=0;for(let i=0;i<ref.length;i++){const e=Math.abs(ref[i]-pixels[ch][i]);max=Math.max(max,e);mae+=e;}sums.push({max,mae:mae/ref.length,coreMax});}
 const pixelData=async blob=>{const b=await createImageBitmap(blob),v=document.createElement('canvas');v.width=W;v.height=H;const cc=v.getContext('2d');cc.drawImage(b,0,0);b.close();const pix=cc.getImageData(0,0,W,H).data;v.width=v.height=1;return pix;};
 const got=await pixelData(out.blob);
 // Independent full-resolution CPU diffusion fed back into the same scanner.
 const blur=FilmifyMobile.Renderer.prototype.dirBlur;
 const savedRender=FilmifyMobile.Renderer.prototype.render;
 FilmifyMobile.Renderer.prototype.render=function(st,g,w,h,x,y,only){this.testOrigin={x:x-this.sourceCrop.x,y:y-(this.sourceH-this.sourceCrop.y-h)};return original.call(this,st,g,w,h,x,y,only);};
 FilmifyMobile.Renderer.prototype.dirBlur=function(src,dst,w,h,k,axis,row,accum){blur.call(this,src,dst,w,h,k,axis,row,accum);if(this.dirBuffers.core&&dst===this.dirBuffers.core.tex){const v=new Float32Array(w*h*4),o=this.testOrigin;for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){const a=((h-1-yy)*w+xx)*4,i=(o.y+yy)*W+o.x+xx;for(let ch=0;ch<3;ch++)v[a+ch]=references[ch][i];v[a+3]=1;}const gl=this.gl;gl.activeTexture(gl.TEXTURE12);gl.bindTexture(gl.TEXTURE_2D,dst);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,w,h,gl.RGBA,gl.FLOAT,v);this.spatialDir.tailWeight=0;}};
 let native;try{native=await FilmifyEngine.develop(stock,null,Object.assign({},opts,{spatialDir:true}));}finally{FilmifyMobile.Renderer.prototype.dirBlur=blur;FilmifyMobile.Renderer.prototype.render=savedRender;}
 const refPixels=await pixelData(native.blob);let emax=0,esum=0,over2=0;for(let i=0;i<got.length;i++)if(i%4!==3){const e=Math.abs(got[i]-refPixels[i]);emax=Math.max(emax,e);esum+=e;if(e>2)over2++;}
 const blob=await out.blob.arrayBuffer();records[stock]={timings:out.timings,diffs:sums,rgb:{max:emax,mae:esum/(W*H*3),over2:over2/(W*H*3)},progress,bytes:blob.byteLength};
}
FilmifyMobile.Renderer.prototype.render=original;
let stop=false,cancelled=false;try{await FilmifyEngine.develop('gold',p=>{if(p>=6)stop=true;},{paper:'kodak_portra_endura',autoExposure:false,optics:false,grain:false,spatialDir:true,cancelled:()=>stop});}catch(e){cancelled=/已取消/.test(e.message);}
if(!cancelled||lastRenderer.spatialDir||Object.keys(lastRenderer.dirBuffers).length)throw Error('cancelled DIR must release all targets');
const caps=Object.assign({},lastRenderer.caps);lastRenderer.caps.colorBufferFloat=lastRenderer.caps.colorBufferHalfFloat=false;
const fallback=await FilmifyEngine.develop('gold',null,{paper:'kodak_portra_endura',autoExposure:false,optics:false,grain:false,spatialDir:true});lastRenderer.caps=caps;
if(fallback.timings.spatialDir!=='unavailable'||fallback.timings.dirPeakBytes!==0)throw Error('capability fallback must be diagnosed');
return records;
});console.log(JSON.stringify(result,null,2)); for(const r of Object.values(result)){assert.ok(r.rgb.max<=3,'full-resolution oracle maximum');assert.ok(r.rgb.mae<.15,'full-resolution oracle MAE');assert.ok(r.timings.dirPeakBytes<24*1024*1024,'bounded GPU allocation');assert.ok(r.progress.every((p,i,a)=>!i||p>=a[i-1]),'monotonic progress');}const native=await page.evaluate(async fixtures=>{
 const results=[];
 for(const fixture of fixtures.cases){
  for(const half of [false,true]){
   const r=new FilmifyMobile.Renderer(document.createElement('canvas')),gl=r.gl;
   if(half){r.caps.colorBufferFloat=false;r.caps.colorBufferHalfFloat=true;}
   const W=fixture.w,H=fixture.h,style={film:{dir:{active:true,diffusion_size_um:20,diffusion_tail_um:200,diffusion_tail_weight:.03},correctedCurves:[]}};
   r.beginSpatialDir(style,fixture.um,W,H,true);const d=r.spatialDir;
   const src=new Float32Array(W*H*4);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const a=(y*W+x)*4,v=.1+.5*(x>=W/2)+.2*(y>=H/2)+.3*(x%79<2);src[a]=src[a+1]=src[a+2]=v;src[a+3]=1;}
   const upload=(tex,w,h,data)=>{gl.bindTexture(gl.TEXTURE_2D,tex);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,w,h,gl.RGBA,gl.FLOAT,data);};
   const read=(tex,w,h)=>{r.dirAttach(tex,w,h);const out=new Float32Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.FLOAT,out);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return out;};
   const s=r.dirTarget('source',W,H),h=r.dirTarget('horizontal',W,H),c=r.dirTarget('core',W,H);upload(s,W,H,src);
   r.dirBlur(s,h,W,H,d.core,1,0,null);r.dirBlur(h,c,W,H,d.core,0,1,null);const core=read(c,W,H);
   const field=new Float32Array(d.w*d.h*4);for(let y=0;y<d.h;y++)for(let x=0;x<d.w;x++){let sum=0,n=0;for(let yy=y*d.scale;yy<Math.min(H,(y+1)*d.scale);yy++)for(let xx=x*d.scale;xx<Math.min(W,(x+1)*d.scale);xx++){sum+=src[(yy*W+xx)*4];n++;}const i=(y*d.w+x)*4;field[i]=field[i+1]=field[i+2]=sum/n;field[i+3]=1;}
   upload(r.dirBuffers.field.tex,d.w,d.h,field);await r.finishDirField();const tail=read(d.tail,d.w,d.h);
   const at=(x,y)=>tail[(Math.max(0,Math.min(d.h-1,y))*d.w+Math.max(0,Math.min(d.w-1,x)))*4];let max=0,coreMax=0,sum=0;
   fixture.indices.forEach((i,j)=>{const x=i%W,y=Math.floor(i/W),qx=(x+.5)/d.scale-.5,qy=(y+.5)/d.scale-.5,ix=Math.floor(qx),iy=Math.floor(qy),fx=qx-ix,fy=qy-iy;const v=.97*core[i*4]+.03*((at(ix,iy)*(1-fx)+at(ix+1,iy)*fx)*(1-fy)+(at(ix,iy+1)*(1-fx)+at(ix+1,iy+1)*fx)*fy);const e=Math.abs(v-fixture.expected[j]);max=Math.max(max,e);sum+=e;coreMax=Math.max(coreMax,Math.abs(core[i*4]-fixture.core[j]));});
   const error=gl.getError();r.endSpatialDir();const released=Object.keys(r.dirBuffers).length===0&&!r.dirFBO&&!r.dirKernelTex&&!r.spatialDir;r.dispose();results.push({um:fixture.um,half,max,mae:sum/fixture.indices.length,coreMax,error,released});
  }
 }
 return results;
},JSON.parse(fs.readFileSync('validation/spatial-dir-native-fixture.json','utf8')));
console.log('Pinned native fixture',JSON.stringify(native));for(const r of native){assert.equal(r.error,0,'native fixture GL errors');assert.ok(r.released,'DIR resources released');assert.ok(r.max<.005,'native IIR/FIR + bounded-tail tolerance');}
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
