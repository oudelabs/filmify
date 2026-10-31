/* Fotufilm 73dff127 Legacy return geometry, adapted to finished SDR photographs.
 * Apache-2.0 upstream algorithm; Portra 400 profile CC BY-SA 4.0.
 * Native three-scale kernels/matrix are frozen by freeze-fotufilm-halation.py.
 * The compact light-source mask and positive-only, highlight-protected RGB
 * carry are Filmify adaptations. This does not re-develop a RAW or reproduce
 * the native spectral exposure/development pipeline. All LUTs share this
 * reference material; their source colour tables are untouched.
 */
(function(root){
 'use strict';
 const FRAME={
  '35mm':[24,36], '120':[56,56], '4x5':[95,120],
  super8:[4,4*5.79/4.01], '16mm':[7.4,12.5], super35:[18.7,24.9],
  instaxmini:[46,62], instaxsquare:[62,62], instaxwide:[62,99]
 };
 const TO2020=[.6274039149284363,.3292830288410187,.04331306740641594,.06909728795289993,.9195404052734375,.011362316086888313,.016391439363360405,.08801330626010895,.8955952525138855];
 function geometry(s){
  s=s||{};let id=s.opticsFormatId;
  if(!FRAME[id]){
   const mm=s.opticsFormatMm||35;
   id=mm===60?'120':mm===120?'4x5':mm===5.79?'super8':mm===12.5?'16mm':mm===24.9?'super35':mm===99?'instaxwide':mm===62?(s.grainFrameHeightMm===46?'instaxmini':'instaxsquare'):'35mm';
  }
  const frame=FRAME[id];
  return {id,frameHeightMm:frame[0],focalLengthMm:Math.hypot(frame[0],frame[1])};
 }
 function profile(s){
  const g=geometry(s),level=Math.max(0,Math.min(3,Math.round(Number(s.halation)||0)));
  return level?root.FilmifyHalationData.formats[g.id].levels[level-1]:null;
 }
 function cancelled(check){if(check&&check())throw new Error('已取消');}
 // Keep direct lamp cores and broad bright surfaces out of the additive
 // carry. The source mask is evaluated before field reduction in the engine.
 async function build(source,w,h,s,backend,check){
  cancelled(check);const g=geometry(s),p=profile(s),out=new Float32Array(w*h*3);
  if(!p)return out;
  const pitch=g.frameHeightMm/Math.max(1,Math.min(w,h));
  const context=await backend.gaussian(source,w,h,Math.max(.8,.84/pitch),check);
  const local=await backend.gaussian(source,w,h,Math.max(.35,.20/pitch),check);
  cancelled(check);const compact=new Float32Array(w*h);
  for(let i=0;i<compact.length;i++){
   const ratio=source[i]/(context[i]+1e-6),t=Math.max(0,Math.min(1,(ratio-1.25)/2.75)),concentration=local[i]/(context[i]+1e-6),q=Math.max(0,Math.min(1,(concentration-1.15)/2));
   // A broad white corner has almost the same occupancy at both scales;
   // a compact light grows markedly more prominent at the smaller scale.
   compact[i]=source[i]*t*t*(3-2*t)*q*q*(3-2*q);
  }
  const blurred=[];
  for(const mm of p.sigmaMM){
   blurred.push(await backend.gaussian(compact,w,h,mm/pitch,check));cancelled(check);
  }
  const coefficients=p.matrix.map(row=>[0,1,2].map(scale=>row.reduce((sum,value,record)=>sum+value*p.weights[record][scale],0))),mixes=p.matrix.map(row=>row.reduce((sum,value)=>sum+value,0)),rgb=[0,0,0];
  for(let i=0;i<compact.length;i++){
   for(let c=0;c<3;c++){const a=coefficients[c];rgb[c]=Math.max(0,a[0]*blurred[0][i]+a[1]*blurred[1][i]+a[2]*blurred[2][i]-mixes[c]*compact[i]);}
   // The source is achromatic; the native return matrix supplies the stock's
   // red/green balance. Here record axes are an explicit RGB approximation.
   // Neutral recipes retain their original toned LUT, with neutral added light.
   if(s.halationNeutral){const y=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];out[i*3]=out[i*3+1]=out[i*3+2]=y;}
   else for(let c=0;c<3;c++)out[i*3+c]=TO2020[c*3]*rgb[0]+TO2020[c*3+1]*rgb[1]+TO2020[c*3+2]*rgb[2];
   if((i&4095)===4095){await new Promise(resolve=>{if(typeof filmifyScheduleTask==='function')filmifyScheduleTask(resolve);else setTimeout(resolve,0);});cancelled(check);}
  }
  cancelled(check);return out;
 }
 root.FilmifyTextureHalation={version:'fotufilm-legacy-sdr-73dff127-1',geometry,profile,build};
 if(typeof module==='object'&&module.exports)module.exports=root.FilmifyTextureHalation;
})(typeof window==='object'?window:global);
