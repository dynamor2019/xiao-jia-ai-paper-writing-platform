---
name: scientific-figures-tables
description: 设计、生成和审计科技论文图表；当论文需要结果图、流程图、消融表、图注表注、可访问性或图文一致性检查时使用。
---

# Scientific Figures and Tables

生成或修改正文图前必须读取 `references/nature-figure-spec.md`。该文件是默认 Nature 图稿门禁；目标期刊规则更严格时取更严格值。

## Figures for Papers 资源

DSH 已接入 ChenLiu-1996/figures4papers。先按 `FIGURES4PAPERS_HOME` 定位；未设置时使用数据目录（`PAPER_DATA_ROOT` 或平台默认数据目录）下的 `resources/figures4papers`，不得假定客户有 `F:` 盘。资源缺失时报告并继续使用项目内的出版样式与门禁，不得静默跳过图形验收。生成 Matplotlib 论文图时，按需读取该资源的科研图设计约束：

- 必读：`<figures4papers目录>/scientific-figure-making/SKILL.md`
- 必读：`<figures4papers目录>/scientific-figure-making/references/api.md`
- 必读：`<figures4papers目录>/scientific-figure-making/references/design-theory.md`
- 当生成 grouped bar、趋势图、热图、多面板或常见论文图型时，再读取 `<figures4papers目录>/scientific-figure-making/references/common-patterns.md`

默认使用当前项目 `<项目目录>/scripts/figures4papers_style.py` 的 `PALETTE`、`FigureStyle` 和图形 helper 作为 Matplotlib 风格入口；若 figures4papers 示例风格与目标期刊、Nature 门禁或本 skill 冲突，以更严格的出版门禁为准。该资源只负责提高图形设计和绘图代码质量，最终交付仍必须通过 `scientific_figure_guard.finalize_figure()`。

## 先定义信息任务

每个图表先写一句要回答的问题，再选择形式；不能提升读者判断效率的图表应删除或合并。图表必须来自可追溯数据，不得手工改动数值或只保留有利结果。

## 数据契约与选图

绘图前为每张图核对观察单位、分组与配对/重复测量关系、变量尺度和单位、变换方式、样本量定义、缺失/排除记录、统计口径及不确定性表示，并映射到当前结果文件的字段与哈希。缺少会改变图形含义的字段或分析结果时停止该图，不得从图像、正文或模型推断补齐。无明确研究问题时先回到研究方案确定问题，不生成泛化的“漂亮图”。

按问题和数据结构选图：个体配对变化保留配对关系，分布与离群值不只给均值柱，效应比较说明区间和基线，时间趋势保留时间尺度，模型评估注明数据划分、种子/折数与指标定义。图型不能代替统计检验；任何变换、聚合或可视化抽样都须事先说明其用途与保留规则，并保留可核查的全量结果，不能因图形不显著而换图或过滤数据。

复用现有绘图脚本前，先比较问题、观测单位、数据维度、统计含义和输出形式；仅当数据契约一致时复用脚本并替换字段映射。结构相近但不等价时只借布局，含义不同时只借配色/字体，均不匹配时重新设计。参考图的外观不能决定统计口径、面板数或是否省略结果。沿用稿件和原图的成图语言，变量 ID、单位与标准缩写不机械翻译。

绘图脚本必须从 `milestones/reproducibility/results/` 的机器结果读取数据并核对 SHA256；禁止调用随机数生成实例、按论文均值反推散点、手填结果数组、硬编码统计量或从旧图/正文抄回数值。随机数只允许用于分析方案预先声明的实验本身，不得在绘图阶段生成“观测”。图表必须呈现完整预设组别和运行，包括负效应、零效应、失败及异常结果；任何排除都要引用冻结规则并提供敏感性检查。

## 图形门禁

- 坐标、单位、样本量、误差定义、统计标记和缩写必须完整；轴截断、对数尺度和归一化要显式说明。
- 颜色之外还使用线型、标记或直接标签，保证灰度和常见色觉条件下可辨。
- 避免无意义 3D、双轴误导、面积编码误差和装饰性效果。
- 图注应独立可理解，说明对象、条件、指标、误差和统计处理，但不重复讨论结论。

