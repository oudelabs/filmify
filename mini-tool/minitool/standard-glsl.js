/* Fotufilm Standard (.clumpField), fixed revision 54064ece.
 * Port of Stages/Random.h, Stages/Grain.h and Schedule/Cpu.h.
 * Apache-2.0, MUAStudio Inc. The JPG material response/carry is injected from
 * FilmifyGrainMaterial; this module does not replace that response with noise.
 * Full-quality seeded draws only: no quantile table, atlas or half storage. */
'use strict';
(function(root){
 const f=Math.fround,REVISION='54064ece98223b5aa0d24e1f4d93c08d8cb29484';
 const vertex='#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
 const header=`#version 300 es
precision highp float;precision highp int;
uniform ivec2 uStdFrameSize,uStdOrigin;
out vec4 color;
`;
 const noiseCore=`
uniform uint uStdSeed;
uniform float uStdLambda,uStdPoissonLimit,uStdPoissonSD,uStdOwnGain,uStdSharedGain;
uniform bool uStdMonochrome;
uint standardPCG(uint value){
 uint state=value*747796405u+2891336453u;
 uint word=((state>>((state>>28u)+4u))^state)*277803737u;
 return (word>>22u)^word;
}
uint standardPixelHash(ivec2 p,uint layer){return standardPCG(uint(p.x)^standardPCG(uint(p.y)^standardPCG(uStdSeed^(layer*0x9e3779b9u))));}
float standardNormal(uint hash){
 uint hash2=standardPCG(hash);
 float u1=float(hash>>8u)*(1./16777216.)+1.e-7;
 float u2=float(hash2>>8u)*(1./16777216.);
 return sqrt(-2.*log(u1))*cos(6.283185482025146484375*u2);
}
float standardPoisson(ivec2 p,uint layer){
 uint hash=standardPixelHash(p,layer);
 if(uStdLambda>=16.)return standardNormal(hash);
 float product=1.;int trials=0;
 for(int i=0;i<32;i++){
  // The remaining hash draws are local and cannot affect another pixel or
  // layer. Stop at the same threshold as StandardCPU instead of hashing all
  // 32 iterations after this sample is already complete.
  if(product<=uStdPoissonLimit)break;
  hash=standardPCG(hash);
  float uniformDraw=float(hash>>8u)*(1./16777216.);
  product=product*uniformDraw;trials++;
 }
 return (float(max(trials-1,0))-uStdLambda)/uStdPoissonSD;
}
vec3 standardNoise(ivec2 p){
 if(any(lessThan(p,ivec2(0)))||any(greaterThanEqual(p,uStdFrameSize)))return vec3(0.);
 if(uStdMonochrome)return vec3(standardNormal(standardPixelHash(p,3u)));
 float shared=standardPoisson(p,3u);
 vec3 own=vec3(standardPoisson(p,0u),standardPoisson(p,1u),standardPoisson(p,2u));
 return uStdOwnGain*own+uStdSharedGain*vec3(shared);
}
`;
 const noiseFragment=header+noiseCore+`
void main(){ivec2 p=uStdOrigin+ivec2(gl_FragCoord.xy);color=vec4(standardNoise(p),1.);}
`;
 function radiusValue(radius){if(!Number.isInteger(radius)||radius<0)throw new Error('Standard radius must be a nonnegative integer');return radius;}
 function gaussianCore(radius,vertical){
  radius=radiusValue(radius);
  return `
uniform highp sampler2D uStdInput;
uniform ivec2 uStdInputOrigin;
uniform vec3 uStdKernel[${radius*2+1}];
vec3 standardGaussian(ivec2 p){
 vec3 sum=vec3(0.),weight=vec3(0.);
 for(int k=-${radius};k<=${radius};k++){
  ivec2 tap=p+ivec2(${vertical?'0,k':'k,0'});
  bool valid=all(greaterThanEqual(tap,ivec2(0)))&&all(lessThan(tap,uStdFrameSize));
  vec3 w=uStdKernel[k+${radius}];
  if(valid){sum=sum+texelFetch(uStdInput,tap-uStdInputOrigin,0).rgb*w;weight=weight+w;}
 }
 return sum/max(weight,vec3(1.e-12));
}
`;
 }
 function horizontalFragment(radius){return header+gaussianCore(radius,false)+`
void main(){ivec2 p=uStdOrigin+ivec2(gl_FragCoord.xy);color=vec4(standardGaussian(p),1.);}
`;}
 const modulationCore=`
uniform bool uStdNeutral;
uniform vec3 uStdStrength,uStdDMin,uStdDensityRange,uStdAnchor,uStdFog;
uniform vec3 uStdAmplitude,uStdToe,uStdDecay,uStdHump,uStdHumpDensity,uStdHumpWidth;
uniform vec2 uStdReversalProfile;
uniform float uStdDensityLaw;
float standardDyeVariance(float density,int ch){
 float offset=(density-uStdHumpDensity[ch])/max(uStdHumpWidth[ch],1.e-4);
 return (1.-exp(-density/max(uStdToe[ch],1.e-4)))
  *(1.+uStdAmplitude[ch]*exp(-density/max(uStdDecay[ch],1.e-4))
    +uStdHump[ch]*exp(-.5*offset*offset));
}
float standardSilverVariance(float density){return density*pow(10.,.21004*density+.06114*density*density);}
float standardReversalVariance(float density){float power=pow(density/max(uStdReversalProfile.y,1.e-4),2.*uStdReversalProfile.x);return power/(1.+power);}
float standardDensityModulation(float density,int ch){
 float range=uStdDensityRange[ch];
 float amount=clamp((density-uStdDMin[ch])/range,0.,1.);
 float net=amount*range;
 float here=max(net,0.)+uStdFog[ch],anchor=max(uStdAnchor[ch]+uStdFog[ch],1.e-4),ratio;
 if(uStdDensityLaw>2.5)ratio=standardReversalVariance(here)/max(standardReversalVariance(anchor),1.e-20);
 else if(uStdDensityLaw>1.5)ratio=here/anchor;
 else if(uStdDensityLaw>.5)ratio=standardSilverVariance(here)/max(standardSilverVariance(anchor),1.e-6);
 else ratio=standardDyeVariance(here,ch)/max(standardDyeVariance(anchor,ch),1.e-6);
 return sqrt(max(ratio,0.));
}
vec3 standardDelta(vec3 density,vec3 field){
 vec3 modulation=vec3(standardDensityModulation(density.r,0),standardDensityModulation(density.g,1),standardDensityModulation(density.b,2));
 vec3 clump=uStdStrength*modulation*field;
 // Graph/Frame stores developed density in Float32 before texture carry
 // subtracts D0. Preserve that numerical boundary, including zero signals.
 vec3 developed=density+clump;
 vec3 delta=developed-density;return uStdNeutral?vec3(delta.g):delta;
}
`;
 function finalFragment(radius,materialGLSL,linear){
  if(typeof materialGLSL!=='string'||!materialGLSL.includes('void nativeMaterial(')||!materialGLSL.includes('vec3 nativeCarry('))throw new Error('Full JPG native material response and carry must be supplied');
  return header+`
uniform sampler2D uImage;
uniform bool uStdEnabled;
`+materialGLSL+gaussianCore(radius,true)+modulationCore+`
void main(){
 ivec2 q=ivec2(gl_FragCoord.xy);vec4 base=texelFetch(uImage,q,0);
 if(!uStdEnabled){color=base;return;}
 ivec2 p=uStdOrigin+q;vec3 density,linear2020;${linear?"linear2020=base.rgb;nativeMaterialLinear(linear2020,density);":"nativeMaterial(base.rgb,density,linear2020);"}
 vec3 delta=standardDelta(density,standardGaussian(p));
 color=vec4(${linear?"nativeCarryLinear":"nativeCarry"}(linear2020,delta),base.a);
}
`;
 }
 function list(value,count,name){if(!value||value.length!==count||Array.from(value).some(v=>!Number.isFinite(Number(v))))throw new Error('Invalid Standard '+name);return Float32Array.from(value);}
 function kernelWeights(config){
  const radius=radiusValue(config.radius),sigma=list(config.sigmaLayer,3,'sigmaLayer'),weights=new Float32Array((2*radius+1)*3);
  for(let ch=0;ch<3;ch++){
   const s=sigma[ch],denominator=f(f(2*s)*s);let total=f(0);
   for(let k=-radius;k<=radius;k++){const value=f(Math.exp(f(f(-k*k)/denominator)));weights[(k+radius)*3+ch]=value;total=f(total+value);}
   if(config.normalizedKernel)for(let k=0;k<radius*2+1;k++)weights[k*3+ch]=f(weights[k*3+ch]/total);
  }
  return weights;
 }
 function parameters(config,seed){
  if(!config||Number(config.grainMode)!==0)throw new Error('Standard requires native grainMode 0');
  if(config.mottleStrength&&Array.from(config.mottleStrength).some(x=>Number(x)!==0)||config.mottleEnabled)throw new Error('This Standard texture path requires the native texture-stage mottle coefficients to be zero');
  const records=config.densityRecords;if(!records||records.length!==3)throw new Error('Standard requires three native density records');
  const recordColumns=[];for(let j=0;j<6;j++)recordColumns[j]=list(records.map(row=>row&&row[j]),3,'densityRecords');
  const lambda=f(config.lambda),rho=f(Math.max(0,Math.min(1,config.correlation)));
  if(!Number.isFinite(lambda)||lambda<0||!Number.isFinite(rho))throw new Error('Invalid Standard sampling configuration');
  const width=config.sourceWidth,height=config.sourceHeight;if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw new Error('Standard requires the complete source-frame dimensions');
  return {
   frameSize:new Int32Array([width,height]),seed:(seed===undefined?1:seed)>>>0,
   lambda,poissonLimit:f(Math.exp(f(-lambda))),poissonSD:f(Math.sqrt(Math.max(lambda,f(1.e-4)))),
   ownGain:f(Math.sqrt(f(1-rho))),sharedGain:f(Math.sqrt(rho)),monochrome:!!config.monochrome,neutral:!!config.neutral,
   radius:radiusValue(config.radius),kernel:kernelWeights(config),strength:list(config.grainStrength,3,'grainStrength'),
   dMin:list(config.dMin,3,'dMin'),densityRange:list(config.densityRange,3,'densityRange'),anchor:list(config.anchor,3,'anchor'),fog:list(config.fog,3,'fog'),
   amplitude:recordColumns[0],toe:recordColumns[1],decay:recordColumns[2],hump:recordColumns[3],humpDensity:recordColumns[4],humpWidth:recordColumns[5],
   reversalProfile:list(config.reversalProfile||[.7,1],2,'reversalProfile'),densityLaw:f(config.grainLaw)
  };
 }
 const api={revision:REVISION,version:'fotufilm-standard-glsl-1',vertex,noiseFragment,horizontalFragment,finalFragment,kernelWeights,parameters};
 root.FilmifyStandardGLSL=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:typeof global!=='undefined'?global:{});
