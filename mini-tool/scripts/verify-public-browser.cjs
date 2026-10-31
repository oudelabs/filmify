'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {webkit}=require('playwright');
const ROOT=path.resolve(__dirname,'..'),OUT=path.resolve(process.env.FILMIFY_PUBLIC_OUTPUT||path.join(ROOT,'validation/public-demo'));
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.woff':'font/woff'};
fs.mkdirSync(OUT,{recursive:true});
const report={pass:false,browsers:[],sourcePackage:[]};
function write(){fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n');}
function maxDiff(a,b){assert.equal(a.length,b.length);let rgb=0,alpha=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(i%4===3)alpha=Math.max(alpha,d);else rgb=Math.max(rgb,d);}return {rgb,alpha};}
function digest(data){return crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');}
const server=http.createServer((req,res)=>{
 try{
  const url=decodeURIComponent(req.url.split('?')[0]),match=url.match(/^\/(source|package)(\/.*)?$/);
  if(!match){res.writeHead(404).end();return;}
  const base=fs.realpathSync(path.join(ROOT,match[1]==='source'?'minitool':'dist/xhs-tool')),rel=match[2]||'/',file=fs.realpathSync(path.resolve(base,'.'+(rel==='/'?'/index.html':rel)));
  if(!file.startsWith(base+path.sep)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
 }catch(error){res.writeHead(404).end();}
});

async function numeric(page){return page.evaluate(async()=>{
 const E=FilmifyTextureEngine,checks=[],captures=[],test=(name,ok,detail)=>{checks.push({name,pass:!!ok,detail});if(!ok)throw new Error(name+': '+JSON.stringify(detail));};
 const bytes=canvas=>Array.from(canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height).data);
 const diff=(a,b)=>{let rgb=0,alpha=0;for(let i=0;i<a.length;i++)if(i%4===3)alpha=Math.max(alpha,Math.abs(a[i]-b[i]));else rgb=Math.max(rgb,Math.abs(a[i]-b[i]));return {rgb,alpha};};
 const fixture=document.createElement('canvas');fixture.width=64;fixture.height=48;const ctx=fixture.getContext('2d'),input=ctx.createImageData(64,48);
 for(let y=0;y<48;y++)for(let x=0;x<64;x++){const p=(y*64+x)*4;input.data[p]=(x*31+y*7)%256;input.data[p+1]=(x*13+y*23)%256;input.data[p+2]=(x*3+y*43)%256;input.data[p+3]=255;}ctx.putImageData(input,0,0);
 // Independent eight-corner sum over native PNG nodes, rather than the
 // engine's nested trilinear sampler or color/encode helpers.
 function oracle(nodes){const out=new Uint8ClampedArray(input.data.length);for(let p=0;p<out.length;p+=4){const v=[input.data[p],input.data[p+1],input.data[p+2]].map(x=>x*63/255),base=v.map(x=>Math.min(62,Math.floor(x))),f=v.map((x,i)=>x-base[i]);for(let c=0;c<3;c++){let total=0;for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){const bx=base[0]+x,by=base[1]+y,bz=base[2]+z,j=(((bz>>3)*64+by)*512+(bz%8)*64+bx)*4,w=(x?f[0]:1-f[0])*(y?f[1]:1-f[1])*(z?f[2]:1-f[2]);total+=nodes[j+c]*w;}out[p+c]=Math.round(total);}out[p+3]=255;}return out;}
 for(const item of FilmifyStyles.items){
  const image=new Image();image.src=item.lut;await image.decode();const atlas=document.createElement('canvas');atlas.width=atlas.height=512;const ac=atlas.getContext('2d',{willReadFrequently:true});ac.drawImage(image,0,0);const nodes=ac.getImageData(0,0,512,512).data,expected=oracle(nodes);
  const session=E.createSession(fixture,{seed:291,inputMode:'srgb-unorm8'}),settings={style:item.id,tone:0,color:0,soft:0,halation:0,grain:0,paper:'scan'};
  try{
   const cpu=await session.render(settings,{forceCPU:true,preview:false}),a=bytes(cpu.canvas),d=diff(a,expected);test(item.id+' CPU vs independent PNG-node oracle',d.rgb<=1&&d.alpha===0,d);
   const gpu=await session.render(settings,{preview:false}),b=bytes(gpu.canvas),gd=diff(a,b);test(item.id+' GPU vs CPU',gd.rgb<=1&&gd.alpha===0&&gpu.stats.pixelOps==='webgl2-pixels',{diff:gd,path:gpu.stats.path,pixelOps:gpu.stats.pixelOps});
   captures.push({key:item.id+':cpu',gpu:false,pixels:a},{key:item.id+':gpu',gpu:true,pixels:b});
   if(item.blackAndWhite){let delta=0;for(let i=0;i<b.length;i+=4)delta=Math.max(delta,Math.abs(b[i]-b[i+1]),Math.abs(b[i]-b[i+2]));test('monochrome demo remains neutral',delta===0,delta);}
  }finally{session.release();atlas.width=atlas.height=1;image.src='';}
 }
 for(const paper of ['demo-paper-warm','demo-paper-cool','graded-print']){
  const session=E.createSession(fixture,{seed:911,inputMode:'srgb-unorm8'}),settings={style:'demo-warm',tone:0,color:0,grain:0,soft:0,halation:0,paper:paper};
  try{const cpu=await session.render(settings,{forceCPU:true,preview:false}),a=bytes(cpu.canvas),gpu=await session.render(settings,{preview:false}),b=bytes(gpu.canvas),d=diff(a,b);test(paper+' CPU/GPU color interface',d.rgb<=1&&d.alpha===0,d);captures.push({key:paper+':cpu',gpu:false,pixels:a},{key:paper+':gpu',gpu:true,pixels:b});}finally{session.release();}
 }
 for(const style of ['demo-identity','demo-mono']){
  const session=E.createSession(fixture,{seed:417,inputMode:'srgb-unorm8'}),settings={style:style,tone:0,color:0,grain:1,soft:1,halation:style==='demo-mono'?0:1,softStrength:.25,softFamily:'black_pro_mist',softNeutral:style==='demo-mono',paper:'scan'};
  try{const cpu=await session.render(settings,{forceCPU:true,preview:false,includePreview:true}),a=bytes(cpu.canvas),gpu=await session.render(settings,{preview:false,includePreview:true}),b=bytes(gpu.canvas),d=diff(a,b);test(style+' complete texture CPU/GPU',d.rgb<=1&&d.alpha===0,{diff:d,stats:gpu.stats});captures.push({key:style+':texture-cpu',gpu:false,pixels:a},{key:style+':texture-gpu',gpu:true,pixels:b});
   const first=await session.render(settings),cached=await session.render(settings);test(style+' complete preview cache hit',cached.stats.cacheHit===true&&cached.canvas===first.canvas,cached.stats);
  }finally{session.release();test(style+' session release clears owned caches',session.getStats().released&&session.getStats().cacheBytes===0,session.getStats());}
 }
 const canceled=E.createSession(fixture,{seed:42});let rejected=false;try{await canceled.render({style:'demo-identity',grain:1,soft:1},{cancelled:()=>true});}catch(error){rejected=/取消|cancel/.test(error.message);}test('already-cancelled render rejects',rejected);canceled.release();rejected=false;try{await canceled.render({});}catch(error){rejected=/释放/.test(error.message);}test('released session refuses rendering',rejected);
 const original=HTMLCanvasElement.prototype.getContext;let fallback;
 try{HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:original.call(this,type,...args);};const session=E.createSession(fixture,{seed:11,inputMode:'srgb-unorm8'});try{fallback=await session.render({style:'demo-identity',grain:1,soft:1,halation:1},{preview:false});test('unavailable WebGL2 completes through CPU',fallback.width===64&&fallback.height===48&&fallback.stats.path==='cpu',fallback.stats);}finally{session.release();}}finally{HTMLCanvasElement.prototype.getContext=original;}
 FilmifyGrain.release();fixture.width=fixture.height=1;return {checks,captures};
});}

