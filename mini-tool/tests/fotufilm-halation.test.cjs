'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const data=require('../minitool/halation-data.js'),halo=require('../minitool/texture-halation.js'),optics=require('../minitool/texture-optics.js');
test('frozen native Legacy return matrices and three-scale kernels retain their physical contracts',()=>{
 assert.equal(data.upstreamRevision,'73dff127f68e8ae21ce1626cd654d79138c37e1f');assert.equal(Object.keys(data.formats).length,9);
 for(const [id,gauge] of Object.entries(data.formats)){
  const g=halo.geometry({opticsFormatId:id});assert.equal(Math.fround(g.frameHeightMm),gauge.frameHeightMM);
  assert.ok(g.focalLengthMm>g.frameHeightMm);
  for(const p of gauge.levels){
   assert.equal(p.sigmaMM.length,3);assert.ok(p.sigmaMM[0]>0&&p.sigmaMM[0]<p.sigmaMM[1]&&p.sigmaMM[1]<p.sigmaMM[2]);
   p.weights.forEach(row=>assert.ok(Math.abs(row.reduce((a,b)=>a+b,0)-1)<1e-6));
   p.matrix.forEach((row,c)=>assert.ok(Math.abs(row.reduce((a,b)=>a+b,0)-p.mix[c])<1e-7));
   assert.ok(Math.abs(p.mix[0]-p.redReturn/(1+p.redReturn))<1e-7);
  }
 }
});
test('finished-photo light carry preserves flat fields, reaches black surroundings and stays neutral for monochrome',async()=>{
 const w=81,h=61,back=optics.createBackend(true),settings={opticsFormatId:'35mm',halation:2};
 try{
  const flat=new Float32Array(w*h).fill(.8),zero=await halo.build(flat,w,h,settings,back);
  assert.ok(zero.every(v=>v===0));
  const lamp=new Float32Array(w*h);lamp[Math.floor(h/2)*w+Math.floor(w/2)]=1;
  const colour=await halo.build(lamp,w,h,settings,back),neutral=await halo.build(lamp,w,h,Object.assign({},settings,{halationNeutral:true}),back);
  let lit=0;for(let i=0;i<w*h;i++){
   assert.ok(Number.isFinite(colour[i*3])&&colour[i*3]>=0);
   assert.equal(neutral[i*3],neutral[i*3+1]);assert.equal(neutral[i*3],neutral[i*3+2]);
   if(!lamp[i]&&colour[i*3]>1e-8)lit++;
  }
  assert.ok(lit>0,'additive source-derived return reaches genuinely black receiver pixels');
  const broad=new Float32Array(w*h);for(let y=0;y<h/2;y++)for(let x=0;x<w/2;x++)broad[y*w+x]=1;
  const corner=await halo.build(broad,w,h,settings,back);assert.ok(corner.every(v=>Number.isFinite(v)));
 }finally{back.release();}
});
test('halation cancellation rejects without a reusable partial field',async()=>{
 const back=optics.createBackend(true);try{await assert.rejects(halo.build(new Float32Array(80),10,8,{halation:3},back,()=>true),/取消/);}finally{back.release();}
});
