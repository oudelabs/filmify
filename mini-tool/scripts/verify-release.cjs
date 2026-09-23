#!/usr/bin/env node
/* Release gate (2026-09-21 review 落地).
   `npm run build` 是开发构建:smoke 在 Playwright 缺失时返回 77、build 仅 WARNING 继续。
   发布构建不允许跳过浏览器验证——本脚本强制 Playwright 存在,并一次串行跑完
   build + dist smoke + 十步 UI + bugfix 回归 + 输入归一化 + live share + 计时探针 + footer
   + 页面生命周期 + GPU optics 等价/成片 A/B + dither + 颗粒 ACF/尺度能量裁判
   + 逐通道颗粒选档专项,
   任一环节非零退出即整个 gate 失败(exit 1)。
   用法: node scripts/verify-release.cjs  (或 npm run verify:release) */
'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const PY=process.platform==='win32'?'python':'python3';

let failed=false;
function run(name,cmd,args,retries){
 process.stdout.write('\n▶ '+name+'\n');
 for(let attempt=0;;attempt++){
  const r=spawnSync(cmd,args,{cwd:ROOT,stdio:'inherit',encoding:'utf8'});
  if(r.status===0){console.log('✓ '+name);return;}
  /* 环境抖动(无头 Chrome 被系统内存压力杀掉/端口残留)只允许重试:
     真实回归会确定性失败,重试不改变结论。浏览器步骤缺省重试 1 次,
     确定性步骤(构建)调用处显式传 0。 */
  if(attempt<(retries===undefined?1:retries)){console.error('… '+name+' 环境性失败,重试一次');continue;}
  console.error('✗ '+name+' FAILED (exit '+(r.status===null?'signal '+r.signal:r.status)+')');
  failed=true;return;
 }
}

/* 0. Playwright 必须可用:发布门禁里唯一跑真实浏览器的环节不能被静默跳过 */
try{
 require.resolve('playwright');
 console.log('✓ playwright module present');
}catch(error){
 console.error('✗ playwright module not installed — run: npm i -D playwright');
 process.exit(1);
}

/* 1. 构建(内含 ES2017 Acorn 解析、LUT hash/尺寸、manifest 一致性、本地资源路径、
       禁用 API、包内文件集合、官方 auditor、ZIP integrity、10 MiB 上限) */
run('build-minitool.py (全量静态检查 + 打包)',PY,[path.join('scripts','build-minitool.py')],0);
/* 2. 浏览器层门禁,按依赖顺序串行 */
run('dist smoke(打包页零缺失 + 6MP 显影)',process.execPath,[path.join('scripts','dist-smoke-check.cjs')]);
run('十步 UI 流程(选图→冲印→成片→保存/分享直达)',process.execPath,[path.join('scripts','verify-v4-ui.cjs')]);
run('bugfix 回归(B1–B7 + 保存部分失败重试)',process.execPath,[path.join('validation','bugfix-2026-09-20-check.cjs')]);
run('选图归一化(4096 上限 + 原尺寸记录 + 小图不重编码)',process.execPath,[path.join('validation','input-normalize-check.cjs')]);
run('照片方向(EXIF 八方向 + 大图缩放 + 解码回退)',process.execPath,[path.join('validation','input-orientation-check.cjs')]);
run('导入首屏(负片就绪后显示,无黑块占位)',process.execPath,[path.join('validation','import-preview-check.cjs')]);
run('成片设计一致性/随机布局/跟手翻页',process.execPath,[path.join('validation','result-design-check.cjs')]);
run('拼图取消/追加失效/黑白负片就绪/失败重试',process.execPath,[path.join('validation','collage-state-check.cjs')],0);
run('自动输出回退/随机搭配恢复/展示图尺寸',process.execPath,[path.join('validation','release-regression-check.cjs')],0);
run('实况分享组(单图混合组 + 多图纯图片组)',process.execPath,[path.join('scripts','verify-live-share.cjs')]);
run('developMobile 五段计时探针',process.execPath,[path.join('validation','timing-probe-check.cjs')]);
run('导出画面无品牌元素(footer)',process.execPath,[path.join('validation','footer-check.cjs')]);
run('页面生命周期(pagehide 释放引擎 + pageshow 复位回主页)',process.execPath,[path.join('validation','page-lifecycle-check.cjs')]);
run('冲印进度(真实工序逐段推进 + 双波浪动画,无段条/工序列表)',process.execPath,[path.join('validation','pstep-lines-check.cjs')]);
/* 3. 生产代码数值特性定向验证(2026-09-21 外部 review 补进门禁):
      GPU optics 与 dither 已有专项验证但此前不在 release gate,改代码不会强制重跑 */
