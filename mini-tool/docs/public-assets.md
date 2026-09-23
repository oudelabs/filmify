# 界面资源来源

更新：2026-09-23。这里区分界面资源与 spektrafilm 模型数据，不能将全部图片都视为上游衍生 LUT。

| 资源 | 来源与许可记录 |
| --- | --- |
| `minitool/assets/negative-picker-lut32.png` | 项目维护者确认拥有并授权随 Filmify 开源的自有负片预览表；从原始 64³ 表降采样到 32³，仅用于预览和显影动画首帧。随项目 LICENSE 分发。 |
| `minitool/assets/caption-400.woff`、`caption-600.woff` | 源自 Libre Baskerville 的字体子集，内部族名为 Filmify Caption（遵守保留字体名称要求）；版权与随附 `caption-font-OFL.txt` 一致，SIL OFL 1.1。 |
| `minitool/assets/bg-mottle.png` | 项目自制的周期性背景纹理；维护者已确认允许随项目公开，按项目 LICENSE 分发。 |
| `minitool/assets/logo-mark-t-dark.png` | 项目自制品牌位图；维护者已确认允许随项目公开，按项目 LICENSE 分发。不将其字形标为某个已验证字体。 |
| `minitool/assets/working-sign.png` | 项目自制冲印状态标识；维护者已确认允许随项目公开，按项目 LICENSE 分发。 |

以上三张界面图片已由维护者于 2026-09-23 明确确认为自制、允许随项目公开。

`styles/luts/` 的 71 张数值表和相关模型数据的来源、上游 revision 与许可见 [NOTICE](../styles/NOTICE.md)。这些数值 PNG 不含研究照片。项目整体许可见 [LICENSE](../LICENSE)。

字体子集可用 `scripts/build-caption-font.py` 从上游 Libre Baskerville 可变 TTF 重建，需要可选 authoring 依赖 fonttools；应用及常规构建直接使用随附 WOFF，无需联网。
