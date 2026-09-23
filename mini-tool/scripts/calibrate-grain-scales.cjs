// Attach native physical-scale corrections without changing the 8um reference.
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'..'),input=process.argv[2],output=process.argv[3]||path.join(ROOT,'styles/grain-stats.js');
const measured=JSON.parse(fs.readFileSync(input,'utf8')),ctx={window:{}};vm.runInNewContext(fs.readFileSync(path.join(ROOT,'styles/grain-stats.js'),'utf8'),ctx);
const stats=ctx.window.FILMIFY_GRAIN_STATS,{fitStock}=require('./grain-kernel-fit.cjs');
if(measured.reference!=='6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507')throw Error('Unexpected native reference');
if(Object.keys(measured.stocks).length!==Object.keys(stats).filter(k=>stats[k]).length)throw Error('Incomplete native scale calibration');
for(const [key,rows] of Object.entries(measured.stocks)){
 const base=stats[key],ref=rows.find(r=>r.um===8);if(!ref)throw Error('Missing 8um reference');
 if(!base||rows.length<2||rows.some((r,i)=>!Number.isFinite(r.um)||r.um<=0||(i&&r.um<=rows[i-1].um)||r.rms.length!==base.t.length||r.rms.some(cs=>cs.length!==base.channels||cs.some(x=>!Number.isFinite(x)||x<=0))||(r.t&&JSON.stringify(r.t)!==JSON.stringify(base.t))))throw Error('Invalid calibration grid: '+key);
 base.physicalScales=rows.map(row=>{
  const anchor=row.um===8,fit=anchor?base:fitStock(row);
  return {um:row.um,rmsScale:row.rms.map((cs,i)=>cs.map((v,c)=>anchor?1:v*row.um/(ref.rms[i][c]*8))),kern:fit.kern,skewL:fit.skewL};
 });
 console.log('Fitted native scales',key);
}
fs.writeFileSync(output,'window.FILMIFY_GRAIN_STATS='+JSON.stringify(stats,(_k,v)=>typeof v==='number'&&!Number.isInteger(v)?Math.round(v*1e6)/1e6:v)+';\n');
