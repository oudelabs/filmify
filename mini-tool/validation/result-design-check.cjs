// Result design: shared export geometry, stable random layout, branding and real drag tracking.
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),DIST=path.resolve(process.env.FILMIFY_TEST_ROOT||path.join(ROOT,'dist/xhs-tool'));
const OUT=path.join(__dirname,'result-design');fs.mkdirSync(OUT,{recursive:true});
const server=http.createServer((req,res)=>{let rel=decodeURIComponent(req.url.split('?')[0]);if(rel.endsWith('/'))rel+='index.html';const f=path.join(DIST,rel);if(!f.startsWith(DIST+path.sep)){res.writeHead(404);res.end();return;}fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.woff':'font/woff'})[path.extname(f)]||'application/octet-stream');res.end(d);});});
async function inject(p,n,w=600,h=800){
 await p.evaluate(async({n,w,h})=>{
  const dt=new DataTransfer();
  for(let i=0;i<n;i++){const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d'),gr=g.createLinearGradient(0,0,w,h);gr.addColorStop(0,'hsl('+i*35+',40%,65%)');gr.addColorStop(1,'#455968');g.fillStyle=gr;g.fillRect(0,0,w,h);g.fillStyle='#ede8da';g.fillRect(w*.3,h*.2,w*.3,h*.5);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));c.width=c.height=1;dt.items.add(new File([blob],'photo-'+i+'.jpg',{type:'image/jpeg'}));}
  const input=document.getElementById('fileInput');input.files=dt.files;input.dispatchEvent(new Event('change'));
 },{n,w,h});
 await p.waitForFunction(()=>document.querySelector('[data-action=process]')&&!document.querySelector('[data-action=process]').disabled,{},{timeout:30000});
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 const errors=[];
 try{
  const p=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:3});p.on('pageerror',e=>errors.push(e.message));
  const url='http://127.0.0.1:'+server.address().port+'/';await p.goto(url);
  const report=await p.evaluate(async()=>{
   const D=FilmifyPrintDesign;await D.ready();const check=(v,m)=>{if(!v)throw Error(m);};
   check(document.fonts.check('600 26px "Filmify Caption"'),'caption font ready');
   const img=(w,h,color)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,w,h);return c;};
   const decode=async blob=>{const u=URL.createObjectURL(blob),im=new Image();im.src=u;await im.decode();URL.revokeObjectURL(u);return im;};
   const portrait=D.matLayout(600,800,false),landscape=D.matLayout(800,600,false);
   check(portrait.W===1200&&portrait.H===1600,'portrait outer ratio');check(landscape.H===1078&&landscape.y===116,'landscape breathing room');
   for(const dims of [[600,800],[800,600],[900,1600],[200,1800],[1800,200]]){const L=D.matLayout(...dims,true);check(L.W%16===0&&L.H%16===0&&L.W*L.H/256<=8192&&L.H<=1600,'AVC macroblocks');check(Math.abs(L.cw/L.ch-dims[0]/dims[1])<.0001,'photo aspect retained');}
   let layouts=0;
   for(let n=2;n<=9;n++)for(let seed=0;seed<50;seed++){
    const a=D.scatter(n,seed);check(JSON.stringify(a)===JSON.stringify(D.scatter(n,seed)),'stable random arrangement');check(new Set(a.cells.map(c=>c.index)).size===n,'each photo once');
    for(let i=0;i<n;i++){const c=a.cells[i];check(c.w===200&&c.h===200&&c.x>=60&&c.x+c.w<=1140&&c.y>=100&&c.y+c.h<1450,'safe collage bounds');for(let j=0;j<i;j++){const b=a.cells[j];check(Math.abs(b.x-c.x)>=227||Math.abs(b.y-c.y)>=227,'collage spacing');}}layouts++;
   }
   check(JSON.stringify(D.scatter(9,1))!==JSON.stringify(D.scatter(9,2)),'new seed rearranges');
   // Alpha and orange area are pixel-identical to the original PNG.
   const original=new Image();original.src='./assets/logo-mark-t-dark.png';await original.decode();const logo=new Image();logo.src=D.logoURL();await logo.decode();
   const c=img(454,176,'#000'),g=c.getContext('2d');g.clearRect(0,0,454,176);g.drawImage(original,0,0);const a=g.getImageData(0,0,454,176).data;g.clearRect(0,0,454,176);g.drawImage(logo,0,0);const b=g.getImageData(0,0,454,176).data;
   let alphaDiff=0,orangeDiff=0;const gray=[];for(let i=0;i<a.length;i+=4){const x=i/4%454,y=Math.floor(i/4/454);if(a[i+3]!==b[i+3])alphaDiff++;if(x>=278||y>=130)for(let k=0;k<4;k++)if(a[i+k]!==b[i+k])orangeDiff++;if(x<278&&y<130&&b[i+3]>250&&b[i]>100)gray.push(b[i]);}
   gray.sort((a,b)=>a-b);check(!alphaDiff&&!orangeDiff,'original alpha/orange preserved');check(gray[Math.floor(gray.length/2)]>=180&&gray[Math.floor(gray.length/2)]<=189,'fixed neutral gray');c.width=c.height=1;
   const neg=img(600,800,'#503d30'),eff=img(600,800,'#8098a8');
   const feet=[];
   for(const theme of ['white','black']){
    const opts={film:'SUPERIA X-TRA 400',paper:'ENDURA PREMIER',theme},L=D.matLayout(600,800,true),canvas=img(L.W,L.H,'#000'),ctx=canvas.getContext('2d');
    // Ink bounds must center inside the bottom mat, excluding the outer frame.
    for(const live of [false,true]){D.matBase(ctx,L,theme==='black');D.matFooter(ctx,L,opts,live);const y0=Math.ceil(L.y+L.ch),data=ctx.getImageData(0,y0,live?970:L.W,L.H-y0-16).data,bg=theme==='black'?28:243;let min=Infinity,max=-Infinity;for(let i=0;i<data.length;i+=4){const x=i/4%(live?970:L.W);if(x<30||x>L.W-30)continue;if(Math.abs(data[i]-bg)>25){const y=Math.floor(i/4/(live?970:L.W))+y0;min=Math.min(min,y);max=Math.max(max,y);}}const center=(L.y+L.ch+L.H-(theme==='white'?15:0))/2;check(Math.abs((min+max)/2-center)<=1.5,'mat ink center '+theme+' '+live);feet.push({theme,live,center,inkCenter:(min+max)/2});}
    if(theme==='black')check(ctx.getImageData(40,40,20,20).data.every((v,i)=>v===(i%4===3?255:28)),'single black mat remains plain');
    const paint=FilmifyLiveWipe.painter(neg,eff,opts,L.W,L.H);let footer;
    for(const t of [0,1.8,4]){paint(ctx,t);const bytes=ctx.getImageData(0,Math.ceil(L.y+L.ch),L.W,L.H-Math.ceil(L.y+L.ch)).data;if(footer)check(bytes.every((v,i)=>v===footer[i]),'live footer stationary');footer=bytes;}
    const jpg=await decode(await D.compose(eff,opts,true));const match=img(L.W,L.H,'#000'),mg=match.getContext('2d');mg.drawImage(jpg,0,0);const raw=ctx.getImageData(0,0,L.W,L.H).data,decoded=mg.getImageData(0,0,L.W,L.H).data;let delta=0;for(let i=0;i<raw.length;i+=4)delta+=Math.abs(raw[i]-decoded[i]);check(delta/(L.W*L.H)<2,'cover matches final live frame delta='+delta/(L.W*L.H));jpg.src='';match.width=match.height=canvas.width=canvas.height=1;
   }
   // Negative, final and live collage share the seeded placement.
   const imgs=Array.from({length:9},(_,i)=>img(50+i*3,80,'hsl('+i*35+',50%,60%)'));
   const negatives=imgs.map(c=>img(c.width,c.height,'#ec3010'));
   const grainCanvas=img(1200,1600,'#000'),grainCtx=grainCanvas.getContext('2d'),paintCollage=FilmifyCollageGrid.painter(negatives,imgs,'PORTRA 400 · ENDURA',123);
   let paper;
   for(const t of [0,1.8,4]){
    paintCollage(grainCtx,t);const bytes=grainCtx.getImageData(0,0,256,64).data;
    if(paper)check(bytes.every((v,i)=>v===paper[i]),'collage paper stationary through development');
    paper=bytes;
   }
   const tones=new Set();for(let i=0;i<paper.length;i+=4){check(paper[i]===paper[i+1]&&paper[i]===paper[i+2]&&paper[i+3]===255,'paper neutral and opaque');tones.add(paper[i]);}
   check(tones.size===7&&Math.min(...tones)===25&&Math.max(...tones)===31,'approved B grain amplitude');
   grainCanvas.width=grainCanvas.height=1;
   const jpg=await decode(await FilmifyCollageGrid.composeStatic(imgs,'PORTRA 400 · ENDURA',123));const canvas=img(1200,1600,'#000'),ctx=canvas.getContext('2d');
   let raw;
   for(const t of [2.8,3.2,3.6,4,4.8]){paintCollage(ctx,t);const frame=ctx.getImageData(0,0,1200,1600).data;if(raw)check(frame.every((v,i)=>v===raw[i]),'collage completed frame stays fixed at '+t);raw=frame;}
   ctx.drawImage(jpg,0,0);const decoded=ctx.getImageData(0,0,1200,1600).data;let delta=0;for(let i=0;i<raw.length;i+=4)delta+=Math.abs(raw[i]-decoded[i]);check(delta/(1200*1600)<2,'collage live equals still');imgs.concat(negatives).forEach(c=>c.width=c.height=1);canvas.width=canvas.height=1;jpg.src='';
   const compare=await decode(await FilmifyCompare.render(neg,eff,{film:'SUPERIA X-TRA 400',paper:'CRYSTAL II'}));check(compare.naturalWidth===1200&&compare.naturalHeight===824,'portrait compare geometry');compare.src='';neg.width=neg.height=eff.width=eff.height=1;
   return {layouts,feet,logoGray:gray[Math.floor(gray.length/2)],alphaDiff,orangeDiff};
  });
  // Exercise actual import/process/result DOM and pointer handlers. The engine is
  // copied through here; optical rendering is covered by the separate real-engine gates.
  await p.evaluate(()=>{
   let source;FilmifyEngine.setImage=im=>{source=im;};FilmifyEngine.develop=async(style,progress)=>{const c=document.createElement('canvas');c.width=source.naturalWidth;c.height=source.naturalHeight;c.getContext('2d').drawImage(source,0,0);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));const width=c.width,height=c.height;c.width=c.height=1;progress(100);return{blob,previewBlob:blob,width,height};};
   window.saved=[];window.filmifySavePhoto=async b=>window.saved.push(b);
  });
  await inject(p,1);await p.click('[data-action=process]');await p.waitForSelector('.result-flow',{timeout:30000});await p.waitForTimeout(350);
  assert.equal(await p.locator('#track .slide').count(),3);assert.equal(await p.locator('#dots .num').innerText(),'1 / 3');assert.equal(await p.locator('#studio').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(232, 232, 230)');
  await p.screenshot({path:path.join(OUT,'01-single-compare.png')});
  const seed=await p.evaluate(()=>resultPresentation());
  const box=await p.locator('#swiper').boundingBox(),x=box.x+box.width*.75,y=box.y+box.height*.5;
  const offset=()=>p.locator('#track').evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41);
  await p.mouse.move(x,y);await p.mouse.down();await p.mouse.move(x-90,y,{steps:6});
  assert(Math.abs(await offset()+90)<2,'picture follows pointer before release');assert.equal(await p.evaluate(()=>state.resultIndex),0,'index waits for release');
  await p.screenshot({path:path.join(OUT,'02-held-drag.png')});await p.mouse.up();await p.waitForTimeout(350);assert.equal(await p.evaluate(()=>state.resultIndex),1);
  await p.mouse.move(x,y);await p.mouse.down();await p.mouse.move(x-90,y,{steps:6});await p.mouse.up();await p.waitForTimeout(350);assert.equal(await p.evaluate(()=>state.resultIndex),2);await p.waitForSelector('.slide canvas');
  await p.screenshot({path:path.join(OUT,'03-single-live.png')});
  await p.click('[data-action=save]');await p.waitForFunction(()=>!ioBusy);assert.deepEqual(await p.evaluate(()=>resultPresentation()),seed);
  assert(await p.evaluate(()=>saved.length===1&&saved[0]===outputs[state.selected[0]].liveCover.blob),'save exact cached cover');
  assert(await p.evaluate(()=>outputs[state.selected[0]].width===600&&outputs[state.selected[0]].height===800),'unframed output dimensions retained');
  // Cancelled gesture returns to the original page, vertical gesture never pages.
  await p.evaluate(()=>{const sw=document.getElementById('swiper');for(const [type,x,y] of [['pointerdown',250,300],['pointermove',350,300],['pointercancel',350,300]])sw.dispatchEvent(new PointerEvent(type,{pointerId:77,isPrimary:true,bubbles:true,clientX:x,clientY:y}));});await p.waitForTimeout(350);assert.equal(await p.evaluate(()=>state.resultIndex),2);
  await p.evaluate(()=>{const sw=document.getElementById('swiper');for(const [type,x,y] of [['pointerdown',200,300],['pointermove',210,450],['pointerup',210,450]])sw.dispatchEvent(new PointerEvent(type,{pointerId:78,isPrimary:true,bubbles:true,clientX:x,clientY:y}));});assert.equal(await p.evaluate(()=>state.resultIndex),2);
  // Edge resistance and short drag snap back.
  await p.mouse.move(x,y);await p.mouse.down();await p.mouse.move(x-80,y,{steps:6});assert(Math.abs(await offset()+box.width*2+20)<2,'edge resistance');await p.mouse.up();await p.waitForTimeout(350);assert.equal(await p.evaluate(()=>state.resultIndex),2);
  for(const size of [{width:320,height:568},{width:430,height:932}]){await p.setViewportSize(size);await p.waitForTimeout(350);const fits=await p.locator('#track .slide canvas').evaluate(e=>{const r=e.getBoundingClientRect(),f=document.querySelector('.result-footer').getBoundingClientRect();return r.top>=0&&r.bottom<=f.top&&r.width<=innerWidth;});assert(fits,'live and footer fit '+size.width);await p.screenshot({path:path.join(OUT,'04-live-'+size.width+'.png')});}
  // Carrier names must represent the actual paper, not the shared chemistry route.
  const labels=await p.evaluate(()=>{const old=state.print;const out=FilmifyMaterials.prints.map((_,i)=>{state.print=i;return paperCaption();});state.print=old;return out;});assert(labels.includes('ENDURA PREMIER'));assert(labels.includes('2393'));
  await p.evaluate(()=>{window.sharedDesign=null;FilmifyLiveWipe.record=async(n,e,opts)=>{window.sharedDesign=opts;return{cover:outputs[state.selected[0]].liveCover.blob,video:new Blob(['fixture'],{type:'video/mp4'})};};window.filmifyShareLiveGroup=async()=>{};});
  await p.click('[data-action=share]');await p.waitForFunction(()=>!ioBusy);assert.equal(await p.evaluate(()=>sharedDesign.theme),seed.theme,'share reuses preview theme');assert.deepEqual(await p.evaluate(()=>resultPresentation()),seed);
  const touchBox=await p.locator('#swiper').boundingBox(),tx=touchBox.x+60,ty=touchBox.y+touchBox.height/2,cdp=await p.context().newCDPSession(p);
  await p.evaluate(()=>{window.touchEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])document.getElementById('swiper').addEventListener(type,e=>touchEvents.push({type:e.type,x:e.clientX,y:e.clientY,index:state.resultIndex,id:e.pointerId}));});
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:ty}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx+100,y:ty}]});
  assert(Math.abs(await offset()+touchBox.width*2-100)<2,'touch follows finger before touchEnd');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(350);assert.equal(await p.locator('#dots .num').innerText(),'2 / 3');assert.equal(await p.evaluate(()=>state.resultIndex),1,'touch swipe pages '+JSON.stringify(await p.evaluate(()=>touchEvents)));
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await cdp.detach();
  report.swipe='mouse and touch held drag, paging, cancel, vertical lock, edge resistance';report.seed=seed;
  for(const n of [2,8,9]){
   await p.goto(url);await p.evaluate(()=>{let source;FilmifyEngine.setImage=im=>{source=im;};FilmifyEngine.develop=async(style,progress)=>{const c=document.createElement('canvas');c.width=source.naturalWidth;c.height=source.naturalHeight;c.getContext('2d').drawImage(source,0,0);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg')),width=c.width,height=c.height;c.width=c.height=1;progress(100);return{blob,previewBlob:blob,width,height};};});
   await inject(p,n);await p.click('[data-action=process]');await p.waitForSelector('.result-flow',{timeout:45000});await p.waitForTimeout(200);
   const info=await p.evaluate(async()=>({pages:slideMeta.length,seed:collage.seed,presentation:resultPresentation().seed,share:(await buildShareBlobs()).length}));assert.equal(info.seed,info.presentation);assert.equal(info.pages,n===9?12:n===8?18:3+n*2);assert.equal(info.share,n===9?11:2+n*2);
   await p.screenshot({path:path.join(OUT,'05-collage-'+n+'.png')});
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log('PASS result design',JSON.stringify(report));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
