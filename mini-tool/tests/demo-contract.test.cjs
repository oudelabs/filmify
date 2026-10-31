'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const styles=require('../minitool/style-config.js'),paper=require('../minitool/paper-adaptation.js');
test('demo catalog is independent and the neutral default resolves without a stock catalog',()=>{
 assert.equal(styles.defaultId,'demo-identity');assert.equal(styles.items.length,6);
 for(const row of styles.items){assert.match(row.id,/^demo-/);assert.match(row.sourceName,/演示/);assert.match(row.lut,/^\.\/assets\/demo\//);assert.ok(fs.existsSync('minitool/'+row.lut.slice(2)));}
 assert.equal(styles.get('missing').id,'demo-identity');
});
test('analytic paper keeps scan exact, mono neutral, table bounds and unknown-id rejection',()=>{
 for(const rgb of [[0,0,0],[1,1,1],[.17,.42,.8],[1,0,0]]){
  assert.deepEqual(paper.finishedRGB(...rgb,'scan'),rgb);
  const mono=paper.finishedRGB(...rgb,'graded-print');assert.equal(mono[0],mono[1]);assert.equal(mono[1],mono[2]);
  for(const row of paper.prints)assert.ok(paper.finishedRGB(...rgb,row.id).every(x=>Number.isFinite(x)&&x>=0&&x<=1));
 }
 assert.notDeepEqual(paper.finishedRGB(.4,.3,.7,'demo-paper-warm'),paper.finishedRGB(.4,.3,.7,'demo-paper-cool'));
 assert.throws(()=>paper.finishedRGB(.2,.4,.6,'missing'),/未知/);assert.equal(paper._testing.size,9);
 assert.equal(paper._testing.tables.size,2);assert.equal(paper._testing.mono.length,1025);
 assert.equal(/base64|monoEncoded|const encoded=/.test(fs.readFileSync('minitool/paper-adaptation.js','utf8')),false);
});
function negativeHarness(){let next=0;const blobs=new Map(),pending=[];
 class Canvas{constructor(){this.width=this.height=1;this.data=new Uint8ClampedArray(4);}getContext(){const c=this;return {getImageData(){return {data:c.data};},createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(value){c.data=value.data.slice();}};}toBlob(callback){pending.push(()=>callback({pixels:Array.from(this.data)}));}}
 const context=vm.createContext({document:{createElement:()=>new Canvas()},Uint8ClampedArray,setTimeout,clearTimeout,setInterval,clearInterval,filmifyYield:async()=>{},URL:{createObjectURL:b=>{const id='blob:'+ ++next;blobs.set(id,b);return id;},revokeObjectURL:id=>blobs.delete(id)}});
 vm.runInContext(fs.readFileSync('minitool/negative-preview.js','utf8'),context);
 return {api:vm.runInContext('FilmNegativePreview',context),Canvas,blobs,pending};
}
test('analytic negative never loads a table and keeps source bytes immutable',async()=>{
 const {api,Canvas,blobs,pending}=negativeHarness(),source=new Canvas();source.data=Uint8ClampedArray.from([20,200,90,255]);
 const promise=api.render(source,'./','color');pending.shift()();const out=await promise;
 assert.deepEqual(blobs.get(out.color).pixels,[239,73,131,255]);assert.deepEqual(Array.from(source.data),[20,200,90,255]);api.revoke(out);assert.equal(blobs.size,0);
});
test('release and late native encoder cannot create a stale negative URL',async()=>{
 const {api,Canvas,blobs,pending}=negativeHarness(),promise=api.render(new Canvas(),'./','color');api.release();pending.shift()();await assert.rejects(promise,/cancel/);assert.equal(blobs.size,0);
});
