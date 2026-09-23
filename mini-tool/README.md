# Filmify · 数字胶片工坊

纯 HTML / JavaScript / WebGL2 的本地胶片模拟工具。照片处理在设备内完成，渲染引擎不上传照片；用户主动分享时，通过宿主接口交付图片或视频。当前产品形态为小红书小工具，也可在浏览器中本地预览。

色彩科学衍生自 Andrea Volpato 的 [spektrafilm](https://github.com/andreavolpato/spektrafilm)，固定参考 revision `6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507`。当前为 **1.0.1 Beta**，手机内存与视频编码能力因设备、浏览器和宿主而异。

## 特性

- **20 款胶卷、118 种组合**：14 款彩负 × 8 种彩色印相载体，Double-X × Kodak 2302，以及 4 款彩色反转片和 Tri-X 直扫。
- **移动端渲染**：WebGL2 分块显影、胶片密度曲线与空间 DIR、颗粒、散射、halation、扫描锐化及印相 glare。共享印相／直扫 LUT 减少重复数据。
- **当前默认**：关闭自动测光，保留原照片的场景明暗差异；开启微弱 CineBloom 柔光（1/8）与空间 DIR。柔光优先使用 GPU，能力不足时回退 CPU。
- **单张与组图**：一次最多 9 张；支持成片、对比图、负片预览、接触印相拼图和显影动图。设备录制失败时自动回退图片分享。
- **输出尺寸**：导入长边上限 4096 像素，超过时等比缩小；后续冲印不因慢设备再降低输出尺寸。
- **运行时自检**：LUT 完整性、色彩核心及 GPU／CPU 光学场交叉检查，异常时回退可用路径或明确报错。

## 快速开始

在公开仓中，本工具位于 `mini-tool/`，请先进入该目录；以下命令均在工具项目目录执行。

需要 Node.js 22+、npm、Python 3.10+，以及支持 WebGL2 的浏览器。常规构建仅使用 Python 标准库，无需安装上游模拟器或科学计算依赖。

```sh
npm ci
npx playwright install chromium
npm run build
npm run dev
```

打开 `http://127.0.0.1:7100/`。开发服务器默认监听 `0.0.0.0`，便于同一局域网的手机访问；仅在本机预览可用 `npm run dev -- --host 127.0.0.1`。

构建输出 `dist/xhs-tool/` 与 `dist/filmify-xhs-tool.zip`（约 5.8 MB，59 个文件）。网页可离线处理照片；小红书原生分享能力需要在对应宿主中验证。

点击首页 Logo 可查看项目介绍、版本、致谢和完整许可。居中浮层上下保留空隙，完整许可展开后在正文区域滚动。版本和源码地址由构建器从 `package.json` 读取；项目地址为 [github.com/oudelabs/filmify](https://github.com/oudelabs/filmify)。

## 验证

```sh
npm test
npm run verify:release
```

完整门禁包括构建、打包页冒烟、UI、资源释放、选图方向与归一化、实况分享、光学场等价、LUT 双采样路径、颗粒统计、柔光及空间 DIR。实际步骤以 `scripts/verify-release.cjs` 为准。浏览器门禁不替代手机真机验证。Linux 安装 Chromium 的系统依赖可使用 `npx playwright install --with-deps chromium`。

## 色彩资产与复现

仓库已包含运行所需 LUT 与校准数据，直接构建不需要重新烘焙。共享表的构建与数值验收方法见 [构建与复现](docs/public-build.md)，架构见 [共享 LUT](docs/shared-lut-design.md)。已知设备问题及验证范围见 [运行状态](docs/public-runtime-status.md)。

## 目录

```text
minitool/       浏览器引擎、着色器、界面与宿主适配
styles/         LUT、胶卷参数、共享表注册表及出处说明
scripts/        构建、烘焙、验证工具
validation/     发布门禁、数值基线与共享表校准数据
tests/         Node 单元测试
docs/          当前构建说明、共享表架构与运行状态
```

本工具的公开源码包含当前网页产品及构建、验证、色彩数据重建依赖。公开仓以 `mini-tool/` 和 `skill/` 分项目组织，`skill/` 目前仅预留说明，尚未包含 Skill 实现。品牌探索稿、历史研究工具和私人样片不在公开导出范围内。公开仓根目录的 `PUBLIC_MANIFEST.json` 列出逐文件大小和 SHA-256，便于发布前审查。

## 许可证与署名

- 项目代码：**GPL-3.0-only**，见 [LICENSE](LICENSE)。上游算法改编出处见 [styles/NOTICE.md](styles/NOTICE.md)。
- 模型衍生 LUT、胶卷参数及共享表校准数据：**CC BY-SA 4.0**，见 [数据许可证](styles/SPEKTRAFILM_LICENSE.txt)。
- Libre Baskerville 字体：**SIL OFL 1.1**，版权及许可证随源码和打包页面提供，见 [字体许可证](minitool/assets/caption-font-OFL.txt)。

界面图片及自有负片预览表的来源与分发许可另见 [资源来源清单](docs/public-assets.md)。

Kodak、Fujifilm、Portra、Velvia、Tri-X 等名称为各自权利人的商标，仅用于标识模型参考型号。Filmify 与上述权利人及小红书均无隶属或背书关系。

## 已知局限

- 没有受控实拍胶片配对认证，不宣称精准还原实体胶片。
- 移动端使用光学场、LUT 与颗粒统计近似；柔光在最长边 512 的场上计算，空间 DIR 采用分块短程卷积与低分辨率长尾场，不能称为全分辨率上游逐像素等价。
- WebGL2 是必要条件。超大图片解码、批量画布分配和 MP4 编码受设备能力限制；视频失败可回退图片，画布分配失败会提示减少张数或刷新重试。
- 当前文档中的桌面回归结果不代表所有 iOS／Android 宿主都已覆盖。
