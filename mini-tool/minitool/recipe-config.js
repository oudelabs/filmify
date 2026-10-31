/* Finished-photo recipes. The stock LUT remains encoded-sRGB in/out.
 * Virtual film format scales optical diffusion and grain, not image crop.
 * Filter strengths and shapes follow Fotufilm 73dff127; these are
 * model adaptations, not measured guarantees for commercial glass.
 */
(function(root){
 'use strict';
 const formats=[
  {id:'35mm',name:'35 mm',mm:35,modelLabel:'35 mm',detail:'颗粒与柔光均衡'},
  {id:'120',name:'120 · 6×6',mm:60,modelLabel:'120 · 6×6',detail:'细颗粒 · 柔光收敛'},
  {id:'4x5',name:'4×5',mm:120,modelLabel:'4×5',detail:'细颗粒 · 柔光克制'},
  {id:'super8',name:'Super 8',mm:5.79,frameHeightMm:4,modelLabel:'Super 8',detail:'粗颗粒 · 宽广柔光'},
  {id:'16mm',name:'Super 16',mm:12.5,frameHeightMm:7.4,modelLabel:'Super 16',detail:'明显颗粒 · 充盈柔光'},
  {id:'super35',name:'Super 35',mm:24.9,frameHeightMm:18.7,modelLabel:'Super 35',detail:'颗粒与柔光更鲜明'},
  {id:'instaxmini',name:'instax mini',mm:62,frameHeightMm:46,modelLabel:'instax mini',detail:'细颗粒 · 柔光适中'},
  {id:'instaxsquare',name:'instax SQUARE',mm:62,frameHeightMm:62,modelLabel:'instax SQUARE',detail:'更细颗粒 · 柔光适中'},
  {id:'instaxwide',name:'instax wide',mm:99,frameHeightMm:62,modelLabel:'instax wide',detail:'更细颗粒 · 柔光集中'}
 ];
 const formatOrder=[3,4,5,0,6,1,7,8,2];
 const grades=(ids,strengths)=>ids.map((id,i)=>({id,label:id,name:id,strength:strengths[i]}));
 const mistGrades=()=>grades(['1/8','1/4','1/2','1','2'],[.125,.25,.5,1,2]);
 const filters=[
  {id:'none',name:'不使用',modelName:'不使用',model:'black_pro_mist',strength:0,grades:[],defaultGrade:null,detail:'保留质感'},
  {id:'black_pro_mist',name:'黑柔',modelName:'Black Pro-Mist',model:'black_pro_mist',strength:.5,grades:mistGrades(),defaultGrade:'1/2',detail:'柔化亮边'},
  {id:'glimmerglass',name:'微光',modelName:'Glimmerglass',model:'glimmerglass',strength:1,grades:grades(['1/4','1/2','1','2'],[.25,.5,1,2]),defaultGrade:'1',detail:'柔和肤质'},
  {id:'pro_mist',name:'Pro-Mist',modelName:'Pro-Mist',model:'pro_mist',strength:.5,grades:mistGrades(),defaultGrade:'1/2',detail:'扩散高光'},
  {id:'cinebloom',name:'CineBloom',modelName:'CineBloom',model:'cinebloom',strength:.5,grades:grades(['5%','10%','20%'],[.25,.5,1]),defaultGrade:'10%',detail:'柔化轮廓'}
 ];
 const scan={id:'scan',name:'直接扫描',kind:'保留胶卷色彩',carrier:'直接扫描',sw:'linear-gradient(135deg,#e8e4dc,#c6bfb2)'};
 // Short appearance notes describe the current completed-photo LUTs and
 // bounded print adaptation, rather than repeating the selected models.
 const filmEffects={};
 const printEffects={scan:'保留演示色彩','demo-paper-warm':'暖调演示','demo-paper-cool':'冷调演示','graded-print':'灰阶演示'};
 const filterEffects={
  black_pro_mist:['轻微柔化','轻柔亮边','柔和亮边','明显柔晕','浓郁柔晕'],
  glimmerglass:['轻柔细节','柔和细节','柔润细节','明显柔化'],
  pro_mist:['轻微光晕','轻柔高光','柔和高光','明显光雾','浓郁光雾'],
  cinebloom:['轻柔轮廓','柔雾轮廓','明显光雾']
 };
 const styles=()=>root.FilmifyStyles;
 const stock=value=>styles().get(typeof value==='string'?value:value&&value.style);
 const filter=id=>filters.find(f=>f.id===id)||filters[4];
 // Fotufilm print-stage responses are adapted relative to its screen receiver.
 // Completed sRGB is inverted only into a fixed reference coordinate system;
 // this does not recover the original negative or feed RGB as dye density.
 function prints(value){
  const item=stock(value),paper=root.FilmifyPaperAdaptation||root.FilmifyFinishedPaper,list=[Object.assign({},scan)];
  if(item.stockCategory==='color-reversal'||!paper)return list;
  const definitions=paper.definitions||paper.prints||[];
  return list.concat(definitions.filter(p=>p.id!=='scan'&&!!p.mono===!!item.blackAndWhite).map(p=>Object.assign({},p)));
 }
 function normalize(value){value=value||{};const style=stock(value).id,options=prints(style),print=options.some(p=>p.id===value.print)?value.print:'scan',f=filter(value.filter),filterGrade=f.grades.some(g=>g.id===value.filterGrade)?value.filterGrade:f.defaultGrade;return {style,format:Number.isInteger(value.format)&&formats[value.format]?value.format:0,filter:f.id,filterGrade,print};}
 const signature=value=>JSON.stringify(normalize(value));
 function haloLevel(seed){
  let n=Number.isFinite(Number(seed))?Math.trunc(Number(seed))>>>0:0;
  n=Math.imul(n^0xa511e9b3,0x7feb352d);n=Math.imul(n^(n>>>16),0x846ca68b);n=(n^(n>>>16))>>>0;
  return 1+n%3;
 }
 // Conservative finished-photo defaults, not measured emulsion profiles:
 // Standard still shares the Portra400 material. Fine-grain monochrome gets
 // a lighter creative amount; other stocks keep their existing grain amount.
 const fineGrainMonochrome=[];
 function grainLevel(item){return fineGrainMonochrome.includes(item.id)?1:Math.max(item.blackAndWhite?2:1,item.texture.grain);}
 function stockHaloLevel(item,seed){
  if(item.blackAndWhite)return 0;
  const level=haloLevel(seed);
  // Demo styles use a restrained 0/1 envelope. This is a default choice,
  // not a claim that ordinary colour or monochrome film cannot halate.
  return level===1?0:1;
 }
 function settings(value,seed){
  const recipe=normalize(value),item=stock(recipe),f=filter(recipe.filter),format=formats[recipe.format],mm=format.mm;
  const result=styles().settings(recipe.style);
  // Every stock keeps grain enabled so virtual format still affects it.
  result.grain=grainLevel(item);
  result.soft=f.strength>0?1:0;result.softFamily=f.model;result.softStrength=f.strength>0?f.grades.find(g=>g.id===recipe.filterGrade).strength:0;
  result.grainFormatMm=mm;result.opticsFormatMm=mm;result.opticsFormatId=format.id;result.halation=stockHaloLevel(item,seed);
  if(format.frameHeightMm!==undefined)result.grainFrameHeightMm=format.frameHeightMm;
  // Standard uses a calibrated statistical field, so the former Film-atlas
  // Super 8 cluster-size workaround does not apply to this model.
  result.paper=recipe.print;
  // Keep neutral optics for monochrome recipes, including manual overrides.
  // Toned stock LUTs keep their own gray/brown colors; no final desaturation.
  if(item.blackAndWhite||recipe.print==='graded-print'){result.halationNeutral=true;result.softNeutral=true;}
  return result;
 }
 function descriptions(value){
  const r=normalize(value),item=stock(r),f=filter(r.filter),grain=grainLevel(item);
  const formatEffects=['轻微颗粒','细腻颗粒','更细颗粒','粗粝颗粒','明显颗粒','鲜明颗粒','细腻颗粒','更细颗粒','更细颗粒'];
  if(r.format===0&&grain>1)formatEffects[0]=grain>2?'粗粝颗粒':'明显颗粒';
  return {film:filmEffects[item.id]||(item.blackAndWhite?'黑白层次':'色彩层次'),format:formatEffects[r.format],filter:f.id==='none'?'清晰轮廓':filterEffects[f.id][f.grades.findIndex(g=>g.id===r.filterGrade)],print:printEffects[r.print]};
 }
 function summary(value){const r=normalize(value),paper=prints(r.style).find(p=>p.id===r.print),f=filter(r.filter),parts=[stock(r).sourceName||stock(r).name,formats[r.format].modelLabel];if(f.strength>0)parts.push(f.modelName+' '+r.filterGrade);parts.push(paper.carrier||paper.name);return parts.join(' · ');}
 function createDeck(random){
  const rng=random||Math.random;let bag=[];
  return current=>{
   const key=signature(current);
   if(!bag.some(value=>signature(value)!==key)){
    bag=styles().items.map((item,i)=>{const options=prints(item.id),f=filters[i%filters.length],grade=f.grades.length?f.grades[i%f.grades.length].id:null;return normalize({style:item.id,format:i%formats.length,filter:f.id,filterGrade:grade,print:options[i%options.length].id});});
    for(let i=bag.length-1;i>0;i--){const raw=Number(rng()),j=Math.max(0,Math.min(i,Math.floor((Number.isFinite(raw)?raw:0)*(i+1)))),a=bag[i];bag[i]=bag[j];bag[j]=a;}
   }
   const at=bag.findIndex(value=>signature(value)!==key);return normalize(bag.splice(Math.max(0,at),1)[0]);
  };
 }
 root.FilmifyRecipeConfig={version:'finished-photo-accessories-3',formats,formatOrder,filters,filter,prints,normalize,signature,settings,summary,descriptions,createDeck,haloLevel};
 if(typeof module==='object'&&module.exports)module.exports=root.FilmifyRecipeConfig;
})(typeof window==='object'?window:global);
