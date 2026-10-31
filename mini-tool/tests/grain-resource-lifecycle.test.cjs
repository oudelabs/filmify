'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..'),DEADLINE=20000;
const flush=()=>new Promise(resolve=>setImmediate(resolve));

class Clock {
 constructor(){this.now=0;this.next=0;this.tasks=new Map();}
 schedule(callback,delay,repeat){const id=++this.next;this.tasks.set(id,{callback,delay,at:this.now+delay,repeat});return id;}
 clear(id){this.tasks.delete(id);}
 async advance(ms){
  const end=this.now+ms;let count=0;
  for(;;){
   let selected=null;
   for(const [id,task] of this.tasks)if(task.at<=end&&(!selected||task.at<selected.task.at))selected={id,task};
   if(!selected)break;if(++count>100000)throw new Error('Virtual clock did not quiesce');
   this.now=selected.task.at;if(selected.task.repeat)selected.task.at+=selected.task.delay;else this.tasks.delete(selected.id);
   selected.task.callback();await flush();
  }
  this.now=end;await flush();
 }
 deadlines(){return Array.from(this.tasks.values()).filter(task=>!task.repeat);}
}

function harness(kind){
 const clock=new Clock(),images=[],requests=[],canvases=[];let throwSource=false;
 class ControlledImage {
  constructor(){this.onload=this.onerror=null;this._src='';this.naturalWidth=this.naturalHeight=0;images.push(this);}
  set src(value){this._src=value;if(value){requests.push(value);if(throwSource){throwSource=false;throw new Error('Injected source setter failure');}}}
  get src(){return this._src;}
  load(badDimensions){this.naturalWidth=badDimensions?1:256;this.naturalHeight=badDimensions?1:77;if(this.onload)this.onload();}
  error(){if(this.onerror)this.onerror();}
 }
 let materialPixels=null,atlasPixels=null;
 const sandbox={Image:ControlledImage,Float32Array,Float64Array,Uint8Array,Uint32Array,Uint8ClampedArray,DataView,Math,Number,Promise,Map,Set,Error,
  performance:{now:()=>clock.now},
  setTimeout:(callback,delay)=>clock.schedule(callback,delay,false),clearTimeout:id=>clock.clear(id),
  setInterval:(callback,delay)=>clock.schedule(callback,delay,true),clearInterval:id=>clock.clear(id),
  filmifyYield:()=>Promise.resolve(),
  document:{hidden:false,addEventListener(){},removeEventListener(){},createElement(name){
   assert.equal(name,'canvas');const canvas={width:0,height:0,getContext(){return {
    drawImage(){},getImageData(){
     if(kind==='material'||kind==='standard'){
      if(!materialPixels){
       materialPixels=new Uint8ClampedArray(256*77*4);const floats=14598,raw=new Uint8Array(floats*4),view=new DataView(raw.buffer);
       for(let i=0;i<floats;i++)view.setFloat32(i*4,1,true);
       for(let i=0;i<raw.length;i++)materialPixels[Math.floor(i/3)*4+i%3]=raw[i];
      }
      return {data:materialPixels};
     }
     if(!atlasPixels)atlasPixels=new Uint8ClampedArray(1024*1088*4).fill(127);
     return {data:atlasPixels};
    }
   };}};canvases.push(canvas);return canvas;
  }}
 };
 sandbox.window=sandbox;const context=vm.createContext(sandbox);
 for(const file of ['grain-material-data.js','grain-material.js','standard-data.js','standard-cpu.js','standard-glsl.js','standard-renderer.js','grain.js']){
  let source=fs.readFileSync(path.join(ROOT,'minitool',file),'utf8');
  vm.runInContext(source,context,{filename:file});
 }
 const api=kind==='material'?context.FilmifyGrainMaterial:context.FilmifyGrain;
 return {clock,images,requests,canvases,
  load:cancelled=>kind==='material'?api.prepare(cancelled):api.prepareLinear({sourceWidth:512,sourceHeight:384,params:{amount:100},cancelled}),
  release:()=>api.release(),loaded:()=>kind==='material'?api.workingBytes()>0:context.FilmifyGrainMaterial.workingBytes()>0,
  throwNextSource:()=>{throwSource=true;}
 };
}

function observe(promise){
 const state={status:'pending',message:''};
 state.done=Promise.resolve(promise).then(()=>{state.status='fulfilled';},error=>{state.status='rejected';state.message=error.message;});return state;
}
function closed(image){assert.equal(image.onload,null);assert.equal(image.onerror,null);assert.equal(image.src,'');}
function noTimers(h){assert.equal(h.clock.tasks.size,0,'No resource deadline or caller poll may remain');}
function oneDeadline(h){const timers=h.clock.deadlines();assert.equal(timers.length,1);assert.equal(timers[0].delay,DEADLINE);}

