'use strict';
// 胶卷与印相载体注册表。
// 数据对齐上游 spektrafilm 6cd00c8 data/profiles：type=档案 info.type（negative/positive），
// oem=档案 info.target_print（原厂印相官配；反转片 null=冲洗后直接扫描）。
// baked=已有烘焙色彩资产（styles/luts + presets）可真实冲印（2026-09-22 全部 20 款已点亮）；
// 彩负可选 8 款彩色载体，黑白负片仅可选 2302。
// 反转片直扫无印相；oem 仅作默认选中项。
window.FilmifyMaterials={
 version:'film-print-picker-v1',
 // Native GUI convention: film_format_mm examples 8, 16, 35, 60, 120.
 // These are simulator scale values, not camera-gate measurements.
 formats:[
  {name:'135 全画幅',short:'135',spec:'24 × 36 mm',filmFormatMm:35},
  {name:'120 中画幅',short:'120',spec:'6 × 6 cm',filmFormatMm:60},
  {name:'4×5 大画幅',short:'4×5',spec:'4 × 5 英寸',filmFormatMm:120},
  {name:'35 mm 电影',short:'35 mm',spec:'电影规格',filmFormatMm:35},
  {name:'16 mm 电影',short:'16 mm',spec:'电影规格',filmFormatMm:16},
  {name:'Super 8',short:'S8',spec:'8 mm 电影规格',filmFormatMm:8}
 ],
 /* 工艺链（冲印页段条工序名的来源）：印相载体经 route 索引到此 */
 routes:[
  {name:'Portra Endura',kind:'彩色相纸',carrier:'Endura 相纸',mark:'ENDURA',process:'C-41 → RA-4',type:'paper',profile:'kodak_portra_endura',steps:['冲洗','曝光','显影','漂定','水洗','干燥']},
  {name:'Crystal Archive II',kind:'彩色相纸',carrier:'Crystal Archive II 相纸',mark:'CRYSTAL II',process:'C-41 → RA-4',type:'paper',profile:'fujifilm_crystal_archive_typeii',steps:['冲洗','曝光','显影','漂定','水洗','干燥']},
  {name:'Kodak 2383',kind:'彩色印片胶片',carrier:'2383 印片',mark:'2383',process:'ECN-2 → ECP-2D',type:'cine',profile:'kodak_2383',steps:['冲洗','曝光','显影','水洗','干燥']},
  {name:'Kodak 2302',kind:'黑白印片胶片',carrier:'2302 黑白印片',mark:'2302',process:'黑白负片 → 黑白印片',type:'cine',profile:'kodak_2302',steps:['黑白冲洗','曝光','显影','定影','水洗','干燥']},
  {name:'直接扫描',kind:'黑白反转片',carrier:'直接扫描',mark:'SCAN',process:'黑白反转冲洗',type:'scan',profile:null,steps:['首次显影','漂白','再曝光','二次显影','定影','水洗','干燥']},
  {name:'直接扫描',kind:'彩色反转片',carrier:'直接扫描',mark:'E-6',process:'E-6 反转冲洗',type:'scan',profile:null,steps:['首次显影','反转','彩色显影','漂白','定影','水洗','干燥']}
 ],
 /* 9 种印相载体；route 为工艺链索引，carrier 为摘要短文案，sw 为载体纸基配色。 */
 prints:[
  {id:'kodak_portra_endura',name:'Portra Endura',kind:'彩色相纸 · RA-4',carrier:'Endura 相纸',route:0,lt:1,sw:'linear-gradient(135deg,#faf4e8,#efe4cc)'},
  {id:'kodak_endura_premier',name:'Endura Premier',kind:'彩色相纸 · RA-4',carrier:'Endura Premier 相纸',route:0,lt:1,sw:'linear-gradient(135deg,#f8f1e2,#ecdfc4)'},
  {id:'kodak_supra_endura',name:'Supra Endura',kind:'彩色相纸 · RA-4',carrier:'Supra Endura 相纸',route:0,lt:1,sw:'linear-gradient(135deg,#fbf6ec,#f1e8d4)'},
  {id:'kodak_ultra_endura',name:'Ultra Endura',kind:'彩色相纸 · RA-4',carrier:'Ultra Endura 相纸',route:0,lt:1,sw:'linear-gradient(135deg,#f9f2e4,#eee0c2)'},
  {id:'kodak_ektacolor_edge',name:'Ektacolor Edge',kind:'彩色相纸 · RA-4',carrier:'Ektacolor Edge 相纸',route:0,lt:1,sw:'linear-gradient(135deg,#f6efdf,#e9dcbd)'},
  {id:'fujifilm_crystal_archive_typeii',name:'Crystal Archive II',kind:'彩色相纸 · RA-4',carrier:'Crystal Archive II 相纸',route:1,lt:1,sw:'linear-gradient(135deg,#f1f6ee,#e0ecdd)'},
  {id:'kodak_2383',name:'Kodak 2383',kind:'彩色印片胶片 · ECP-2D',carrier:'2383 印片',route:2,sw:'linear-gradient(135deg,#31405a,#222c3e)'},
  {id:'kodak_2393',name:'Kodak 2393',kind:'彩色印片胶片 · ECP-2D',carrier:'2393 印片',route:2,sw:'linear-gradient(135deg,#3c4c66,#2a3648)'},
  {id:'kodak_2302',name:'Kodak 2302',kind:'黑白印片胶片',carrier:'2302 黑白印片',route:3,sw:'linear-gradient(135deg,#585858,#767676)'}
 ],
 /* 20 款胶卷，顺序与主页卡片一致；默认 Portra 400。neg/bwneg 为负片，rev/bwrev 为直接扫描路线。 */
 films:[
  {name:'Portra 400',brand:'KODAK',mark:'PORTRA',code:'400',style:'portrait',formats:[0,1,2],route:0,type:'neg',oem:'kodak_portra_endura',mono:false,baked:true,hint:'柔和人像',sw:'linear-gradient(135deg,#ecdcc8,#d4b294)'},
  {name:'Portra 160',brand:'KODAK',mark:'PORTRA',code:'160',style:'portra160',formats:[0,1,2],route:0,type:'neg',oem:'kodak_portra_endura',mono:false,baked:true,hint:'细腻人像',sw:'linear-gradient(135deg,#e8d5c4,#d9b8a0)'},
  {name:'Portra 800',brand:'KODAK',mark:'PORTRA',code:'800',style:'portra800',formats:[0,1],route:0,type:'neg',oem:'kodak_portra_endura',mono:false,baked:true,hint:'弱光人像',sw:'linear-gradient(135deg,#e3cdbb,#c9a184)'},
  {name:'Gold 200',brand:'KODAK',mark:'GOLD',code:'200',style:'gold',formats:[0,1],route:0,type:'neg',oem:'kodak_portra_endura',mono:false,baked:true,hint:'暖调日常',sw:'linear-gradient(135deg,#f0d9a8,#e0b56a)'},
  {name:'Ektar 100',brand:'KODAK',mark:'EKTAR',code:'100',style:'ektar',formats:[0,1],route:0,type:'neg',oem:'kodak_portra_endura',mono:false,baked:true,hint:'高饱和风光',sw:'linear-gradient(135deg,#d94f3d,#3d6ea5)'},
  {name:'UltraMax 400',brand:'KODAK',mark:'ULTRA MAX',code:'400',style:'ultramax',formats:[0],route:0,type:'neg',oem:'kodak_portra_endura',mono:false,baked:true,hint:'明亮快照',sw:'linear-gradient(135deg,#f5e6b8,#a8d0e8)'},
  {name:'Pro 400H',brand:'FUJICOLOR',mark:'PRO 400H',code:'400',style:'pro400h',formats:[0,1],route:1,type:'neg',oem:'fujifilm_crystal_archive_typeii',mono:false,baked:true,hint:'柔和专业人像',sw:'linear-gradient(135deg,#e3dae9,#c2b2d2)'},
  {name:'Superia X-TRA 400',brand:'FUJICOLOR',mark:'SUPERIA',code:'400',style:'superia',formats:[0],route:1,type:'neg',oem:'fujifilm_crystal_archive_typeii',mono:false,baked:true,hint:'日系街头',sw:'linear-gradient(135deg,#d8e8dd,#8fb89e)'},
  {name:'C200',brand:'FUJICOLOR',mark:'C200',code:'200',style:'c200',formats:[0],route:1,type:'neg',oem:'fujifilm_crystal_archive_typeii',mono:false,baked:true,hint:'清透日常',sw:'linear-gradient(135deg,#cfe0d5,#9fc5ae)'},
  {name:'Vision3 50D',brand:'KODAK',mark:'VISION3',code:'5203',style:'vision50d',formats:[3],route:2,type:'neg',oem:'kodak_2383',mono:false,baked:true,hint:'5203 · 日光电影',sw:'linear-gradient(135deg,#3a3a42,#4a7ab8)'},
  {name:'Vision3 250D',brand:'KODAK',mark:'VISION3',code:'5207',style:'vision250d',formats:[3],route:2,type:'neg',oem:'kodak_2383',mono:false,baked:true,hint:'5207 · 日光电影',sw:'linear-gradient(135deg,#3a3a42,#4f9a72)'},
  {name:'Vision3 200T',brand:'KODAK',mark:'VISION3',code:'5213',style:'vision200t',formats:[3],route:2,type:'neg',oem:'kodak_2383',mono:false,baked:true,hint:'5213 · 钨丝灯电影',sw:'linear-gradient(135deg,#3a3a42,#3f94a8)'},
  {name:'Vision3 500T',brand:'KODAK',mark:'VISION3',code:'5219',style:'v3500t',formats:[3],route:2,type:'neg',oem:'kodak_2383',mono:false,baked:true,hint:'5219 · 钨丝灯电影',sw:'linear-gradient(135deg,#3a3a42,#7d5fb0)'},
  {name:'Verita 200D',brand:'KODAK',mark:'VERITA',code:'200',style:'verita200d',formats:[3],route:2,type:'neg',oem:'kodak_2383',mono:false,baked:true,hint:'影院感日光',sw:'linear-gradient(135deg,#c8d8e8,#90a8c8)'},
  {name:'Provia 100F',brand:'FUJIFILM',mark:'PROVIA',code:'100F',style:'provia',formats:[0,1,2],route:5,type:'rev',oem:null,mono:false,baked:true,hint:'反转片标准',sw:'linear-gradient(135deg,#bcd8e8,#7aa8c8)'},
  {name:'Velvia 100',brand:'FUJIFILM',mark:'VELVIA',code:'100',style:'velvia',formats:[0,1,2],route:5,type:'rev',oem:null,mono:false,baked:true,hint:'反转片浓郁风光',sw:'linear-gradient(135deg,#2e7d4f,#c23b2e)'},
  {name:'Ektachrome 100',brand:'KODAK',mark:'EKTACHROME',code:'100',style:'ektachrome',formats:[0,1,2],route:5,type:'rev',oem:null,mono:false,baked:true,hint:'反转片清透',sw:'linear-gradient(135deg,#3d6ea5,#a8c8e0)'},
  {name:'Kodachrome 64',brand:'KODAK',mark:'KODACHROME',code:'64',style:'kodachrome',formats:[0,1],route:5,type:'rev',oem:null,mono:false,baked:true,hint:'传奇反转片',sw:'linear-gradient(135deg,#c23b2e,#f0d9a8)'},
  {name:'Double-X 5222',brand:'KODAK',mark:'DOUBLE-X',code:'5222',style:'doublex',formats:[3],route:3,type:'bwneg',oem:'kodak_2302',mono:true,baked:true,hint:'黑白负片',sw:'linear-gradient(135deg,#444444,#bbbbbb)'},
  {name:'Tri-X 7266',brand:'KODAK',mark:'TRI-X',code:'7266',style:'trix',formats:[4,5],route:4,type:'bwrev',oem:null,mono:true,baked:true,hint:'黑白反转片',sw:'linear-gradient(135deg,#222222,#999999)'}
 ]
};