## 多面板准入（强制）

- 默认一张图只回答一个主要科学问题；“丰富信息”“信息更多”或版面有空白不构成增加子图的授权。
- 只有各面板来自同一实验问题、共享比较对象，并且并列后能直接完成尺度一致的对照时，才允许组合为多面板图；不满足时保持单图或拆成独立编号图。
- 创建或增加面板前，必须在图清单写明 `panel_rationale`；不能用一句话说明组合必要性时不得组合。不得把流程图、结果图、敏感性图和装饰示意图拼成信息墙。
- 合法多面板必须有清晰的 `(a)`, `(b)` 标签，共享可共享的图例与坐标说明，保持尺度、顺序、字体、留白和视觉权重一致；最终尺寸下任何面板均不得依赖放大才能阅读。
- 用户要求修改现有图时，默认保持原图数量、面板结构和编号；除非用户明确要求，或实验逻辑证明拆分/合并不可避免，不得擅自把单图扩成组合图。

## 出版级样式硬约束

- 先按最终版面尺寸作图：单栏 89 mm、双栏 183 mm、最高 170 mm，不得依赖 Word 二次缩放。
- 统一 Arial/Helvetica；普通文字 5–7 pt，坐标标题 6–7 pt，刻度、图例和数据标注 5–6 pt；只有面板字母使用 8 pt 粗体正体。字体必须可编辑并嵌入。
- 图的简短标题放在正文图注开头，不得在图内使用装饰性总标题；图注必须独立解释面板、符号、样本量、误差和统计方法，初投稿不超过 250 词。
- 坐标使用 sentence case、无句号并标明变量和单位；图例置于预留空白区或图外，禁止遮挡数据且取消装饰边框；数据标注只保留支撑判断的关键值。
- 图内禁止大段说明、阴影、渐变背景和拥挤标签；轴线约 0.5–0.75 pt，主数据线约 0.8–1.0 pt，标记在最终尺寸下可辨。
- 主图同时输出 600 DPI PNG 和字体可嵌入的 PDF；透明背景仅在期刊明确要求时使用。
- 使用色盲友好且灰度可辨的有限色板；同一论文中同一方法、变量和状态必须保持同色、同线型、同标记。

## 自动布局与返修（强制）

## 图脚本唯一性（强制）

每个正式正文图只能有一个稳定绘图脚本，路径固定为 `milestones/reproducibility/figures/figN_<short_name>.py`，例如 `fig1_workflow.py`、`fig2_objective.py`。图像返修必须读取并原地修改该脚本；不得为同一图继续新建 `fixed`、`final`、`v2`、`redesigned`、`professional`、`notitle`、`hid`、`optimized`、`unified`、`clean`、`simple` 等变体脚本。若确需探索草稿方案，只能放入 `.dsh-state/figure-scratch/`，成功后把必要修改合并回唯一正式脚本，并删除草稿。

`figure-manifest.tsv` 中每个 `id` 的 `script` 字段必须唯一且稳定；同一 `id` 不得出现多个脚本路径。修改 Figure 1 就只改 Figure 1 的脚本，修改 Figure 2 就只改 Figure 2 的脚本；不得用 `make_all_figures.py`、`batch_fix_figures.py` 或根目录临时脚本覆盖多个图，除非它只是调用各图唯一脚本的薄封装，且不包含独立绘图逻辑。

图脚本不得直接写在 `output/` 根目录、论文根目录、`code/` 或 `figures/` 的散乱位置；历史兼容目录只能读取旧文件，不得继续新增。正式可复现代码放在 `milestones/reproducibility/figures/`，短期尝试放在 `.dsh-state/figure-scratch/`，最终图文件输出到 manifest 指定位置。交付前必须检查不存在同一图的重复变体脚本；发现重复时，保留 manifest 指向的唯一脚本，其余草稿移动到 `.dsh-state/figure-scratch/archive/` 或删除。

## Pylustrator 预览（强制）

