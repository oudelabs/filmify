# Filmify

Filmify 公开项目集合。当前提供数字胶片网页工具，Agent Skill 目录预留。

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| [mini-tool](mini-tool/README.md) | 网页工具源码、资源、构建、测试和文档 | Beta；版本与设备验证范围见项目说明 |
| [skill](skill/README.md) | 后续 Agent Skill | 预留，暂无可安装内容 |

## 构建网页工具

需要 Node.js 22+、Python 3.10+ 和支持 WebGL2 的浏览器。在仓库根目录执行：

```sh
cd mini-tool
npm ci
npx playwright install chromium
npm run build
npm run dev
```

在同一目录运行 `npm test`、`npm run verify:release` 完成桌面验证。
构建产物位于 `mini-tool/dist/`；详细说明见 [构建与复现](mini-tool/docs/public-build.md)。
桌面门禁不能替代手机及小红书宿主验证，已知问题见 [运行状态](mini-tool/docs/public-runtime-status.md)。

## 许可与来源

项目代码采用 [GPL-3.0-only](LICENSE)。网页工具的模型衍生数据采用 CC BY-SA 4.0，
字体采用 SIL OFL 1.1；对应许可、版权及上游出处见 [网页工具许可说明](mini-tool/README.md#许可证与署名)
和 [NOTICE](mini-tool/styles/NOTICE.md)。第三方资产遵循各自随附许可。
界面资源与自有预览表的来源状态见 [资源清单](mini-tool/docs/public-assets.md)。

## 源码清单

`PUBLIC_MANIFEST.json` 记录本次整理的文件路径、大小和 SHA-256，路径相对于仓库根目录。
清单不包括自身、本地导出标记、依赖安装和构建产物；后续修改源码后需重新生成清单。
本地候选目录不含原工作仓库的 Git 历史、研究照片和内部资料。