async function ui(page,name,edition,url){
 await page.goto(url,{waitUntil:'load'});await page.waitForSelector('.negative-home');
 assert.equal(await page.locator('[data-action="apply"]').isDisabled(),true);
 const synthetic=Buffer.from(await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=128;c.height=96;const x=c.getContext('2d'),g=x.createLinearGradient(0,0,128,96);g.addColorStop(0,'#173451');g.addColorStop(.6,'#d3a76d');g.addColorStop(1,'#eeeecc');x.fillStyle=g;x.fillRect(0,0,128,96);x.fillStyle='#fff';x.fillRect(74,30,3,3);return Array.from(new Uint8Array(await(await new Promise(r=>c.toBlob(r,'image/png'))).arrayBuffer()));}));
 await page.locator('#fileInput').setInputFiles([{name:'synthetic-a.png',mimeType:'image/png',buffer:synthetic},{name:'synthetic-b.png',mimeType:'image/png',buffer:synthetic}]);
 await page.waitForFunction(()=>!document.querySelector('[data-action="apply"]').disabled&&!document.querySelector('.negative-image').hidden&&document.querySelector('.negative-image').complete);
 assert.equal(await page.locator('.fx-count').textContent(),'2/2');
 const initial=await page.locator('.negative-summary-film').textContent();
 for(const [w,h] of [[320,640],[390,844],[844,390]]){await page.setViewportSize({width:w,height:h});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert(await page.evaluate(()=>{const b=document.querySelector('[data-action="apply"]').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&b.top>=0&&b.bottom<=innerHeight+.5;}));await page.screenshot({path:path.join(OUT,name+'-'+edition+'-home-'+w+'.png')});}
 await page.setViewportSize({width:390,height:844});await page.locator('[data-action="recipe"]').click();assert.equal(await page.locator('[data-style]').count(),6);await page.locator('[data-style="demo-mono"]').click();assert.equal(await page.locator('[data-print="graded-print"]').count(),1);await page.locator('[data-action="cancel-recipe"]').click();assert.equal(await page.locator('.negative-summary-film').textContent(),initial);
 await page.locator('[data-action="recipe"]').click();await page.locator('[data-style="demo-warm"]').click();await page.locator('[data-filter="none"]').click();await page.locator('[data-print="demo-paper-warm"]').click();await page.screenshot({path:path.join(OUT,name+'-'+edition+'-recipe.png')});await page.locator('[data-action="confirm-recipe"]').click();assert.equal(await page.locator('.negative-summary-film').textContent(),'暖色演示');
 await page.locator('[data-action="apply"]').click();await page.locator('[data-action="cancel"]').click();await page.waitForSelector('.negative-home');await page.locator('[data-action="apply"]').click();await page.waitForSelector('.result-flow',{timeout:60000});await page.waitForFunction(()=>document.querySelector('.slide img')&&document.querySelector('.slide img').complete);await page.screenshot({path:path.join(OUT,name+'-'+edition+'-result.png')});
 await page.locator('[data-action="share"]').click();
 for(const style of ['effect','frame','hanging','compare']){await page.locator('[data-share-style="'+style+'"]').click();await page.waitForFunction(()=>{const b=document.querySelector('[data-action="save-share"]');return b&&!b.disabled&&!document.querySelector('.share-status');},{},{timeout:60000});assert.equal(await page.locator('[data-share-style="'+style+'"]').getAttribute('aria-pressed'),'true');if(style==='frame')await page.screenshot({path:path.join(OUT,name+'-'+edition+'-share.png')});}
 await page.locator('[data-action="share-back"]').click();await page.locator('[data-action="back"]').click();await page.waitForSelector('.negative-home');assert.equal(await page.locator('.negative-summary-film').textContent(),'暖色演示');
 await page.locator('[data-action="apply"]').click();await page.waitForSelector('.result-flow',{timeout:10000});
 return {syntheticImportCount:2,draftCancel:true,recipeCommit:true,processingCancelRetry:true,allFourShareTemplates:true,resultReuse:true,viewportWidths:[320,390,844]};
}

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
  for(const name of ['chromium','webkit']){
   const browser=name==='chromium'?await require('./launch-browser.cjs').launchBrowser():await webkit.launch({headless:true});
   try{
    const row={name,editions:[]};report.browsers.push(row);const snapshots={};
    for(const edition of ['source','package']){
     const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],missing=[],external=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)missing.push(r.url());});
     await page.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin+'/')||url.startsWith('blob:')||url.startsWith('data:'))route.continue();else{external.push(url);route.abort();}});
     await page.goto(origin+'/'+edition+'/',{waitUntil:'load'});const result=await numeric(page);snapshots[edition]=result.captures;
     const interaction=await ui(page,name,edition,origin+'/'+edition+'/');assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);assert.deepEqual(external,[]);
     row.editions.push({edition,checks:result.checks,interaction,errors,missing,external,captures:result.captures.map(c=>({key:c.key,sha256:digest(c.pixels)}))});write();await page.close();
    }
    assert.equal(snapshots.source.length,snapshots.package.length);
    for(let i=0;i<snapshots.source.length;i++){const a=snapshots.source[i],b=snapshots.package[i];assert.equal(a.key,b.key);const d=maxDiff(a.pixels,b.pixels);assert.ok(d.rgb<=(a.gpu?1:0)&&d.alpha===0,a.key+': '+JSON.stringify(d));report.sourcePackage.push({browser:name,key:a.key,...d});}
   }finally{await browser.close();}
  }
  report.pass=true;write();console.log('PASS public browsers: '+report.browsers.length+' engines, '+report.sourcePackage.length+' source/package image pairs');
 }finally{write();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
