'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),optics=require('../minitool/texture-optics.js');
const error=(a,b)=>a.reduce((m,v,i)=>Math.max(m,Math.abs(v-b[i])),0);
function direct(source,w,h,axes){
 const reflect=(i,n)=>{if(n<=1)return 0;const period=axes.halfMirror?2*n:2*n-2,q=((i%period)+period)%period;return Math.min(q,period-q-(axes.halfMirror?1:0));},out=new Float32Array(w*h*3);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let ch=0;ch<3;ch++){
  let total=0;for(let yy=-axes.y.radius;yy<=axes.y.radius;yy++)for(let xx=-axes.x.radius;xx<=axes.x.radius;xx++)total+=source[(reflect(y+yy,h)*w+reflect(x+xx,w))*3+ch]*axes.x.data[xx+axes.x.radius]*axes.y.data[yy+axes.y.radius];
  out[(y*w+x)*3+ch]=total;
 }return out;
}
test('area Gaussian separable CPU retains full existing 2D near PSF rather than narrowing it',async()=>{
 const w=17,h=13,source=Float32Array.from({length:w*h*3},(_,i)=>.35+1.2*Math.sin(i*.31)),k=await optics.kernel(w,h,200,'near',null,'cinebloom'),backend=optics.createBackend(true);
 try{const a=await backend.gaussianRGB(source,w,h,k),b=await backend.convolveRGB(source,w,h,k);assert.ok(error(a,b)<3e-7);const axis=optics.gaussianAxis(k.sigmasPixels[0]);assert.equal(axis.radius,k.radius);assert.ok(Math.abs(axis.data.reduce((a,b)=>a+b,0)-1)<1e-7);}finally{backend.release();}
});
test('anisotropic near Gaussian preserves signed HDR channels and both explicit edge rules',async()=>{
 for(const [w,h] of [[11,7],[1,17],[19,1]])for(const halfMirror of [false,true]){
  const source=Float32Array.from({length:w*h*3},(_,i)=>-.3+((i*37)%97)/31),axes={x:optics.gaussianAxis(1.7),y:optics.gaussianAxis(2.3),halfMirror};
  const actual=await optics.gaussianRGBCPU(source,w,h,axes),expected=direct(source,w,h,axes);assert.ok(error(actual,expected)<3e-7,w+'x'+h+'/'+halfMirror);
  const rgba=new Float32Array(w*h*4);rgba.channels=4;for(let i=0;i<w*h;i++)rgba.set(source.subarray(i*3,i*3+3),i*4);assert.equal(error(actual,await optics.gaussianRGBCPU(rgba,w,h,axes)),0);
 }
});
test('near Gaussian cancellation and release never publish partial output',async()=>{
 const backend=optics.createBackend(true),source=new Float32Array(97*73*3),axis=optics.gaussianAxis(8);
 await assert.rejects(backend.gaussianRGB(source,97,73,axis,()=>true),/已取消/);
 backend.release();await assert.rejects(backend.gaussianRGB(source,97,73,axis),/已取消/);
});

function reduceEndpoints(source,w,h,nw,nh){
 const out=new Float32Array(nw*nh*3),sx=nw/w,sy=nh/h;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const xa=x*sx,xb=(x+1)*sx,ya=y*sy,yb=(y+1)*sy,endpoint=(x===0||x===w-1?.5:1)*(y===0||y===h-1?.5:1);
  for(let yy=Math.floor(ya);yy<Math.min(nh,Math.ceil(yb));yy++)for(let xx=Math.floor(xa);xx<Math.min(nw,Math.ceil(xb));xx++){
   const weight=Math.max(0,Math.min(xb,xx+1)-Math.max(xa,xx))*Math.max(0,Math.min(yb,yy+1)-Math.max(ya,yy))*endpoint,d=(yy*nw+xx)*3,s=(y*w+x)*3;
   for(let ch=0;ch<3;ch++)out[d+ch]+=source[s+ch]*weight;
  }
 }return out;
}
function sample(field,w,h,x,y,sw,sh,ch){
 const qx=Math.max(0,Math.min(w-1,(x+.5)*w/sw-.5)),qy=Math.max(0,Math.min(h-1,(y+.5)*h/sh-.5)),ix=Math.floor(qx),iy=Math.floor(qy),jx=Math.min(w-1,ix+1),jy=Math.min(h-1,iy+1),fx=qx-ix,fy=qy-iy;
 return (field[(iy*w+ix)*3+ch]*(1-fx)+field[(iy*w+jx)*3+ch]*fx)*(1-fy)+(field[(jy*w+ix)*3+ch]*(1-fx)+field[(jy*w+jx)*3+ch]*fx)*fy;
}
const encode=x=>Math.round(255*(x<=.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-.055));
test('reduced near field endpoint quadrature preserves flat RGB and high-grade one-pixel edges/corners',async()=>{
 // Deliberately include a lamp on the first/last pixel: a plain area average
 // followed by half-mirror convolution doubles these endpoints' mirror mass.
 // This verifies representative approximations, not a universal error bound.
 const w=257,h=193,sigma=32,nw=129,nh=97,axes={x:optics.gaussianAxis(sigma*nw/w),y:optics.gaussianAxis(sigma*nh/h),halfMirror:true},full=optics.gaussianAxis(sigma),energies=[.6383398,.7857112,.9066002];
 for(const shape of ['flat','left-line','right-line','top-line','corner','edge-two','checker','step']){
  const source=new Float32Array(w*h*3);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const value=shape==='flat'?.37:shape==='left-line'?(x===0?1:0):shape==='right-line'?(x===w-1?1:0):shape==='top-line'?(y===0?1:0):shape==='corner'?(x<2&&y<2?1:0):shape==='edge-two'?(x<2||y>=h-2?1:0):shape==='checker'?((x+y)%2):x<w/2?1:0;
   const i=(y*w+x)*3;source[i]=value;source[i+1]=value*.73;source[i+2]=value*.47;
  }
  const exact=await optics.gaussianRGBCPU(source,w,h,full),weighted=reduceEndpoints(source,w,h,nw,nh),reduced=await optics.gaussianRGBCPU(weighted,nw,nh,axes);await optics.normalizeNearField(reduced,nw,nh,w,h,axes);
  let maximum=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let ch=0;ch<3;ch++){
   const index=(y*w+x)*3+ch,weight=.49*energies[ch],a=encode((1-.49)*source[index]+weight*exact[index]),b=encode((1-.49)*source[index]+weight*sample(reduced,nw,nh,x,y,w,h,ch));maximum=Math.max(maximum,Math.abs(a-b));
  }
  assert.ok(maximum<=1,shape+' max RGB8 error '+maximum);
  if(shape==='flat')for(let i=0;i<reduced.length;i++)assert.ok(Math.abs(reduced[i]-.37*[1,.73,.47][i%3])<1e-6);
 }
});
