// Scanner domain/axes/tile seams, real GPU grain node lookup, packed fallback,
// and the pinned native CineBloom convolution. Run after npm run build.
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');let mode='normal';
const source=fs.readFileSync(path.join(ROOT,'dist/xhs-tool/mobile-film.js'),'utf8');
const server=http.createServer((req,res)=>{
 const url=decodeURIComponent(req.url.split('?')[0]),file=path.join(ROOT,url);
 fs.readFile(file,(err,data)=>{if(err){res.statusCode=404;res.end();return;}
  if(url==='/dist/xhs-tool/mobile-film.js'){
   let s=source;
   if(mode==='packed')s=s.replace('this.scanPacked=!(this.caps.colorBufferFloat||this.caps.colorBufferHalfFloat);','this.scanPacked=true;');
   if(mode==='grain')s=s.replace('uniform vec3 grainLow;', 'uniform vec3 probeLow;uniform vec3 probeSpan;uniform vec3 grainLow;')
    .replace('vec3 t0=(d-grainLow)/grainSpan;', 'float tt=gl_FragCoord.x<1.?-.2:(gl_FragCoord.x>10.?1.2:(gl_FragCoord.x-1.)/9.);d=probeLow+probeSpan*tt;vec3 t0=(d-grainLow)/grainSpan;')
    .replace('  vec3 gd;','  frag=vec4((vec3(i0)+ff)/8.,1.);return;vec3 gd;');
   data=Buffer.from(s);
  }
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(data);
 });
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await require('../scripts/launch-browser.cjs').launchBrowser();try{
 const results={};
 for(const variant of ['normal','packed']){
  mode=variant;const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/validation/sample-grid.html');
  results[variant]=await page.evaluate(async()=>{
   const c=document.createElement('canvas'),ctx=c.getContext('2d');c.width=c.height=128;
   FilmifyEngine.init(document.createElement('canvas'),'/dist/xhs-tool/');await FilmifyEngine.loadColors('gold','kodak_portra_endura');FILMIFY_STYLES.gold.glare={percent:0};
   async function render(usm){FilmifyEngine.setImage(c);const r=await FilmifyEngine.develop('gold',null,{paper:'kodak_portra_endura',autoExposure:false,masterPNG:true,grain:false,optics:false,scatter:false,scannerUSM:usm});const b=await createImageBitmap(r.blob),o=document.createElement('canvas');o.width=b.width;o.height=b.height;const x=o.getContext('2d');x.drawImage(b,0,0);b.close();const data=x.getImageData(0,0,o.width,o.height).data;o.width=o.height=1;return data;}
   const dec=v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4),enc=v=>v<=.0031308?v*12.92:1.055*Math.pow(v,1/2.4)-.055;
   const k=[Math.exp(-2/.49),Math.exp(-.5/.49),1,Math.exp(-.5/.49),Math.exp(-2/.49)],sum=k.reduce((a,b)=>a+b);k.forEach((v,i)=>k[i]=v/sum);
   const axes={};for(const axis of ['x','y']){
    ctx.fillStyle='#464646';ctx.fillRect(0,0,128,128);ctx.fillStyle='#b4b4b4';ctx.fillRect(axis==='x'?64:0,axis==='y'?64:0,axis==='x'?64:128,axis==='y'?64:128);
    const off=await render(false),on=await render(true);let err=0,max=0,n=0,amount=0;
    for(let y=4;y<124;y++)for(let x=4;x<124;x++){if(Math.abs((axis==='x'?x:y)-64)>3)continue;for(let ch=0;ch<3;ch++){
     const i=(y*128+x)*4+ch,center=dec(off[i]/255);let blur=0;
     for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)blur+=dec(off[((y+dy)*128+x+dx)*4+ch]/255)*k[dy+2]*k[dx+2];
     const ref=Math.max(0,Math.min(255,enc(Math.max(0,center+.7*(center-blur)))*255)),d=Math.abs(on[i]-ref);err+=d;max=Math.max(max,d);amount+=Math.abs(on[i]-off[i]);n++;
    }}axes[axis]={mae:err/n,max,amount:amount/n};
   }
   c.width=128;c.height=1024;ctx.fillStyle='#464646';ctx.fillRect(0,0,128,1024);ctx.fillStyle='#b4b4b4';ctx.fillRect(0,384,128,256);ctx.fillRect(0,896,128,128);
   const pixels=await render(true);let seam=0;for(let dy=-2;dy<=2;dy++)for(let x=4;x<124;x++)for(let ch=0;ch<3;ch++)seam=Math.max(seam,Math.abs(pixels[((384+dy)*128+x)*4+ch]-pixels[((896+dy)*128+x)*4+ch]));
   const p=new Float32Array(48*36).fill(.37);await FilmifyMobileOptics.diffusePlane(p,48,36,35e3/1200,0,{diffusion:1});let flat=0;for(const v of p)flat=Math.max(flat,Math.abs(v-.37));
   let cancelled=false;try{await FilmifyMobileOptics.diffusePlane(p,48,36,30,0,{diffusion:.5,cancelled:()=>true});}catch(e){cancelled=e.message==='已取消';}
   return {axes,seam,flat,cancelled};
  });await page.close();
  const r=results[variant];for(const a of Object.values(r.axes)){assert(a.mae<1.1,variant+' linear USM mean');assert(a.max<5,variant+' linear USM max');assert(a.amount>4,variant+' active on both axes');}
  assert(Math.abs(r.axes.x.amount-r.axes.y.amount)<.15,'USM rotation symmetry');assert(r.seam<=1,'tile seams');assert(r.flat<1e-6,'diffusion flat conservation');assert(r.cancelled,'diffusion cancellation');
 }
 mode='normal';const scatterPage=await browser.newPage();await scatterPage.goto('http://127.0.0.1:'+server.address().port+'/validation/sample-grid.html');
 results.scatter=await scatterPage.evaluate(async()=>{
  FilmifyEngine.init(document.createElement('canvas'),'/dist/xhs-tool/');
  const source=document.createElement('canvas'),view=document.createElement('canvas');source.width=view.width=192;source.height=view.height=144;
  const ctx=source.getContext('2d'),data=ctx.createImageData(192,144);
  for(let y=0;y<144;y++)for(let x=0;x<192;x++){const i=(y*192+x)*4;data.data[i]=(x*29+y*7)%256;data.data[i+1]=x<96?30:220;data.data[i+2]=(x+y)%13?80:255;data.data[i+3]=255;}ctx.putImageData(data,0,0);
  const renderer=new FilmifyMobile.Renderer(view);renderer.setSource(source);renderer.scannerUSMEnabled=false;renderer.glareEnabled=false;
  const gl=renderer.gl,rows=[];
  // ANGLE/Metal may permit an unused sampler alias; Adreno rejects it even
  // when useAccum=0. Enforce the stricter driver rule for every scatter pass.
  const draw=gl.drawArrays.bind(gl);gl.drawArrays=function(){
   if(gl.getParameter(gl.CURRENT_PROGRAM)===renderer.programs.scatBlur){
    const target=gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME),active=gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE3);const accum=gl.getParameter(gl.TEXTURE_BINDING_2D);gl.activeTexture(active);
    if(target===accum)throw new Error('scatter sampler aliases its framebuffer');
   }return draw(...arguments);
  };

  try{for(const stock of ['gold','portrait','velvia','trix']){
   await FilmifyEngine.loadColors(stock,stock==='gold'||stock==='portrait'?'kodak_portra_endura':null);
   // Capture the real engine recipe, including its shared paper/scan mapping.
   let style;const original=FilmifyMobile.Renderer.prototype.setStyle;
   FilmifyMobile.Renderer.prototype.setStyle=function(recipe){style=recipe;return original.call(this,recipe);};
   try{FilmifyEngine.setImage(source);await FilmifyEngine.develop(stock,null,{paper:stock==='gold'||stock==='portrait'?'kodak_portra_endura':null,autoExposure:false,optics:false,grain:false,scatter:false,scannerUSM:false});}
   finally{FilmifyMobile.Renderer.prototype.setStyle=original;}
   const kernel=FilmifyMobile.scatterKernels(style,(stock==='trix'?16:35)*1000/4096);
   if(!kernel)throw new Error('scatter fixture must have an active kernel: '+stock+' '+JSON.stringify(style.film.halation));
   let conservation=0;const width=kernel.radius*2+1;
   for(let ch=0;ch<3;ch++){let energy=kernel.center[ch];for(let t=0;t<kernel.terms;t++){let a=0,b=0;for(let k=0;k<width;k++){a+=kernel.weights[((2*t)*width+k)*3+ch];b+=kernel.weights[((2*t+1)*width+k)*3+ch];}energy+=a*b;}
    // Upstream exponential-mixture coefficients sum to .9999, not 1. Match
    // its intended energy (including truncation), without normalising it away.
    const hal=style.film.halation,ci=Math.min(ch,style.film.channels-1);
    const expected=1-hal.scatter_amount*hal.scatter_tail_weight[ci]*(1-(.1633+.6496+.1870));
    conservation=Math.max(conservation,Math.abs(energy-expected));
   }
   const frames=[];
   for(const half of [false,true,false]){
    // Reuse one renderer to also test target reallocation on precision changes.
    renderer.caps.colorBufferFloat=!half;renderer.caps.colorBufferHalfFloat=half;
    renderer.setScatter(kernel);renderer.render(style,1,192,144,0,0);renderer.render(style,1,192,144,0,0);
    const pixels=new Uint8Array(192*144*4);gl.readPixels(0,0,192,144,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    if(gl.getError()!==gl.NO_ERROR)throw new Error('scatter framebuffer path failed');
    frames.push(pixels);
   }
   let max=0,sum=0,roundTrip=0;for(let i=0;i<frames[0].length;i++)if(i%4!==3){const d=Math.abs(frames[0][i]-frames[1][i]);max=Math.max(max,d);sum+=d;roundTrip=Math.max(roundTrip,Math.abs(frames[0][i]-frames[2][i]));}
   renderer.caps.colorBufferFloat=false;renderer.caps.colorBufferHalfFloat=false;renderer.setScatter(kernel);
   rows.push({stock,max,mae:sum/(192*144*3),roundTrip,conservation,terms:kernel.terms,unsupported:renderer.scatterMode==='unavailable'&&renderer.scatter===null});
  }}finally{renderer.dispose();source.width=source.height=view.width=view.height=1;}
  return rows;
 });await scatterPage.close();
 for(const r of results.scatter){assert(r.max<=3&&r.mae<.15,'half-float scatter precision '+r.stock);assert(r.roundTrip===0,'scatter target format invalidation');assert(r.conservation<1e-6,'scatter energy conservation');if(r.stock==='trix')assert(r.terms===4,'resolved Tri-X core must be rendered');assert(r.unsupported,'missing float capability must be diagnosed');}
 mode='grain';const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/validation/sample-grid.html');
 results.grain=await page.evaluate(async()=>{
  FilmifyEngine.init(document.createElement('canvas'),'/dist/xhs-tool/');await FilmifyEngine.loadColors('trix');
  const st=FILMIFY_STYLES.trix,fp=st.film,c=document.createElement('canvas');c.width=11;c.height=2;const r=new FilmifyMobile.Renderer(c);
  const src=document.createElement('canvas');src.width=11;src.height=2;src.getContext('2d').fillRect(0,0,11,2);r.setSource(src);r.setGrain(FILMIFY_GRAIN_STATS.trix,8);r.scannerUSMEnabled=false;r.glareEnabled=false;
  const gl=r.gl,p=r.programs.main;gl.useProgram(p);gl.uniform3f(gl.getUniformLocation(p,'probeLow'),fp.densityMin[0],fp.densityMin[0],fp.densityMin[0]);const span=fp.densityMax[0]-fp.densityMin[0];gl.uniform3f(gl.getUniformLocation(p,'probeSpan'),span,span,span);
  r.render(st,1,11,2,0,0);const out=new Uint8Array(11*2*4);gl.readPixels(0,0,11,2,gl.RGBA,gl.UNSIGNED_BYTE,out);r.dispose();return Array.from(out).filter((_,i)=>i<44&&i%4===0);
 });await page.close();
 results.grain.forEach((v,i)=>assert(Math.abs(v-Math.max(0,Math.min(8,i-1))*255/8)<=1,'GPU grain node '+i+' got '+v));
 // Fixed output from spektrafilm 6cd00c8 apply_diffusion_filter_um, not a JS oracle.
 mode='normal';const fp=await browser.newPage();await fp.goto('http://127.0.0.1:'+server.address().port+'/validation/sample-grid.html');
 const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'diffusion-native-fixture.json'),'utf8'));
 results.native=await fp.evaluate(async f=>{const out=[];for(let ch=0;ch<3;ch++){const p=new Float32Array(f.w*f.h);for(let y=0;y<f.h;y++)for(let x=0;x<f.w;x++)p[y*f.w+x]=.2+((x*13+y*29)%31)/31;await FilmifyMobileOptics.diffusePlane(p,f.w,f.h,f.um,ch,{diffusion:.5});out.push(f.indices.map(i=>p[i]));}return out;},fixture);await fp.close();
 let max=0;results.native.forEach((row,c)=>row.forEach((v,i)=>max=Math.max(max,Math.abs(v-fixture.expected[c][i]))));assert(max<1e-6,'CineBloom native fixture');results.native={max};
 console.log(JSON.stringify(results,null,2));console.log('PASS pipeline fidelity: linear 2-D scanner, padded seams, packed fallback, grain endpoints, native diffusion, cancellation');
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
