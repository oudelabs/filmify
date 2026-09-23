# 公开版本构建与复现

更新：2026-09-23。当前产品规格以工具项目 README、运行时代码和注册表为准。公开仓中整套网页工具位于 `mini-tool/`，以下命令均在该目录执行；同级 `skill/` 目前仅预留。公开导出不包含历史研究文档、旧入口或研究照片。

## 普通构建

Node.js 22+、Python 3.10+；`npm ci` 安装锁定的开发依赖，`npx playwright install chromium` 安装浏览器。然后执行 `npm test`、`npm run verify:release`。

运行时不依赖 Node 或 Python。构建只需 Python 标准库；科学计算环境仅用于下面的色彩资产再生成。`package.json` 的 `private: true` 只阻止误发布 npm 包，不影响公开源码。`repository` 已指向 [oudelabs/filmify](https://github.com/oudelabs/filmify)。

发布门禁必须有 Chromium。单独 `npm run build` 在 Playwright 未安装时允许只做静态构建并警告，不能将此当成完整验收。

## 共享 LUT 再生成

使用单独的工作副本操作：最终步骤会更新 `styles/` 中的共享 LUT 和注册表。

1. 准备 Python 3.12 虚拟环境，安装上游核心依赖：

```sh
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-bake.txt
```

上游包导入时也会加载 RAW／镜头校正与图像 I/O 模块，因此依赖清单包含 rawpy、exiv2、lensfunpy 和 OpenImageIO，不能只安装 NumPy／SciPy。清单记录本次复现验证的版本；不同系统需有对应 wheel 或本机构建工具。

2. 克隆上游并固定版本：

```sh
git clone https://github.com/andreavolpato/spektrafilm.git /path/to/spektrafilm
git -C /path/to/spektrafilm checkout 6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507
```

3. 使用随仓校准系数重建共享表：

```sh
python scripts/rebuild-shared-luts.py --reference /path/to/spektrafilm
npm run verify:release
```

该入口先核对上游 revision 与工作区，再逐载体烘焙 9 张印相表和 1 张 Velvia 基准直扫表，用保存的 W 做上游数值对照，通过后生成注册表。它不重新拟合 W，不修改原始输入表、胶卷曲线或颗粒参数。PNG 压缩字节可以因工具版本不同而变化，运行时使用解码后的数值指纹。

- `validation/shared-lut/pretransforms.json`：14 款彩负 × 8 种载体，非基准胶卷的 3×10 二次预变换。
- `validation/shared-lut/pretransforms-scan.json`：Provia、Ektachrome、Kodachrome → Velvia 的 3×20 三次预变换；Velvia 自身恒等。
- `scripts/build-shared-prints.py`、`scripts/build-shared-scans.py`：使用 staging 中的表和保存的系数生成运行时注册表。
- `validation/shared-lut/ab-check.py`、`ab-scan.py`：对照上游密度到扫描链，任一 MAE／P99／max 门槛失败即非零退出。

新模型研究需要重新拟合时，可设置 `SPEKTRAFILM_REPO=/path/to/spektrafilm` 后执行 `batch-fit.py --paper <profile>` 或 `fit-scan.py`。它们会覆盖校准 JSON，必须单独审核差异并重跑数值门禁；不是普通构建的一部分。浮点优化结果可能随科学计算库版本变化，发行构建始终使用入库系数。

## 原始输入表与历史管线

`styles/presets.js` 保存逐胶卷曲线、原始曝光归一化和光学参数；`styles/presets-mobile.js` 保存移动端 raw 表与 Tri-X 扫描表描述。普通发行复现使用这些已入库数据。

`scripts/rebake-mobile-raw.py --reference /path/to/spektrafilm` 可重建移动端 raw 表（会改 `styles/`）；随后执行 `scripts/stamp-mobile-lut-hashes.py` 和完整门禁。

`bake-native-film.py`、`bake-mobile-film.py` 等是历史逐胶卷链路的研究工具，均需显式输出目录；其全链路输出不能直接覆盖当前共享 LUT 注册表。`styles/manifest.json` 保留各批次来源信息；当前实际共享表尺寸、指纹及 W 以 `presets-prints.js`、`presets-scans.js` 为准。

这些工具的公共函数仍由当前共享表和 raw 表重建脚本调用，因此随源码保留。旧三款/六款配方生成器不再分发。注册表引用的原生 raw/density 表虽然不进入运行包，仍被构建器校验来源与指纹，也必须保留。

`bake-film-stocks.py` 的参考入口从已随仓的 `styles/manifest.json` 读取上游 profile 指纹，并核对固定 revision；无需额外的历史资料清单。该参考入口输出 staging 全链路表，不用于覆盖当前产品共享表。

颗粒重新标定入口为 `node scripts/calibrate-grain.cjs`，依赖随仓的 `scripts/grain-kernel-fit.cjs` 与 `validation/grain-calib-page.html`。该操作会改写 `styles/grain-stats.js`，属于模型变更，不能作为日常构建步骤执行。

重建上述 8 µm 基表后，还需在原生烘焙环境运行 `python scripts/calibrate-grain-scales.py --reference /path/to/spektrafilm --output /tmp/grain-scales.json`，再运行 `node scripts/calibrate-grain-scales.cjs /tmp/grain-scales.json`，恢复 2–32 µm 的物理尺度校准。这些表来自原生均匀密度场，不使用照片拟合。`validation/grain-scale-check.cjs` 以未参与校准的密度和尺度检查真实 GPU 输出，已纳入发布门禁。

## 发行边界

公开导出保留当前运行时代码、所需资产、构建与验证脚本、数值基线和色彩数据重建工具。不带 Agent Skill、品牌探索稿、内部 Git 历史、研究照片、历史报告、运营资料或临时诊断日志。构建产物位于被忽略的 `dist/`。

源文件按明确清单选择；LUT 只从四份注册表提取，不整目录复制。新发布门禁未进入审查清单时导出会失败，须核查脚本及其夹具后更新清单。公开仓根目录的 `PUBLIC_MANIFEST.json` 列出本次导出的源码文件及 SHA-256（不包括清单自身、本地导出标记和后续构建产物）；它是核对依据，不代表获准公开。

完整桌面门禁不能替代小红书宿主的照片导入、批量内存、保存及实况分享真机验证。