需要人工微调 Matplotlib 图面布局时，优先在文件工作台中打开规范 `figN_<short_name>.py`，使用 `Pylustrator 打开` 入口调节字体、坐标轴、标注、图例和留白。Pylustrator 只能作用于规范脚本本身；保存后必须重新运行脚本、重新通过 `scientific_figure_guard.py`，并同步修改对应 caption、Results、Discussion 和结论中的图文表述。

所有 Matplotlib 绘图脚本必须在创建 figure 前调用 `apply_publication_style()`，并以 `finalize_figure()` 代替直接 `savefig()`：

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))  # 论文流水线从项目根目录运行
from scientific_figure_guard import apply_publication_style, finalize_figure
from figures4papers_style import FigureStyle, apply_figures4papers_style

apply_publication_style()
apply_figures4papers_style(FigureStyle(font_size=7, axes_linewidth=0.7))
# 创建 fig 和 axes，完成绘图后：
finalize_figure(
    fig,
    output_path,
    column="double",
    caption_title="Brief scientific title",
    caption_text="Standalone description of panels, symbols, n, errors and statistics.",
)
```

`finalize_figure()` 会在最终物理尺寸下检查 Nature 字号、面板标签、图内总标题、坐标、图例、标注密度、文字重叠、裁切、空白图、像素尺寸、DPI 和图注元数据，并输出 `.png`、`.pdf` 与 `.qa.json`。任一项失败即阻止交付，绘图模型必须读取 QA 问题、定点调整布局后重新运行；最多自动返修 3 次，仍失败才向用户报告具体问题。不得删除 QA、降低阈值或忽略异常来换取 PASS。

程序检查 PASS 后，模型必须实际读取最终 PNG 做一次视觉复核，重点检查图例遮挡数据、面板视觉失衡、文字虽然未相交但过密、颜色难辨和错误裁切。视觉复核发现问题时自动修改并重新运行门禁。用户只需在整套主图全部 PASS 后做一次最终审美确认，不得要求用户逐张、逐轮发现重叠或字号问题。

## 改图后的图文同步（强制）

每次修改图之前，先记录该图对应的 `affected_claim_ids`、图注、正文引用位置和所依据的机器结果。修改并通过图像门禁后，必须重新读取最终图和机器结果，依次完成：

1. 比较修改前后的数据、分组、坐标范围、统计标记、视觉强调、面板结构和图号，判断科学含义是否变化。
2. 同步复核并按需修改图注、Results、Discussion，以及引用该结果的 Abstract、Conclusion、Highlights；正文中的数值、趋势、比较对象、显著性、限制和图号必须与最终图一致。
3. 更新 `claim-evidence-matrix.tsv` 的最终措辞与证据位置，再把图清单中的 `text_sync_status` 设为 PASS。未完成同步时，图和稿件都不得交付。

若仅改变字体、颜色或留白且数据表达与科学含义确实未变，不得为了“看起来同步”而改写结论；仍须逐项复核，并在图清单记录 `semantic_change=none` 和核对位置。不得只改图文件而沿用未经核对的旧图注与旧结论。

## 表格门禁

- 表格使用可编辑文本而非截图；列头包含单位，小数位与测量精度一致。
- 不把不同量纲或不可比设置放入同一排名；最佳值强调规则必须事先一致。
- 缺失、不适用和未报告使用不同符号并在表注解释。

## 可追溯性

维护 `milestones/reproducibility/figures/figure-manifest.tsv`：`id | question | source_data | script | png | pdf | qa_report | caption_title | caption_text | legend_position | panel_count | panel_rationale | affected_claim_ids | semantic_change | manuscript_callout | text_sync_status | visual_qa_status | status`。`source_data` 须定位结果文件、哈希和字段映射；图注或 QA 记录须写明每个定量面板的 n 定义、中心量、离散度/区间、检验与多重比较处理（如适用），缺项标记待核而非猜测。每个主图表必须能由脚本重建；只有程序检查、模型视觉复核及图文同步均 PASS 后，`status` 才能填写 PASS，并通过正文数字、图表数字和统计审计三方一致性检查。
