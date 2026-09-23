// 选图长边上限归一化定向回归(2026-09-20,上限 4096):
// 大图(6000x4000)注入后须被压到长边 4096,小图(900x1200)保持原尺寸不重编码;
// 显影输出尺寸与归一化后的照片一致,验证「进来统一处理到长边上限」全链路生效。
const path=require('node:path'),http=require('node:http'),fs=require('node:fs');
const ROOT=path.resolve(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.json':'application/json'};
const BIG_W=6000,BIG_H=4000,EXP_W=4096,EXP_H=Math.round(BIG_H*EXP_W/BIG_W);
function serve(port){
 return new Promise(resolve=>{
  const server=http.createServer((req,res)=>{
   const url=decodeURIComponent(req.url.split('?')[0]);
   let f;
   if(url==='/')f=path.join(ROOT,'dist','xhs-tool','index.html');
   else if(url.endsWith('/'))f=path.join(ROOT,url,'index.html');
   else{
    f=path.join(ROOT,'dist','xhs-tool',url);/* 打包页相对引用(./app.js 等)优先取包内文件 */
    if(!fs.existsSync(f))f=path.join(ROOT,url);/* 仓级资源回退(如 /minitool/*) */
   }
   if(!f.startsWith(ROOT)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);res.end();return;}
   res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});
   fs.createReadStream(f).pipe(res);
  });
  server.listen(port,'127.0.0.1',()=>resolve(server));
 });
}
async function injectSized(page,w,h,name){
 await page.evaluate(async({w,h,name})=>{
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,w,h);
  g.addColorStop(0,'hsl(210,60%,70%)');g.addColorStop(1,'hsl(20,65%,40%)');
  x.fillStyle=g;x.fillRect(0,0,w,h);
  x.fillStyle='rgba(255,255,255,.3)';x.beginPath();x.arc(w/3,h/3,Math.min(w,h)/6,0,7);x.fill();
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));
  const dt=new DataTransfer();
  dt.items.add(new File([blob],name,{type:'image/jpeg'}));
  const input=document.getElementById('fileInput');
  input.files=dt.files;
  input.dispatchEvent(new Event('change'));
 },{w:w,h:h,name:name});
}
(async()=>{
 const server=await serve(8921);
 const {chromium}=require('playwright');
 const browser=await require('../scripts/launch-browser.cjs').launchBrowser();
 const fails=[];
 const check=(label,ok,detail)=>{console.log((ok?'PASS':'FAIL')+' '+label+(detail?' — '+detail:''));if(!ok)fails.push(label);};
 try{
  const page=await browser.newPage({viewport:{width:430,height:932}});
  page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  await page.goto('http://127.0.0.1:8921/dist/xhs-tool/',{waitUntil:'load'});
  await page.waitForSelector('.main-flow');

  // 大图:6000x4000 → 应压到 4096 x EXP_H
  await injectSized(page,BIG_W,BIG_H,'big.jpg');
  await page.waitForSelector('.photoarea img',{timeout:20000});
  await page.waitForFunction(()=>typeof photos!=="undefined"&&Object.keys(photos).length===1,null,{timeout:10000});
  const big=await page.evaluate(()=>{const p=photos[Object.keys(photos)[0]];return{w:p.width,h:p.height,ow:p.origWidth,oh:p.origHeight,type:p.file.type};});
  check('大图压到长边 '+EXP_W,big.w===EXP_W&&big.h===EXP_H,JSON.stringify(big));
  check('大图原始尺寸已记录',big.ow===BIG_W&&big.oh===BIG_H);
  check('大图重编码为 JPEG',big.type==='image/jpeg',big.type);

  // 小图:900x1200 → 保持原尺寸(先点「＋」进入追加模式,否则直接换文件会替换选区)
  await page.click('[data-action="add"]');
  await injectSized(page,900,1200,'small.jpg');
  await page.waitForFunction(()=>Object.keys(photos).length===2,null,{timeout:10000});
  const small=await page.evaluate(()=>{const p=photos[Object.keys(photos)[1]];return{w:p.width,h:p.height};});
  check('小图保持原尺寸不重编码',small.w===900&&small.h===1200,JSON.stringify(small));

  // 显影输出尺寸 = 归一化后的尺寸
  await page.click('[data-action="process"]');
  await page.waitForSelector('.result-flow',{timeout:280000});
  const out=await page.evaluate(()=>{const ids=Object.keys(outputs);return outputs[ids[0]]?{w:outputs[ids[0]].width,h:outputs[ids[0]].height}:null;});
  check('显影输出长边 '+EXP_W,out&&out.w===EXP_W&&out.h===EXP_H,JSON.stringify(out));

  await page.screenshot({path:'/tmp/input-normalize.png'});
 }finally{
  await browser.close();server.close();
 }
 if(fails.length){console.error('FAIL:',fails.join('; '));process.exit(1);}
 console.log('INPUT NORMALIZE PASS');
})().catch(e=>{console.error('FAIL:',e.message||e);process.exit(1);});
