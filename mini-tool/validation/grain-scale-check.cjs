'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
const ROOT=path.resolve(__dirname,'..'),fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'grain-scale-native-fixture.json')));
const production=fs.readFileSync(path.join(ROOT,'dist/xhs-tool/mobile-film.js'),'utf8');
const probe=production.replace('uniform int hasGrain;','uniform vec3 probeDensity;uniform int hasGrain;').replace('vec3 t0=(d-grainLow)/grainSpan;','d=probeDensity;vec3 t0=(d-grainLow)/grainSpan;').replace('  d+=gd;','  frag=vec4(gd,1.);return;d+=gd;');
assert.notEqual(probe,production);
const server=http.createServer((req,res)=>{const url=decodeURIComponent(req.url.split('?')[0]),f=path.join(ROOT,url);fs.readFile(f,(e,d)=>{res.statusCode=e?404:200;if(url==='/dist/xhs-tool/mobile-film.js')d=Buffer.from(probe);res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':'application/octet-stream');res.end(e?'':d);});});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await require('../scripts/launch-browser.cjs').launchBrowser();try{const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/validation/sample-grid.html');
const rows=await page.evaluate(async fixture=>{
 const records=[],S=256,src=document.createElement('canvas');src.width=src.height=S;src.getContext('2d').fillRect(0,0,S,S);
 FilmifyEngine.init(document.createElement('canvas'),'/dist/xhs-tool/');FilmifyEngine.setImage(src);
 const view=document.createElement('canvas');view.width=view.height=S;const r=new FilmifyMobile.Renderer(view),gl=r.gl;r.scannerUSMEnabled=false;r.glareEnabled=false;r.forceNoDir=true;r.setSource(src);
 const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,S,S,0,gl.RGBA,gl.FLOAT,null);
 const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Float probe FBO');r.outFBO=fb;r.outTex=tex;r.outW=r.outH=S;
 const pixels=new Float32Array(S*S*4);
 try{for(const [stock,scales] of Object.entries(fixture.stocks)){
  const stats=FILMIFY_GRAIN_STATS[stock];if(FilmifyMobile.grainAtScale(stats,8)!==stats)throw Error('8um reference changed');
  let recipe;const original=FilmifyMobile.Renderer.prototype.setStyle;FilmifyMobile.Renderer.prototype.setStyle=function(x){recipe=x;return original.call(this,x);};
  try{await FilmifyEngine.develop(stock,null,{paper:['trix','provia','velvia','ektachrome','kodachrome'].includes(stock)?null:stock==='doublex'?'kodak_2302':'kodak_portra_endura',autoExposure:false,optics:false,grain:false,scatter:false,scannerUSM:false,masterPNG:true});}finally{FilmifyMobile.Renderer.prototype.setStyle=original;}
  const fp=recipe.film;
  for(const sc of scales)for(let bi=0;bi<sc.t.length;bi++){
   const density=[0,1,2].map(c=>{c=Math.min(c,fp.channels-1);return fp.densityMin[c]+sc.t[bi]*(fp.densityMax[c]-fp.densityMin[c]);});
   for(const variant of ['old','new']){
    r.setGrain(variant==='old'?Object.assign({},stats,{physicalScales:null}):stats,sc.um);
    gl.useProgram(r.programs.main);gl.uniform3f(gl.getUniformLocation(r.programs.main,'probeDensity'),...density);r.render(recipe,1,S,S,0,0);gl.bindFramebuffer(gl.FRAMEBUFFER,fb);gl.readPixels(0,0,S,S,gl.RGBA,gl.FLOAT,pixels);if(gl.getError()!==gl.NO_ERROR)throw Error('GL grain probe');
    for(let c=0;c<fp.channels;c++){
     let n=0,sum=0,s2=0,cross=0;for(let y=8;y<S-8;y++)for(let x=8;x<S-8;x++){const i=(y*S+x)*4+c,v=pixels[i];n++;sum+=v;s2+=v*v;cross+=v*pixels[i+4];}
     const mean=sum/n,variance=s2/n-mean*mean,std=Math.sqrt(variance),acf=(cross/n-mean*mean)/variance;
     records.push({stock,um:sc.um,t:sc.t[bi],channel:c,variant,std,native:sc.rms[bi][c],relativeError:std/sc.rms[bi][c]-1,acf,nativeAcf:sc.corr[bi][c]});
    }
   }
  }
 }}finally{r.dispose();FilmifyEngine.release();src.width=src.height=view.width=view.height=1;}
 return records;
},fixture);
const old=rows.filter(r=>r.variant==='old'),now=rows.filter(r=>r.variant==='new'),mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const score=a=>({meanRmsError:mean(a.map(r=>Math.abs(r.relativeError))),maxRmsError:Math.max(...a.map(r=>Math.abs(r.relativeError))),meanAcfError:mean(a.map(r=>Math.abs(r.acf-r.nativeAcf)))}),report={old:score(old),current:score(now),rows};
fs.mkdirSync(path.join(__dirname,'grain-scale'),{recursive:true});fs.writeFileSync(path.join(__dirname,'grain-scale/report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({old:report.old,current:report.current,cases:now.length},null,2));
assert(report.current.meanRmsError<report.old.meanRmsError*.65,'physical-scale RMS error must improve materially');assert(report.current.maxRmsError<.15,'held-out scale/density RMS error <15%');assert(report.current.meanAcfError<=report.old.meanAcfError+.005,'spatial correlation must not regress');
for(const r of now.filter(r=>r.stock==='trix'&&r.um===3))assert(Math.abs(r.relativeError)<.10,'Tri-X small pixels match native amplitude');
console.log('PASS native grain physical scales: held-out um/density, actual float GPU, exact 8um anchor');
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