for(const kind of ['material','standard']){
 test(kind+' resource: a 20s timeout clears pending and stale load/error cannot poison successful retry',async()=>{
  const h=harness(kind),first=observe(h.load());await flush();oneDeadline(h);
  const old=h.images[0],lateLoad=old.onload,lateError=old.onerror;
  await h.clock.advance(DEADLINE-1);assert.equal(first.status,'pending');assert.equal(h.requests.length,1);
  await h.clock.advance(1);await first.done;assert.equal(first.status,'rejected');assert.match(first.message,/读取超时/);assert.equal(h.loaded(),false);closed(old);noTimers(h);
  const retry=observe(h.load());await flush();assert.equal(h.images.length,2);assert.match(h.requests[1],/\?retry=1$/);oneDeadline(h);
  lateLoad();lateError();await flush();assert.equal(retry.status,'pending');assert.equal(h.canvases.length,0);assert.equal(h.loaded(),false);oneDeadline(h);
  h.images[1].load();await retry.done;assert.equal(retry.status,'fulfilled');assert.equal(h.loaded(),true);closed(h.images[1]);noTimers(h);
  lateLoad();lateError();await h.clock.advance(DEADLINE);assert.equal(h.loaded(),true);assert.equal(h.requests.length,2);assert.equal(h.canvases.length,1);noTimers(h);h.release();
 });
 test(kind+' resource: shared wait is not duplicated and canceling one caller preserves another caller',async()=>{
  const h=harness(kind);let canceled=false;
  const first=observe(h.load(()=>canceled)),second=observe(h.load());await flush();assert.equal(h.images.length,1);oneDeadline(h);
  canceled=true;await h.clock.advance(32);await first.done;assert.equal(first.message,'已取消');assert.equal(second.status,'pending');assert.notEqual(h.images[0].src,'');assert.equal(typeof h.images[0].onload,'function');oneDeadline(h);
  const third=observe(h.load());await flush();assert.equal(h.requests.length,1);
  h.images[0].load();await Promise.all([second.done,third.done]);assert.equal(second.status,'fulfilled');assert.equal(third.status,'fulfilled');assert.equal(h.canvases.length,1);noTimers(h);
  await h.load();assert.equal(h.requests.length,1);noTimers(h);h.release();assert.equal(h.loaded(),false);
 });
 test(kind+' resource: release clears deadline and callers, and late callbacks cannot commit after a new generation',async()=>{
  const h=harness(kind),first=observe(h.load()),second=observe(h.load(()=>false));await flush();const old=h.images[0],lateLoad=old.onload,lateError=old.onerror;oneDeadline(h);
  h.release();await Promise.all([first.done,second.done]);assert.equal(first.message,'已取消');assert.equal(second.message,'已取消');closed(old);noTimers(h);assert.equal(h.loaded(),false);
  const retry=observe(h.load());await flush();assert.match(h.requests[1],/\?retry=1$/);lateLoad();lateError();await flush();assert.equal(retry.status,'pending');assert.equal(h.canvases.length,0);oneDeadline(h);
  h.images[1].load();await retry.done;assert.equal(retry.status,'fulfilled');assert.equal(h.loaded(),true);noTimers(h);h.release();h.release();noTimers(h);assert.equal(h.loaded(),false);
 });
 test(kind+' resource: image error clears its deadline and permits a fresh request',async()=>{
  const h=harness(kind),first=observe(h.load());await flush();h.images[0].error();await first.done;assert.match(first.message,/读取失败/);closed(h.images[0]);noTimers(h);
  const retry=observe(h.load());await flush();assert.equal(h.requests.length,2);assert.match(h.requests[1],/\?retry=1$/);h.images[1].load();await retry.done;assert.equal(retry.status,'fulfilled');noTimers(h);h.release();
 });
 test(kind+' resource: a successful read clears the deadline even when subsequent dimensions are invalid',async()=>{
  const h=harness(kind),first=observe(h.load());await flush();h.images[0].load(true);await first.done;assert.equal(first.status,'rejected');assert.match(first.message,/尺寸不符|读取失败/);assert.equal(h.loaded(),false);closed(h.images[0]);noTimers(h);
  const retry=observe(h.load());await flush();assert.equal(h.requests.length,2);h.images[1].load();await retry.done;assert.equal(retry.status,'fulfilled');noTimers(h);h.release();
 });
 test(kind+' resource: synchronous Image.src failure leaves no deadline or handlers behind',async()=>{
  const h=harness(kind);h.throwNextSource();const failed=observe(h.load());await failed.done;assert.equal(failed.message,'Injected source setter failure');closed(h.images[0]);noTimers(h);
  const retry=observe(h.load());await flush();assert.equal(h.requests.length,2);h.images[1].load();await retry.done;assert.equal(retry.status,'fulfilled');noTimers(h);h.release();
 });
}
