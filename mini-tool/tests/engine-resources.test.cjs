const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');

function engine(failedAsset, badSize=false){
 let failed=false,requests=[];
 const ctx={FILMIFY_STYLES:{sample:{nativeFilm:true,size:1,asset:'core',rawAsset:'raw',rawSize:1,rawScale:[1,1,1]}},Float32Array,Promise,filmifyYield:async()=>{}};
 ctx.Image=class{set src(path){requests.push(path);this.naturalWidth=badSize?3:2;this.naturalHeight=1;queueMicrotask(()=>{if(path.endsWith(failedAsset)&&!failed){failed=true;this.onerror();}else this.onload();});}};
 ctx.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8Array(8).fill(255)})})})};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('minitool/engine.js','utf8')+';this.engine=FilmifyEngine;',ctx);
 return {ctx,requests};
}
for(const asset of ['core','raw'])test('failed '+asset+' leaves no partial recipe; concurrent retry completes',async()=>{
 const {ctx,requests}=engine(asset);await assert.rejects(ctx.engine.loadColors('sample'));
 for(const field of ['values','rawValues','meterValues'])assert.equal(ctx.FILMIFY_STYLES.sample[field],undefined);
 const a=ctx.engine.loadColors('sample'),b=ctx.engine.loadColors('sample');assert.equal(a,b);await a;
 for(const field of ['values','rawValues','meterValues'])assert.equal(ctx.FILMIFY_STYLES.sample[field].length,3);
 const count=requests.length;await ctx.engine.loadColors('sample');assert.equal(requests.length,count);
});
test('bad PNG dimensions fail atomically',async()=>{
 const {ctx}=engine('none',true);await assert.rejects(ctx.engine.loadColors('sample'),/尺寸/);
 assert.equal(ctx.FILMIFY_STYLES.sample.values,undefined);assert.equal(ctx.FILMIFY_STYLES.sample.meterValues,undefined);
});
test('incomplete or retired recipes fail before requesting assets',async()=>{
 for(const field of ['nativeFilm','asset','rawAsset']){
  const {ctx,requests}=engine('none');delete ctx.FILMIFY_STYLES.sample[field];await assert.rejects(ctx.engine.loadColors('sample'),/不完整/);assert.equal(requests.length,0);
 }
});
