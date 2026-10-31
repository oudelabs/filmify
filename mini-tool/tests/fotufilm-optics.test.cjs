const {test}=require('node:test');
const assert=require('node:assert/strict');
const optics=require('../minitool/texture-optics.js');
const sum=values=>values.reduce((a,b)=>a+b,0);
function close(actual,expected,tolerance=1e-7){assert.ok(Math.abs(actual-expected)<=tolerance,JSON.stringify({actual,expected,tolerance}));}

test('diffusion frozen profile matches actual upstream Swift Airy fit, not the removed exponential PSF',()=>{
 // Recorded by executing the unmodified DiffusionFilter.swift from
 // 73dff127f68e with Portra400/D65, f=43.266615 mm, pitch=.001 mm,
 // maximumSigmaPixels=100000000 (uncapped physical reference).
 const p=optics.profile('black_pro_mist');
 assert.deepEqual(p.sigmasMM,[.3649467,.887375,2.1576698]);
 const rows=[[.63833976,.2586419,.103018284],[.7857112,.085255876,.12903291],[.90660024,0,.09339979]];
 for(let c=0;c<3;c++)for(let j=0;j<3;j++)close(p.weights[c][j],rows[c][j],5e-8);
 assert.deepEqual(p.recordWavelengthsNM,[628.13556,530.82385,440.1341]);
 assert.equal(p.source,'fotufilm');
 close(p.truncatedShare,.03464085);
 const g=optics.profile('glimmerglass');assert.deepEqual(g.sigmasMM,[.12512457,.30424285,.7397725]);
 assert.ok(g.sigmasMM[2]<p.sigmasMM[2]);
 const cine=optics.profile('cinebloom');assert.equal(cine.source,'filmify-creative-adaptation');assert.equal(cine.particleRadiusUM,8);assert.ok(cine.sigmasMM[2]>p.sigmasMM[2]);
});

test('upstream grade transmission conserves beam energy and keeps direct detail distinct from scatter',()=>{
 for(const [grade,load] of [[.125,.05],[.25,.1],[.5,.19],[1,.32],[2,.5]]){
  for(const id of ['black_pro_mist','pro_mist','glimmerglass']){
   const t=optics.transport(1,id,grade);close(t.interactedFraction,load);close(t.directShare,1-load);close(t.directShare+t.scatteredShare+t.absorbedShare,1);close(t.totalTransmission,t.directShare+t.scatteredShare);
   close(optics.scatterAmount(1,id,grade),t.scatteredShare/t.totalTransmission);
  }
 }
 close(optics.transport(1,'black_pro_mist',.5).scatteredShare,.057);
 close(optics.transport(1,'pro_mist',.5).scatteredShare,.1805);
 for(const [grade,load] of [[.25,.05],[.5,.1],[1,.2]])close(optics.transport(1,'cinebloom',grade).interactedFraction,load);
 assert.deepEqual(optics.transport(0,'pro_mist',2),{interactedFraction:0,directShare:1,scatteredShare:0,absorbedShare:0,totalTransmission:1});
 assert.equal(optics.scatterAmount(0,'cinebloom',1),0);
});

test('millimetres, focal length and pixel pitch determine width without changing grade or spectral energy',()=>{
 const p=optics.profile('pro_mist'),a=optics.components(100,'all',0,'pro_mist'),b=optics.components(200,'all',0,'pro_mist'),c=optics.components(200,'all',0,'pro_mist',false,p.focalLengthMM*2);
 for(let i=0;i<3;i++){close(a[i][0]/b[i][0],2);close(a[i][0],c[i][0]);close(a[i][1],b[i][1]);}
 assert.throws(()=>optics.components(0,'near'),/间距/);assert.throws(()=>optics.profile('pro_mist',false,0),/焦距/);
 // The same normal-angle geometry may be supplied for every virtual gauge.
 // This checks all nine frame heights, rather than assuming a 35mm long edge.
 for(const [width,height] of [[36,24],[56,56],[120,95],[5.79,4],[12.5,7.4],[24.9,18.7],[62,46],[62,62],[99,62]]){
  const focal=Math.hypot(width,height),pitch=height*1000/1000,parts=optics.components(pitch,'all',1,'pro_mist',false,focal);
  close(parts[0][0],p.sigmasMM[0]*focal/p.focalLengthMM*1000/pitch);
 }
});

