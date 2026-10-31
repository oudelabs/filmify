# Filmify 编辑器 · 数学演示色表版

当前代码版本为 `2.0.8-demo.1`，替代早期密度域模拟器入口。运行代码保留完整尺寸分块 GPU／CPU 链、取消与缓存、负片主页、配方选择、成片和静态分享。

独立产品目前配置42款色表；它们不在这个公版目录或默认演示包中。公版版本记录与版本说明位于仓库根目录的 [CHANGELOG](../CHANGELOG.md) 和 [版本说明](../RELEASE_NOTES.md)。

六款色表为「恒等、暖色、冷色、柔和、对比、黑白」原创数学演示，全部公开公式可重建。负片仅做显示；原照片始终作为成片输入。暖纸、冷纸、灰阶印相同样是原创演示，不加载产品印相响应。公版没有产品胶卷 LUT，也不从产品表采样生成演示表。

## 模块与验证

- `app.js`／`editor-share.js`：导入、配方、冲印、成片和分享状态。
- `texture-engine.js`／`pixel-*.js`：完整尺寸颜色、GPU 分块、SDR 编码及 CPU 退路。
- `standard-*.js`／`grain*.js`：Fotufilm Standard 颗粒与材料响应。
- `texture-optics.js`／`texture-halation.js`：Fotufilm 粒子柔光与 Legacy 辉光的成片适配。
- `style-config.js`：由演示生成器生成的注册表；不使用产品胶卷清单。
- `negative-preview.js`／`paper-adaptation.js`：独立数学演示实现，无产品色表或内嵌印相数据。

```sh
npm ci
npx playwright install chromium webkit
npm test
npm run test:assets
npm run build
npm run verify:release
npm run dev -- --host 127.0.0.1
```

构建包含实际包出图冒烟；完整公版验证另检查生成器、自备 LUT、组件生命周期、双浏览器色彩／印相 CPU-GPU、源包身份、交互、取消重试与静态包。检查只用合成图和数学色表，不依赖旧私有测试夹具。产物为 `dist/xhs-tool/` 与 `dist/filmify-demo-tool.zip`，均被 Git 忽略。

照片在本机处理。浏览器下载由开发服务器注入独立适配器，小红书包保留宿主接口；本地浏览器测试与 SDK 替身不表示真实相册／发笔记已验收。HEIF 仅按原生解码能力处理，当前为 SDR 输出。

自备色表格式、显式本地构建和测试入口见 [构建说明](docs/public-build.md)。代码／材料／字体／演示资源的许可及排除范围见 [资源边界](docs/asset-policy.md)。完整许可文本在 `minitool/assets/third-party-licenses.txt`，构建嵌入 `index.html`。
