# 资源与许可边界

| 文件／模块 | 来源和处理 |
| --- | --- |
| `assets/demo/*.png`、生成器 | Filmify 原创数学演示，GPL-3.0-only；可从公开公式完整重建 |
| `negative-preview.js` | 原创数学负片显示，不包含产品负片预览 LUT |
| `paper-adaptation.js` | 原创暖／冷／灰阶印相公式，运行时生成小表；不含产品印相差表或原生印相 profile |
| `grain-material.png`、`grain-material-data.js`、`standard-data.js`、`halation-data.js` | Fotufilm Portra 400 材料响应及 profile 派生参数，CC BY-SA 4.0；这是公开运行所需的第三方材料，不是演示胶卷颜色 LUT |
| Fotufilm 颗粒、柔光及辉光改编 | 上游 MUAStudio Inc. 代码 Apache-2.0，Filmify 改编代码随项目 GPL-3.0-only；固定 revision 和变更见第三方许可 |
| 字体 WOFF | Libre Baskerville 子集，内部族名 Filmify Caption，SIL OFL 1.1，随附完整字体许可 |
| Logo、背景、WORKING、夹子图片 | 项目界面素材；夹子使用保留 alpha／可见 RGB 的冻结 PNG，完全透明位置的隐藏 RGB 已清理；不包含照片 |
| `local-luts/` 与 `assets/local/` | 用户自备且默认忽略；许可由提供方决定，不因导入自动变为 GPL 或允许再分发 |

产品胶卷 LUT、旧负片预览表、产品印相内嵌数值、数值打包目录、原始色表目录、烘焙／修补数据、产品缩略图、研究照片和旧验证夹具不在公版文件集内。文件类型不是判据：PNG、WebP、CUBE、Base64、数组和压缩副本都可能承载数值表。

公版代码仍为 GPL-3.0-only；替换成像参考不自动更换项目许可证。保留 Andrea Volpato／Spektrafilm 历史代码改编署名，但公版不运行其成像阶段，也不携带旧模型表。旧 `v1.0.1` 已发布文件的许可不撤回。

完整版权与许可文本在 `minitool/assets/third-party-licenses.txt`；构建把它作为文字嵌入包内 `index.html`。公开的 CC BY-SA 材料保持署名、修改说明与原许可，不能据本项目将其声明为独占资产。代码、原创演示、自备资源的范围分别记录，不给所有第三方色表作统一授权结论。
