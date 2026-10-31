'use strict';
// Deterministic engine orchestration mock. This does not emulate WebGL math,
// native Canvas, context loss or browser quality; the browser gate covers those.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const sourcePath=process.env.FILMIFY_ADAPTIVE_SOURCE||path.resolve(__dirname,'../minitool/texture-engine.js');
const script=fs.readFileSync(sourcePath,'utf8');
const {test}=require('node:test');
const report={pass:false,scope:'Pure Node engine orchestration with mock Canvas, pixel modules, and optical backend. No browser or GPU operation.',cases:[]};
async function scenario(name,plan={}){
 const radius=plan.radius===undefined?40:plan.radius,adaptiveCore=Math.min(384,512-4*radius>=128?512-4*radius:1024-4*radius>=128?1024-4*radius:384);
 const state={name,workspaces:0,disposed:0,near:[],published:[],canvases:[],stopped:false,session:null,invalidOnce:!!plan.invalidOnce};
 const rgba=(w,h,Type=Float32Array)=>{const a=new Type(w*h*4);for(let i=3;i<a.length;i+=4)a[i]=Type===Float32Array?1:255;a.channels=4;return a;};
 class Canvas{constructor(){this.width=1;this.height=1;state.canvases.push(this);}getContext(kind){if(kind!=='2d')return null;const self=this;return {fillRect(){},drawImage(){},getImageData(x,y,w,h){return {data:rgba(w,h,Uint8ClampedArray)};},putImageData(data,x,y){self.lastWrite={w:data.width,h:data.height,x,y};}};}}
 class Image{constructor(){this.naturalWidth=this.naturalHeight=512;}set src(value){if(value)queueMicrotask(()=>this.onload&&this.onload());}}
 const sandbox={window:{},document:{createElement:()=>new Canvas()},Image,ImageData:class{constructor(data,w,h){this.data=data;this.width=w;this.height=h;}},performance,setTimeout,clearTimeout,queueMicrotask,Float32Array,Float64Array,Uint8ClampedArray,Uint8Array,Map,Set,Math,Number,Promise,Error,filmifyScheduleTask(fn){queueMicrotask(fn);return ()=>{};},FilmifyPixelColor:{},FilmifyPixelRender:{},FilmifyPixelEncode:{}};
 sandbox.FilmifyTextureHalation={geometry(){return {id:'35mm',frameHeightMm:24,focalLengthMm:Math.hypot(24,36)};}};
 sandbox.FilmifyTextureOptics={mirror(i,n){const period=2*n-2,k=((i%period)+period)%period;return Math.min(k,period-k);},async kernel(w,h,um,group){return {radius:group==='near'?radius:0,key:group,data:new Float32Array([1]),energy:1,nearEnergyRGB:[1,1,1]};},family(){return {weights:[.22,.30,.48]};},scatterAmount(){return .35;},createBackend(forceCPU){let path=forceCPU||plan.opticsCPU?'cpu':'webgl2';return {get path(){return path;},gaussianPath:'cpu',fallback:'',peakBytes:0,async convolveRGB(data,w,h,k,cancelled){if(k.key==='near'){state.near.push({core:w-2*k.radius,path});if(plan.nearLoss&&path==='webgl2')path='cpu';if(plan.cancelAtNear)state.stopped=true;if(plan.releaseAtNear)state.session.release();}if(cancelled&&cancelled())throw Error('已取消');return data;},release(){path='cpu';}};}};
 sandbox.FilmifyPixelOps={async create(table,s,opts){if(opts.forceCPU||plan.noPixelGPU)return null;state.workspaces++;let disposed=false;return {preferRGBA:true,mode:'webgl2-pixels',bytes:0,encodePath:'webgl2',color(data,mode,w,h){return rgba(w,h);},pad(data,cw,left,top,x,y,w,h,pad){return rgba(w+2*pad,h+2*pad);},areaBegin(){},areaFields(){},area(){},areaFinish(){},mix(data,cw,w,h){return rgba(w,h);},encode(data){if(state.invalidOnce){state.invalidOnce=false;const error=new Error('效果产生非有限颜色');error.pixelStage=true;throw error;}return rgba(data.length/4,1,Uint8ClampedArray);},dispose(){if(!disposed){disposed=true;state.disposed++;}}};}};
 vm.createContext(sandbox);vm.runInContext(script,sandbox);const engine=sandbox.window.FilmifyTextureEngine,session=engine.createSession({width:385,height:257},{seed:291,inputMode:'srgb-unorm8'});state.session=session;

 if(plan.cacheToggle){
  const settings={soft:1,softFamily:'cinebloom',softStrength:.5,grain:0,halation:0,opticsFormatMm:35,opticsFormatId:'35mm'};
  const first=await session.render(settings,{preview:true,disableAdaptiveTile:!!plan.firstDisabled});
  const before=state.near.length,second=await session.render(settings,{preview:true,disableAdaptiveTile:!plan.firstDisabled});
  assert.equal(state.near[0].core,plan.firstDisabled?384:adaptiveCore,name+' first grid');
  assert.equal(second.stats.cacheHit,undefined,name+' different grid request must render');
  assert.notEqual(second.canvas,first.canvas,name+' owns separate complete result');
  assert.ok(state.near.length>before,name+' recomputes near tiles');
  assert.equal(state.near[before].core,plan.firstDisabled?adaptiveCore:384,name+' changed grid');
  const repeats=[];
  for(const disabled of [!!plan.firstDisabled,!plan.firstDisabled]){
   const beforeCalls=state.near.length,result=await session.render(settings,{preview:true,disableAdaptiveTile:disabled});
   assert.equal(result.stats.cacheHit,true,name+' same grid cache hit');assert.equal(result.canvas,disabled===!!plan.firstDisabled?first.canvas:second.canvas);
   assert.equal(state.near.length,beforeCalls,name+' same grid no near work');repeats.push({disabled,cacheHit:result.stats.cacheHit});
  }
  assert.equal(state.workspaces,2,name+' only two initial workspaces');session.release();
  assert.equal(state.disposed,state.workspaces,name+' owns each workspace');assert.equal(session.getStats().cacheBytes,0,name+' frees cache');
  report.cases.push({name,firstDisabled:!!plan.firstDisabled,firstCore:state.near[0].core,secondCore:state.near[before].core,secondCacheHit:!!second.stats.cacheHit,repeats,workspaces:state.workspaces,disposed:state.disposed,releasedStats:session.getStats()});return;
 }
 let result=null,error='';try{result=await session.render({soft:1,softFamily:'cinebloom',softStrength:.5,grain:0,halation:0,opticsFormatMm:35,opticsFormatId:'35mm'},{preview:false,colorPreview:false,forceCPU:!!plan.forceCPU,cancelled:()=>state.stopped,onLinearTile:t=>{state.published.push(t.width);if(plan.cancelAtTile)state.stopped=true;}});}catch(e){error=e.message;}
 const stats=session.getStats(),outputs=state.canvases.filter(c=>c.lastWrite&&c.lastWrite.x!==undefined&&c.width===385&&c.height===257);session.release();
 const item={name,error,near:state.near,linearTileWidths:state.published,workspaces:state.workspaces,disposed:state.disposed,liveOutputs:outputs.length,finalStats:result?result.stats:null,releasedStats:session.getStats()};
 assert.equal(state.disposed,state.workspaces,name+' owns each workspace');assert.equal(item.releasedStats.cacheBytes,0,name+' frees cache');assert.equal(item.releasedStats.active,false,name+' inactive after release');
 if(plan.cancelAtNear||plan.releaseAtNear||plan.cancelAtTile){assert.match(error,/取消|释放/);assert.equal(result,null);assert.equal(outputs.length,0);assert.equal(state.workspaces,1);assert.equal(stats.finalPreviewEntries,0);}
 else{assert.equal(error,'');assert.ok(result);assert.equal(result.width,385);assert.equal(result.height,257);assert.equal(outputs.length,1);}
 if(plan.nearLoss){assert.equal(state.near[0].core,adaptiveCore);assert.equal(state.near[1].core,384);assert.equal(result.stats.pixelOps,'javascript');assert.equal(result.stats.paths.softness,'cpu');assert.equal(state.workspaces,1);}
 else if(plan.forceCPU||plan.noPixelGPU||plan.opticsCPU)assert.equal(state.near[0].core,384);
 else if(!plan.invalidOnce)assert.equal(state.near[0].core,adaptiveCore);
 if(plan.invalidOnce){assert.equal(result.stats.pixelOps,'javascript');assert.equal(state.near.find(n=>n.core===384).core,384);}
 report.cases.push(item);
}
for(const [name,plan]of [['GPU adaptive 512 budget',{}],['GPU adaptive 1024 budget',{radius:183}],['1024 mid-near GPU loss whole JS original',{radius:183,nearLoss:true}],['forceCPU original',{forceCPU:true}],['pixel factory fallback original',{noPixelGPU:true}],['optical factory CPU original',{opticsCPU:true}],['mid-near GPU loss whole JS original',{nearLoss:true}],['cancel before near completes',{cancelAtNear:true}],['release before near completes',{releaseAtNear:true}],['cancel at final tile callback',{cancelAtTile:true}],['finite failure whole JS original',{invalidOnce:true}],['adaptive then fixed cache request',{cacheToggle:true}],['fixed then adaptive cache request',{cacheToggle:true,firstDisabled:true}]])test('adaptive engine orchestration: '+name,{timeout:10000},()=>scenario(name,plan));
test('adaptive near-field core keeps default, budget and fallback boundaries',()=>{const choose=require(sourcePath)._testing.renderTileEdge,gpu={path:'webgl2'},pixels={preferRGBA:true};for(const [radius,expected]of [[0,384],[28,384],[32,384],[33,380],[40,352],[96,128],[97,384],[128,384],[160,384],[161,380],[183,292],[224,128],[225,384]])assert.equal(choose({radius},gpu,{},pixels),expected,'radius '+radius);for(const [backend,opts,work]of [[{path:'cpu'},{},pixels],[gpu,{forceCPU:true},pixels],[gpu,{disableAdaptiveTile:true},pixels],[gpu,{},null]])assert.equal(choose({radius:40},backend,opts,work),384);assert.equal(choose(null,gpu,{},pixels),384);});
