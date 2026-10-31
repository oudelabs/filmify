// Exercise only packaged assets: no repository resource fallback.
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../dist/xhs-tool');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.json':'application/json','.woff':'font/woff','.woff2':'font/woff2'};
(async()=>{
 const server=http.createServer((req,res)=>{let url;try{url=decodeURIComponent(req.url.split('?')[0]);}catch(e){res.writeHead(400);res.end();return;}const file=path.resolve(root,'.'+(url==='/'?'/index.html':url));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{browser=await require('./launch-browser.cjs').launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),missing=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)missing.push(r.url());});await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load'});await page.waitForFunction(()=>window.FilmifyTextureEngine&&window.FilmifyEditorShare&&window.FilmifyGrain&&typeof FilmNegativePreview!=='undefined'&&document.querySelector('.negative-home'));
 const report=await page.evaluate(async()=>{
  const image=document.createElement('canvas');image.width=193;image.height=257;const g=image.getContext('2d');const gradient=g.createLinearGradient(0,0,193,257);gradient.addColorStop(0,'#101b30');gradient.addColorStop(1,'#dce6c9');g.fillStyle=gradient;g.fillRect(0,0,193,257);g.fillStyle='#ffffff';g.fillRect(90,100,3,3);
  const s=FilmifyTextureEngine.createSession(image,{seed:291});let output;
  try{const color=await s.render({tone:0,color:0},{preview:true,colorOnly:true});const colored=Array.from(color.canvas.getContext('2d').getImageData(0,0,1,1).data);output=await s.render({tone:10,color:5,soft:1,halation:1,grain:1},{preview:false});const rgba=output.canvas.getContext('2d').getImageData(0,0,193,257).data;let checksum=0;for(let i=0;i<rgba.length;i++)checksum=(checksum+rgba[i])>>>0;return {width:output.width,height:output.height,checksum,colored,stats:output.stats};}
  finally{if(output)output.canvas.width=output.canvas.height=1;s.release();FilmifyGrain.release();image.width=image.height=1;}
 });
 assert.equal(report.width,193);assert.equal(report.height,257);assert.ok(report.checksum>0);assert.equal(report.colored[3],255);assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);assert.equal(await page.locator('[data-action="apply"]').isDisabled(),true);await page.close();console.log('PASS packaged editor smoke:',JSON.stringify(report));
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
