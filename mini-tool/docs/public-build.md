# 构建、验证与自备 LUT

在 `mini-tool/` 内使用 Node.js 22+、Python 3.10+。Python 生成器只用标准库，开发依赖由锁定的 `package-lock.json` 安装。

```sh
npm ci
npx playwright install chromium webkit
npm run generate:demo
npm run verify:release
npm run dev -- --host 127.0.0.1
```

`npm run build` 每次从公式生成演示资源及注册表，再校验全部输入 SHA、PNG 格式、资源引用、ES2017 语法、禁用 API、ZIP CRC与体积，并用包内代码实际出图。它不联网、不读取额外色彩目录，也不从父项目寻找图片。网页运行本身不依赖 Python 或 Node。

六张 512×512 RGB8 PNG 表使用 64³ 立方：蓝轴 8×8 切片、红横轴、绿纵轴，输入／输出均为编码 sRGB SDR。恒等表有 RGB8 节点量化，不声称任意浮点输入完全无误差。其他演示是显式公式，不对应任何商业胶卷。印相和负片演示公式位于同名 JS 模块，无外部色表。

## 自备本机 LUT

格式必须是无色彩元数据、非交错、不透明 RGB8／RGB8 索引 PNG，布局与上方相同。不会偷偷转换 CUBE、含透明像素的 RGBA、ICC、HDR 或其他数据域；需要转换时先用你自己的工具明确处理。

```sh
npm run import:lut -- /path/to/your-look.png --id user-my-look --name '我的色表'
npm run build:local
```

`--black-and-white` 只接受三个通道逐节点相同的表；`--replace` 才覆盖已有同名本机导入。导入先检查尺寸、CRC、解码边界及哈希，把数据和记录存入忽略的 `local-luts/`。`build:local` 显式生成含自备资源的本机包。它不会上传文件，也不会改变自备数据的许可；分发前自行确认权利。

普通 `npm run build` 始终只注册六张演示表，完全排除本机色表；它可用于恢复演示构建。`local-luts/`、`minitool/assets/local/`、`dist/` 均被 Git 忽略，不能作为默认发布附件。生成的 `style-config.js` 和演示 manifest 会随本地构建变化，准备提交时先运行普通构建恢复它们，并检查 Git diff。

## 检查范围

`npm run test:assets` 在临时目录重建公式表，核对恒等轴、非恒等效果、黑白中性、生成可复现、自备文件错误拒绝和默认排除；`npm test` 运行组件及引擎回归。`npm run verify:release` 串行运行上述检查、实际构建、Chrome／WebKit 的源／包数值和交互检查、目录与 ZIP 审计。

浏览器检查仅监听本机临时端口，不读取照片库，不调用真实保存／发布宿主。输出到忽略的 `validation/public-demo/`，包括结果 JSON 和合成图截图；失败直接非零退出，不自动重试。该入口验证当前公版，不套用旧模拟器或其他产品版本的完整门禁结论。
