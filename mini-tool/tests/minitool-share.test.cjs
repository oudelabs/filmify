const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function adapter(postNote){
 const context={window:{xhs:{miniTool:{postNote}}},FileReader:class{
  readAsDataURL(blob){this.result='data:image/png;base64,'+blob;this.onload();}
 }};
 vm.createContext(context);vm.runInContext(fs.readFileSync('minitool/host.js','utf8'),context);return context.window;
}
test('comparison resources preserve original/effect ordering in one native publish call',async()=>{
 const calls=[],host=adapter(async data=>calls.push(JSON.parse(JSON.stringify(data))));
 const blobs=Array.from({length:9},(_,i)=>['original'+i,'effect'+i]).flat();
 await host.filmifySharePhotos(blobs);
 assert.equal(calls.length,1);assert.equal(calls[0].pageType,'photo_publish');
 assert.deepEqual(calls[0].mediaInfo.image_resources.map(item=>item.url),blobs.map(b=>'data:image/png;base64,'+b));
});
test('rejects empty/over-limit batches before calling the host',async()=>{
 let calls=0;const host=adapter(async()=>calls++);
 await assert.rejects(host.filmifySharePhotos([]),/1–18/);
 await assert.rejects(host.filmifySharePhotos(Array(19).fill('image')),/1–18/);
 assert.equal(calls,0);
});
test('native failure is propagated for retry, never converted to a success',async()=>{
 const host=adapter(async()=>{throw new Error('permission denied');});
 await assert.rejects(host.filmifySharePhotos(['effect']),/permission denied/);
});
