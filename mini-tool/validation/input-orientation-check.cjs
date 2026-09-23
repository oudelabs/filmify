// Direction is a pixel property: width/height alone cannot detect double rotation,
// mirrors, 180-degree errors or square-image orientation. Exercise real JPEG EXIF
// bytes through both decoders and the actual import UI, including >4096 inputs.
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../dist/xhs-tool');
const server=http.createServer((req,res)=>{
 const rel=decodeURIComponent(req.url.split('?')[0]),file=path.join(ROOT,rel==='/'?'index.html':rel);
 fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(data);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  await page.evaluate(()=>{
   window.orientationFixture=async function(w,h,o,littleEndian){
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d');['#f00','#0f0','#00f','#ff0'].forEach((color,i)=>{ctx.fillStyle=color;ctx.fillRect((i%2)*w/2,Math.floor(i/2)*h/2,w/2,h/2);});
    const jpeg=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.95));canvas.width=canvas.height=1;
    const app1=new Uint8Array(36);app1.set([255,225,0,34,69,120,105,102,0,0]);
    const view=new DataView(app1.buffer),le=littleEndian;
    app1[10]=app1[11]=le?73:77;view.setUint16(12,42,le);view.setUint32(14,8,le);view.setUint16(18,1,le);
    view.setUint16(20,0x112,le);view.setUint16(22,3,le);view.setUint32(24,1,le);view.setUint16(28,o,le);
    return new File([jpeg.slice(0,2),app1,jpeg.slice(2)],'orientation-'+o+'.jpg',{type:'image/jpeg'});
   };
   window.orientationPixels=async function(blob){
    const url=URL.createObjectURL(blob),img=new Image();
    try{
     await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});
     const canvas=document.createElement('canvas');canvas.width=canvas.height=20;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,20,20);
     const palette=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]],labels='RGBY';
     const colors=[[3,3],[16,3],[3,16],[16,16]].map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3));
     const order=colors.map(rgb=>labels[palette.map(c=>c.reduce((sum,v,i)=>sum+(rgb[i]-v)**2,0)).reduce((best,d,i,ds)=>d<ds[best]?i:best,0)]).join('');
     canvas.width=canvas.height=1;return{order,width:img.naturalWidth,height:img.naturalHeight};
    }finally{img.src='';URL.revokeObjectURL(url);}
   };
  });
  // Explicit corner oracle, independent of the browser's EXIF interpretation.
  const expected=['','RGBY','GRYB','YBGR','BYRG','RBGY','BRYG','YGBR','GYRB'];
  for(const mode of ['small-original','bitmap','image-fallback']){
   for(let o=1;o<=8;o++){
    const w=mode==='small-original'?1200:4100,h=mode==='small-original'?800:2460;
    const result=await page.evaluate(async({w,h,o,mode})=>{
     const file=await orientationFixture(w,h,o,o%2===0),header=await readImageSize(file),native=window.createImageBitmap;
     if(mode==='image-fallback')window.createImageBitmap=undefined;
     try{const normalized=await normalizeSource(file,null,header.width,header.height,header.orientation,header);
      return{pixels:await orientationPixels(normalized.blob),width:normalized.width,height:normalized.height,unchanged:normalized.blob===file};
     }finally{window.createImageBitmap=native;}
    },{w,h,o,mode});
    const scale=Math.min(1,4096/w),ew=Math.round((o>=5?h:w)*scale),eh=Math.round((o>=5?w:h)*scale);
    assert.equal(result.pixels.order,expected[o],mode+' orientation '+o+' corner pixels');
    assert.deepEqual([result.width,result.height,result.pixels.width,result.pixels.height],[ew,eh,ew,eh],mode+' dimensions '+o);
    if(mode==='small-original')assert(result.unchanged,'small original bytes retained');
   }
   console.log('PASS '+mode+': all 8 EXIF directions, corner pixels and dimensions; both TIFF byte orders');
  }
  for(const [w,h] of [[4100,4100],[2460,4100]])for(const fallback of [false,true]){
   const result=await page.evaluate(async({fallback,w,h})=>{
    const file=await orientationFixture(w,h,6,true),header=await readImageSize(file),native=window.createImageBitmap;
    if(fallback)window.createImageBitmap=undefined;
    try{return await orientationPixels((await normalizeSource(file,null,w,h,6,header)).blob);}finally{window.createImageBitmap=native;}
   },{fallback,w,h});
   assert.equal(result.order,expected[6],'square/landscape image orientation');
   assert.equal(result.width,Math.round(h*4096/Math.max(w,h)));assert.equal(result.height,Math.round(w*4096/Math.max(w,h)));
  }
  console.log('PASS square and landscape EXIF: bitmap and image fallback');
  // Full import, large landscape storage with a portrait EXIF tag.
  await page.evaluate(async()=>{
   const dt=new DataTransfer();dt.items.add(await orientationFixture(4100,2460,6,true));
   const input=document.getElementById('fileInput');input.files=dt.files;input.dispatchEvent(new Event('change'));
  });
  await page.waitForSelector('.photoarea img');
  const imported=await page.evaluate(async()=>{
   const p=photos[state.selected[0]];return{width:p.width,height:p.height,original:[p.origWidth,p.origHeight],pixels:await orientationPixels(p.file)};
  });
  assert.deepEqual(imported.original,[2460,4100]);assert.equal(imported.pixels.order,expected[6]);assert.deepEqual([imported.width,imported.height],[2458,4096]);
  console.log('PASS actual import: original metadata, normalized dimensions and visible-pixel orientation');
 }finally{await browser.close();server.close();}
 console.log('INPUT ORIENTATION PASS');
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
