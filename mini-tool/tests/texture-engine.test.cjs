const {test}=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../minitool/texture-engine.js')._testing;
const optics=require('../minitool/texture-optics.js');
test('grain scale/gain inputs are optional, bounded and preserve legacy manual normalization',()=>{
 const api=require('../minitool/texture-engine.js'),legacy=api.normalize({grain:2});assert.equal(legacy.grainSize,undefined);assert.equal(legacy.grainAmountScale,undefined);
 assert.equal(api.normalize({grainSize:.1}).grainSize,.5);assert.equal(api.normalize({grainSize:9}).grainSize,4);assert.equal(api.normalize({grainSize:NaN}).grainSize,1);
 assert.equal(api.normalize({grainAmountScale:-1}).grainAmountScale,0);assert.equal(api.normalize({grainAmountScale:2}).grainAmountScale,1);assert.equal(api.normalize({grainAmountScale:NaN}).grainAmountScale,1);
 const scaled=api.normalize({grain:2,grainSize:.5,grainAmountScale:.5});assert.equal(scaled.grain,legacy.grain);assert.equal(scaled.grainFormatMm,legacy.grainFormatMm);assert.equal(scaled.grainSize,.5);assert.equal(scaled.grainAmountScale,.5);
});

test('Gold-style 8x8 LUT cube has correct red/green/blue axes, corners and interpolation',()=>{
 const pixels=new Uint8ClampedArray(512*512*4);
 for(let z=0;z<64;z++)for(let y=0;y<64;y++)for(let x=0;x<64;x++){
  const i=(((z>>3)*64+y)*512+(z%8)*64+x)*4;pixels[i]=Math.round(x*255/63);pixels[i+1]=Math.round(y*255/63);pixels[i+2]=Math.round(z*255/63);pixels[i+3]=255;
 }
 const table=engine.lutFromPixels(pixels,512,512),out=[];
 for(const point of [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[1,1,1],[.13,.71,.34]]){engine.sampleLUT(table,...point,out);for(let c=0;c<3;c++)assert.ok(Math.abs(out[c]-point[c])<=.5/255+1e-7);}
 assert.throws(()=>engine.lutFromPixels(pixels,511,512),/尺寸/);
});
test('palette zero preserves sRGB through linear Rec2020, final encoder and legal gamut',()=>{
 for(const rgb of [[0,0,0],[1,1,1],[1,0,0],[0,1,0],[0,0,1],[.2,.4,.7]]){
  const linear=[],bytes=new Uint8ClampedArray(4);engine.grade(...rgb,{tone:0,color:0},linear);engine.outputRGB(...linear,bytes,0);
  for(let c=0;c<3;c++)assert.ok(Math.abs(bytes[c]-Math.round(rgb[c]*255))<=1);assert.equal(bytes[3],255);
 }
 const bytes=new Uint8ClampedArray(4);engine.outputRGB(1.8,-.1,.1,bytes,0);assert.ok(bytes.every(Number.isFinite));assert.throws(()=>engine.outputRGB(NaN,0,0,bytes,0),/有限/);
});
test('nonlinear thin-light extraction precedes area lowpass and preserves its source energy',()=>{
 const h=new Float32Array([engine.highlight(1,1,1),0,0,0]),out=new Float32Array(1);engine.accumulate(h,4,1,0,0,4,1,out,1,1,1);
 assert.ok(out[0]>.2);assert.equal(engine.highlight(.25,.25,.25),0);
});
test('fractional-area reduction agrees with hand integrated source cells and tiled accumulation',()=>{
 const src=new Float32Array([1,0,0,0,0]),whole=new Float32Array(2),tiled=new Float32Array(2);
 engine.accumulate(src,5,1,0,0,5,1,whole,2,1,1);engine.accumulate(src.slice(0,2),2,1,0,0,5,1,tiled,2,1,1);engine.accumulate(src.slice(2),3,1,2,0,5,1,tiled,2,1,1);
 assert.ok(Math.abs(whole[0]-.4)<1e-7);assert.equal(whole[1],0);assert.deepEqual(whole,tiled);
 const dims=engine.fit(10000,10000,1152,1048576);assert.ok(dims.width*dims.height<=1048576);
});
test('Black Pro-Mist exposes the three-scale split and chromatic energies consumed by the engine',async()=>{
 const near=optics.components(100,'near'),far=optics.components(100,'far');assert.equal(near.length,1);assert.equal(far.length,2);
 assert.ok(Math.abs([...near,...far].reduce((sum,part)=>sum+part[1],0)-1)<1e-12);
 const a=await optics.kernel(40,32,100,'near'),b=await optics.kernel(40,32,100,'far');
 assert.deepEqual(a.nearEnergyRGB,b.nearEnergyRGB);assert.ok(a.nearEnergyRGB[0]<a.nearEnergyRGB[1]&&a.nearEnergyRGB[1]<a.nearEnergyRGB[2]);
 assert.equal(a.channels,null);assert.equal(b.channels.length,3);
 for(const k of [a,b])for(const plane of k.channels||[k.data])assert.ok(Math.abs(plane.reduce((x,y)=>x+y,0)-1)<1e-6);
});
test('CPU FFT follows direct reflected convolution including edge impulse and flat field',async()=>{
 const w=7,h=5,r=1,k={radius:r,data:new Float32Array([.03,.08,.03,.08,.56,.08,.03,.08,.03])};
 for(const probe of ['edge','flat']){
  const src=new Float32Array(w*h);if(probe==='edge')src[0]=1;else src.fill(.37);
  const out=await optics.convolveCPU(src,w,h,k),ref=new Float32Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let yy=-r;yy<=r;yy++)for(let xx=-r;xx<=r;xx++)ref[y*w+x]+=src[optics.mirror(y+yy,h)*w+optics.mirror(x+xx,w)]*k.data[(yy+r)*3+xx+r];
  const max=Math.max(...out.map((v,i)=>Math.abs(v-ref[i])));assert.ok(max<2e-7,'max='+max);
 }
});
test('cancelled optical work refuses output and does not commit partial kernel',async()=>{
 await assert.rejects(optics.kernel(64,64,5,'far',()=>true),/取消/);
 await assert.rejects(optics.convolveCPU(new Float32Array(32*32),32,32,{radius:1,data:new Float32Array(9).fill(1/9)},()=>true),/取消/);
});

test('Gold200 pure red/blue/green lights all produce a smooth finite highlight source',()=>{
 for(const rgb of [[255,25,51],[161,154,226],[199,226,199]]){const linear=[];engine.grade(...rgb.map(x=>x/255),{tone:0,color:0},linear);const source=engine.highlight(...linear);assert.ok(source>0&&Number.isFinite(source),JSON.stringify({rgb,source}));}
});
