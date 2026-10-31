'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');

// Module acquisition and transaction ownership need no browser. Each injected
// factory owns a disposable instance; stage callbacks exercise production guards.
function harness(fault,action){
 const events=[],disposed={color:0,render:0,encoder:0};let stopped=false,localFallback=false;
 function instance(name){return {
  dispose(){disposed[name]++;events.push('dispose:'+name);},
  get path(){return name==='color'?(localFallback?'javascript':'webgl2-color-tile'):'webgl2';},
  get fallback(){return name==='color'?'Injected local color fallback':'';},gpuBytes:32,peakBytes:64,
  color(){
   if(action==='cancel-color')stopped=true;
   if(action==='fallback-color')localFallback=true;
   if(action==='throw-color')throw new Error('Injected context loss');
   const data=new Float32Array([.1,.2,.3,1]);data.channels=4;return data;
  },
  pad(){return new Float32Array(4);},mix(){return new Float32Array(4);},area(){events.push('area');},
  encode(){return new Uint8ClampedArray([1,2,3,action==='invalid-alpha'?0:255]);}
 };}
 const window={};
 for(const [property,name] of [['FilmifyPixelColor','color'],['FilmifyPixelRender','render'],['FilmifyPixelEncode','encoder']]){
  window[property]={create(){events.push('create:'+name);if(fault===name+'-throw')throw new Error('Injected factory failure: '+name);return fault===name+'-null'?null:instance(name);}};
 }
 new Function('window',fs.readFileSync(path.join(ROOT,'minitool/pixel-work.js'),'utf8'))(window);
 return {create:options=>window.FilmifyPixelOps.create(null,{},options),events,disposed,cancelled:()=>stopped};
}

for(const flag of ['exact','forceCPU'])test('pixel work '+flag+' bypasses every GPU factory',async()=>{
 const h=harness();assert.equal(await h.create({[flag]:true}),null);assert.deepEqual(h.events,[]);
});

for(const name of ['render','encoder'])test('pixel work '+name+' factory failure releases prior modules and permits fallback',async()=>{
 const h=harness(name+'-throw');assert.equal(await h.create(),null);assert.equal(h.disposed.color,1);
 if(name==='encoder')assert.equal(h.disposed.render,1);
});

for(const name of ['render','encoder'])test('pixel work '+name+' unavailable releases acquired modules',async()=>{
 const h=harness(name+'-null');assert.equal(await h.create(),null);assert.equal(h.disposed.color,1);
 if(name==='encoder')assert.equal(h.disposed.render,1);
 assert.equal(h.disposed.encoder,0);
});

test('pixel work release is idempotent and prevents reuse',async()=>{
 const h=harness(),ops=await h.create();ops.dispose();ops.dispose();
 assert.deepEqual(h.disposed,{color:1,render:1,encoder:1});assert.equal(ops.bytes,0);
 assert.throws(()=>ops.color(null,'srgb-unorm8',1,1),/已取消/);
});

test('pixel work cancellation after a stage discards output without a fallback marker',async()=>{
 const h=harness(null,'cancel-color'),ops=await h.create({cancelled:h.cancelled});
 assert.throws(()=>ops.color(null,'srgb-unorm8',1,1),error=>error.message==='已取消'&&error.pixelStage!==true);
 ops.dispose();assert.deepEqual(h.disposed,{color:1,render:1,encoder:1});
});

test('pixel work stage errors request a complete-render fallback',async()=>{
 const h=harness(null,'throw-color'),ops=await h.create();
 assert.throws(()=>ops.color(null,'srgb-unorm8',1,1),error=>error.pixelStage===true&&error.message==='Injected context loss');ops.dispose();
});

test('pixel work local color fallback requests a complete-render retry',async()=>{
 const h=harness(null,'fallback-color'),ops=await h.create();
 assert.throws(()=>ops.color(null,'srgb-unorm8',1,1),error=>error.pixelStage===true&&error.message==='Injected local color fallback');
 assert.equal(ops.colorPath,'javascript');ops.dispose();
});

test('pixel work rejects an invalid encoded alpha before publication',async()=>{
 const h=harness(null,'invalid-alpha'),ops=await h.create();
 assert.throws(()=>ops.encode(new Float32Array([.1,.2,.3,1])),error=>error.pixelStage===true&&error.message.includes('非有限'));ops.dispose();
});

test('pixel work area targets require one matching begin and finish',async()=>{
 const h=harness(),ops=await h.create(),target=new Float32Array(6);
 ops.areaBegin(target,2,1,3,4,2);assert.throws(()=>ops.areaBegin(target,2,1,3,4,2));
 ops.areaFinish(target);assert.throws(()=>ops.areaFinish(target));ops.dispose();
});