test('near and far kernels reassemble exactly the complete normalized three-Gaussian PSF per channel',async()=>{
 for(const id of ['black_pro_mist','glimmerglass','pro_mist','cinebloom']){
  const near=await optics.kernel(40,32,500,'near',null,id),far=await optics.kernel(40,32,500,'far',null,id),all=await optics.kernel(40,32,500,'all',null,id);
  assert.equal(near.channels,null);assert.ok(far.channels&&all.channels);assert.deepEqual(near.nearEnergyRGB,far.nearEnergyRGB);
  const N=all.radius*2+1,F=far.radius*2+1,Q=near.radius*2+1;
  for(let ch=0;ch<3;ch++){
   close(sum(all.channels[ch]),1,1e-6);close(sum(far.channels[ch]),1,1e-6);close(sum(near.data),1,1e-6);
   close(near.energyRGB[ch]+far.energyRGB[ch],1,1e-12);
   for(let y=-all.radius;y<=all.radius;y++)for(let x=-all.radius;x<=all.radius;x++){
    const ni=Math.abs(x)<=near.radius&&Math.abs(y)<=near.radius?near.data[(y+near.radius)*Q+x+near.radius]:0;
    const fi=Math.abs(x)<=far.radius&&Math.abs(y)<=far.radius?far.channels[ch][(y+far.radius)*F+x+far.radius]:0;
    close(near.nearEnergyRGB[ch]*ni+(1-near.nearEnergyRGB[ch])*fi,all.channels[ch][(y+all.radius)*N+x+all.radius],6e-8);
   }
  }
 }
});

test('monochrome kernels use shared neutral transport at every scale',async()=>{
 const p=optics.profile('pro_mist',true);assert.equal(p.nearEnergyRGB[0],p.nearEnergyRGB[1]);assert.equal(p.nearEnergyRGB[1],p.nearEnergyRGB[2]);
 for(const group of ['near','far','all']){const k=await optics.kernel(40,32,500,group,null,'pro_mist',true);assert.equal(k.channels,null);assert.equal(k.planes.length,1);close(sum(k.data),1,1e-6);assert.equal(k.energyRGB[0],k.energyRGB[1]);assert.equal(k.energyRGB[1],k.energyRGB[2]);}
});

test('linear direct-plus-scatter reaches black receivers and exposure compensation leaves a flat field unchanged',async()=>{
 const w=9,h=7,k=await optics.kernel(w,h,2000,'all',null,'pro_mist',true),backend=optics.createBackend(true),t=optics.transport(1,'pro_mist',.5);
 try{
  const flat=new Float32Array(w*h*3).fill(.37),blurred=await backend.convolveRGB(flat,w,h,k);
  for(let i=0;i<flat.length;i++)close((t.directShare*flat[i]+t.scatteredShare*blurred[i])/t.totalTransmission,.37,2e-7);
  const lamp=new Float32Array(w*h);lamp[3*w+4]=1;const glow=await optics.convolveCPU(lamp,w,h,k);
  assert.ok(glow[3*w+5]>0);assert.ok(t.scatteredShare*glow[3*w+5]>0);assert.ok(glow.every(Number.isFinite));
  let max=0;const side=k.radius*2+1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   let direct=0;for(let yy=-k.radius;yy<=k.radius;yy++)for(let xx=-k.radius;xx<=k.radius;xx++)direct+=lamp[optics.mirror(y+yy,h)*w+optics.mirror(x+xx,w)]*k.data[(yy+k.radius)*side+xx+k.radius];
   max=Math.max(max,Math.abs(glow[y*w+x]-direct));
  }
  assert.ok(max<2e-7,'FFT/direct error '+max);
 }finally{backend.release();}
 await assert.rejects(backend.convolve(new Float32Array(w*h),w,h,k),/取消/);
});

test('cancellation rejects before partial kernels or released backend output are reused',async()=>{
 await assert.rejects(optics.kernel(97,73,100,'far',()=>true,'glimmerglass'),/取消/);
 let checks=0;await assert.rejects(optics.kernel(99,71,101,'far',()=>++checks>3,'glimmerglass'),/取消/);
 const complete=await optics.kernel(99,71,101,'far',null,'glimmerglass');for(const plane of complete.channels)close(sum(plane),1,1e-6);
});
