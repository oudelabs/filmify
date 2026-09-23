// Regressions: native sync/async arithmetic, compositor wave, decoded first
// result frame, and default weak diffusion without adding controls.
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const ctx={performance,setTimeout,document:{hidden:false}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(ROOT,'minitool/yield.js'),'utf8')+'\n'+fs.readFileSync(path.join(ROOT,'minitool/native-film.js'),'utf8')+'\nglobalThis.native=FilmifyNativeFilm;',ctx);
const hash=a=>crypto.createHash('sha256').update(new Uint8Array(a.buffer)).digest('hex');
const nativeFixture=JSON.parse(fs.readFileSync(path.join(__dirname,'native-scheduling-fixture.json'),'utf8'));
const server=http.createServer((req,res)=>{let rel=decodeURIComponent(req.url.split('?')[0]);if(rel.endsWith('/'))rel+='index.html';const f=path.join(ROOT,'dist/xhs-tool',rel);fs.readFile(f,(e,d)=>{if(e){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.html')?'text/html':'application/octet-stream');res.end(d);});});
(async()=>{
 const N=37*29,src=new Float32Array(N);for(let i=0;i<N;i++)src[i]=((i*17)%97)/97;
 for(const entry of nativeFixture.gaussian){const out=new Float32Array(N);ctx.native.gaussian(src,37,29,entry.sigma,new Float32Array(N),out);assert.equal(hash(out),entry.hash,'gaussian arithmetic');}
 const work=()=>[new Float32Array(N),new Float32Array(N),new Float32Array(N)];
 for(const e of nativeFixture.optics){const a=src.slice(),b=src.slice();ctx.native.optics(a,37,29,e.um,e.params,e.ch,work());await ctx.native.opticsAsync(b,37,29,e.um,e.params,e.ch,work());assert.equal(hash(a),e.hash);assert.equal(hash(b),e.hash,'async optical arithmetic');}
 const tmp=new Float32Array(256*256);tmp.gpu={gaussian:()=>123};assert.equal(ctx.native.gaussian(tmp,256,256,1,tmp,tmp),123,'GPU gaussian delegation');
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 try{
  const p=await browser.newPage({viewport:{width:390,height:844}}),cdp=await p.context().newCDPSession(p);let layers=[];cdp.on('LayerTree.layerTreeDidChange',e=>layers=e.layers||[]);await cdp.send('LayerTree.enable');
  await p.goto('http://127.0.0.1:'+server.address().port+'/');
  await p.evaluate(async()=>{
   const c=document.createElement('canvas');c.width=512;c.height=384;const x=c.getContext('2d');x.fillStyle='#bba';x.fillRect(0,0,512,384);x.fillStyle='#fff';x.fillRect(200,120,100,120);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));const dt=new DataTransfer();dt.items.add(new File([blob],'photo.jpg',{type:'image/jpeg'}));const input=document.getElementById('fileInput');input.files=dt.files;input.dispatchEvent(new Event('change'));
   window.firstReady=null;new MutationObserver(()=>{const img=document.querySelector('.result-flow .slide img');if(img&&window.firstReady===null)window.firstReady=!!(img.src&&img.complete&&img.naturalWidth>0);}).observe(document.getElementById('screen'),{subtree:true,childList:true});
   const compare=FilmifyCompare.render;FilmifyCompare.render=async function(){await new Promise(r=>setTimeout(r,350));return compare.apply(this,arguments);};
   const develop=FilmifyEngine.develop;FilmifyEngine.develop=function(a,b,c){window.usedDiffusion=c.diffusion;return develop(a,b,c);};
  });
  await p.waitForFunction(()=>!document.querySelector('[data-action=process]').disabled);await p.click('[data-action=process]');await p.waitForSelector('.proc-waves .w1');
  assert.equal(await p.locator('.proc-waves .w1').evaluate(e=>e.tagName),'DIV');
  const doc=await cdp.send('DOM.getDocument'),node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.proc-waves .w1'}),desc=await cdp.send('DOM.describeNode',{nodeId:node.nodeId});
  await cdp.send('LayerTree.disable');await cdp.send('LayerTree.enable');await p.screenshot();await p.waitForTimeout(150);const layer=layers.find(l=>l.backendNodeId===desc.node.backendNodeId);assert(layer,'wave owns compositing layer');const reasons=await cdp.send('LayerTree.compositingReasons',{layerId:layer.layerId});assert(reasons.compositingReasons.some(r=>/transform/i.test(r)),'compositor transform reason');
  await p.waitForSelector('.result-flow',{timeout:60000});assert.equal(await p.evaluate(()=>window.firstReady),true,'first result image already decoded');assert.equal(await p.evaluate(()=>window.usedDiffusion),.125);assert.equal(await p.locator('[data-action=diffusion],[data-diffusion]').count(),0);
  const bad=await p.locator('.result-flow img').evaluateAll(imgs=>imgs.filter(i=>getComputedStyle(i).visibility!=='hidden'&&(!i.src||!i.complete||!i.naturalWidth)).length);assert.equal(bad,0,'no visible unresolved images');
  console.log('PASS processing/result readiness; wave:',reasons.compositingReasons.join('; '));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