run('GPU 光学场 vs CPU 逐值等价(log10 域)',process.execPath,[path.join('validation','gpu-optics-eq-check.cjs')]);
run('GPU 光学场最终成片 A/B(逐像素 8 位)',process.execPath,[path.join('validation','gpu-optics-final-check.cjs')]);
run('最终 dither(幅度/零均值/确定性)',process.execPath,[path.join('validation','dither-check.cjs')]);
/* 真机自检防线(2026-09-21 Android 假色事故):核心 LUT 自检 + GPU 光学场交叉校验,
   驱动静默错误必须表现为自动回退或响亮中止,绝不出假色 */
run('真机自检三态(正常通过/光学场破坏回退/核心破坏中止)',process.execPath,[path.join('validation','selfcheck-check.cjs')]);
run('画布读写扰动/分配重试/光学效果保留',process.execPath,[path.join('validation','canvas-allocation-check.cjs')],0);
/* LUT 采样双路径回归(2026-09-21 外部 review 建议):256 个网格外固定色向量 × 3 款,
   默认硬件采样与强制 lutNearest 手工插值双双对照纯 JS 参考并互相 A/B——
   手工三线性索引/权重类错误必须在这里现形 */
run('LUT 采样双路径回归(硬件 vs 手工三线性 × 256 色)',process.execPath,[path.join('validation','lut-paths-check.cjs')]);
/* 4. 颗粒统计裁判(2026-09-21 颗粒三提案验收框架):native grainPlane vs mobile shader 的
      ACF lag1/2/4/8 双轴 + 尺度能量比;lag1 标定不跑偏、E_tail/E_scale8 不劣化于
      validation/grain-acf/baseline.json,误差缩小即「效果变好」的量化证据 */
run('颗粒 ACF/尺度能量裁判(vs native 基线)',process.execPath,[path.join('validation','grain-acf-check.cjs')]);
/* 5. 逐通道颗粒选档专项(2026-09-21 色彩状态落地):数据层新查档=native 混色态、
      近灰态不劣于旧查档(中性区判据)、灰场钉版夹具 A/B、饱和场逐通道生效 */
run('逐通道颗粒选档(混色态/近灰态/灰场 A-B/饱和生效)',process.execPath,[path.join('validation','grain-perchannel-check.cjs')]);
run('颗粒物理尺度(独立原生灰场 × 20 胶卷)',process.execPath,[path.join('validation','grain-scale-check.cjs')]);

run('冲印调度/动画合成/成片首屏解码',process.execPath,[path.join('validation','processing-ready-check.cjs')]);
run('扫描/颗粒/柔光对原生专项',process.execPath,[path.join('validation','pipeline-fidelity-check.cjs')]);
run('GPU 柔光 FFT 原生数值/成片/释放/回退',process.execPath,[path.join('validation','gpu-diffusion-check.cjs')]);
run('空间 DIR 原生数值/边界/半浮点/取消释放',process.execPath,[path.join('validation','spatial-dir-check.cjs')]);

if(failed){
 console.error('\n════════════ RELEASE GATE FAILED ════════════');
 process.exit(1);
}
console.log('\n════════════ RELEASE GATE PASSED ════════════');
