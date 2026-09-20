---
name: paper-writer
description: 从联网选题、研究方案、程序实验、数据验收到逐段写作、独立校验和投稿交付的证据驱动科技论文生命周期，支持断点续跑。
---

# 学术论文撰写技能

## 触发条件

当用户表达以下意图时使用本技能：
- "帮我写一篇关于XXX的论文"
- "写一篇学术文章/研究报告"
- "生成论文大纲并完成写作"
- 任何涉及完整论文撰写流程的请求

## 调用方式

使用 bash 工具在项目根目录执行：

```bash
npm run paper -- "用户的论文选题"
```

指定目标期刊时，先加载对应的 `journal-*` skill，再把期刊 ID 传给流水线：

```bash
npm run paper -- "用户的论文选题" --journal "automation-in-construction"
```

网页模式可先执行 `/journals` 查看全部非 MDPI 期刊，再执行 `/paper <选题> --journal <期刊ID>`。一旦指定期刊，流水线自动改用英文，并把该刊范围、结构、证据和投稿约束注入大纲、逐节写作和润色阶段。

论文工作台不是提示词模板：它直接调用 `/paper` 核心流水线并读取同一份断点、论文目录和质量状态。网页流程在联网选题后仅暂停一次，用户通过 `/paper-confirm` 确认最终研究问题；此后自动完成文献、数据集、实验、写作、两轮评审、改稿、格式与投稿交付。工作台中的恢复、校验、导出和产物操作只能调用 `/paper-*` 命令，不得另起自由提示词流程或维护第二套进度。

论文工作台除研究领域或题目外，还应接收核心创新与贡献、研究范围与排除项、方法与实验偏好、数据与实施约束；这些方向控制必须贯穿联网选题、检索、研究方案、写作、两轮评审和最终核验，不得只作为界面备注。

联网检索形成的文献库以及稿件实际引用的独立文献中，最近五个自然年发表的文献均不得少于 30%。近期文献必须与经典文献交错分配到各个有证据支撑的主要章节，禁止集中堆放在引言、文献综述或单一段落；引用核验报告必须记录占比和章节覆盖，未达标时阻止投稿交付。

## 工作流程（20 阶段）

工具按以下顺序执行，输出中会出现 `[阶段 N/20] stage-name` 标记。用户输入首先视为宽泛研究领域，联网选题使用最高能力路由；网页模式严格执行“一个对话对应一篇论文”，首次 `/paper` 将对话绑定到数据目录下的 `output/paper-projects/paper-<会话ID>/`，同一对话始终复用该目录，若要写另一篇必须新建对话。CLI 创建的项目通过 `/paper-attach <项目ID>` 接入同一个工作台。普通对话不得另建 `output/papers/` 稿件或维护独立进度；论文操作必须沿用当前工作台绑定的目录及断点。论文不得直接写入 `output/` 根目录；项目公开目录只保留 `milestones/` 与 `final/`，逐段草稿、提取文本、日志及请求文件进入 `.dsh-state/`，完整成功后自动清理临时运行区，仅保留断点状态。任何论文正文都不得早于实验与数据门禁；只有当前结果哈希通过结构完整性、科学/统计合理性和独立复算溯源三重校验，才能开始引言、方法、结果、讨论、摘要或结论。正文仍以段落为最小事务，每生成一段就写入隐藏检查点并同步保存状态。

## Milestone 与版本管理（强制）

默认一个任务一个 canonical 文件，修改时读取当前文件并原地定点更新；不得因为“改了一版”“更好看”“更完整”“最终版”就生成新文件。只有满足以下任一条件，才允许创建新的 milestone 文件或带轮次文件：最终研究问题确认、研究方案冻结或 amendment、结果数据哈希变化、三重数据验收完成、正式专家评审 round 1/round 2、DOCX 质量门禁、投稿包生成、投稿后返修。其他普通修改只更新原文件，并在 `milestones/change-log.tsv` 追加 `time | file | reason | source_hash/result_hash | change_type`。

禁止生成 `*_new`、`*_fixed`、`*_final`、`*_v2`、`*_revised`、`*_polished`、`*_clean`、`*_complete` 等临时变体作为正式产物。确需试验的内容放在 `.dsh-state/scratch/`，成功后合并回 canonical 文件并删除或归档 scratch。正式 manuscript 文件最多保留一个当前源稿；正式评审和投稿可以按明确轮次保留，例如 `scientific-review-round-1.md`、`scientific-review-round-2.md`、`submission-manifest.md`。

## 数据诚信硬门禁

1. 先冻结 `analysis-plan.md`，再写实验代码；看到结果后的方案变化必须写入 amendment，递增数据版本并从第一重校验重跑。
2. 冒烟测试只验证程序能运行，不得进入论文。正式实验必须保留成功命令、环境、随机种子、失败运行和机器结果哈希。
3. 第一重校验检查格式、行列、主键、重复、缺失、NaN/Infinity、样本量、单位和取值域；第二重校验检查泄漏、纳排规则、统计假设、效应量与区间、基线公平性、消融、敏感性、异常值和负结果；第三重校验从原始输入独立复算主表与主图，并核对结果、统计输出和图表哈希。
4. 任一重 BLOCKED 时只能修复数据来源、清洗或分析代码并重新运行，不得手工修改结果表、从正文反写数据、挑选有利运行或让模型补数。
5. 在 `data-validation-history.tsv` 保留每次 PASS/BLOCKED 及哈希；只以最后一个当前哈希的 PASS 为准。数据一旦变化，所有图、表、定量段落、摘要和结论立即变为待复核。
6. `result-provenance.tsv` 必须在定量行文前完成，正文每个数字只能来自 VERIFIED 行；无法核验的结果必须删除或明确标记为未验证，绝不能用更模糊的语言掩盖。

开始写作前必须完成期刊适配：用户已指定期刊时使用对应 skill；尚未指定时使用 `journal-selector` 给出范围匹配候选，但不得把 MDPI 期刊加入候选。投稿前重新打开 skill 中的官方链接核对易变的字数、模板、费用和声明要求。

## 模块化技能路由

只加载当前阶段需要的 skill，避免把全部规范同时塞入写作上下文：

| 当前任务 | 必须加载 |
|---|---|
| 论证规划、逐段写作、引用审计 | `claim-evidence-matrix` |
| 定量结果、显著性、模型指标 | `statistical-reporting` |
| 方法、实验设置、代码与数据交付 | `computational-reproducibility` |
| 图、表、标题和正文交叉引用 | `scientific-figures-tables` |
| 选择研究设计报告规范 | `reporting-guideline-router` |
| 作者贡献、伦理、利益冲突、AI 声明 | `research-integrity` |
| 投稿包与期刊终检 | `submission-readiness` |
| 修改稿与逐条回复审稿人 | `response-to-reviewers` |

上述 skill 是质量门禁，不得用来补造缺失数据；发现证据不足时回到数据、代码或文献来源，而不是继续润色。

| # | 阶段标记 | 说明 |
|---|---------|------|
| 1-3 | `project-intake` → `topic-discovery` → `topic-confirmation` | 建档、联网比较方向并确定研究问题 |
| 4-5 | `literature-search` → `literature-review` | 检索、精读、证据综合与引用库 |
| 6-7 | `protocol-design` → `outline-generation` | 冻结方案并建立论证结构，尚不写正文 |
| 8-9 | `experiment-execution` → `data-validation` | 运行程序并完成三重数据诚信校验 |
| 10 | `introduction-writing` | 数据门禁通过后撰写带真实参考文献的前言 |
| 11-14 | `methods-writing` → `results-writing` → `discussion-writing` → `manuscript-completion` | 方法、结果、讨论、摘要和结论逐段成稿 |
| 15-17 | `citation-verification` → `polishing` → `quality-validation` | 引用、保守润色、两轮跨模型评审改稿和独立投稿阻断审查 |
| 18-20 | `formatting` → `export` → `submission-readiness` | 期刊格式、Word/LaTeX/Markdown 交付和投稿清单 |

## 网页对话写作约束

- 不得在一次回复或一次 `write` 调用中生成整篇论文。
- 每一轮只完成一个正文段落：英文约 120–220 words，中文约 200–400 字。
- 文件不存在时先创建标题和章节骨架；文件存在时读取后用定点追加，禁止整文件覆盖。
- 必须先成功写入文件，再告知用户“已写完第几段”；禁止在工具调用前反复说“正在写”“马上写”或“直接写完整论文”。
- 一段写入后立即结束本轮，让持续目标从文件检查点开始下一段；传输中断后只续写未完成段落，不重写已保存内容。
- 写入失败时保留当前任务为进行中并报告真实错误，不得把计划、内部分析或未执行的工具调用当作写作进度。

## 进度展示指引

1. **开始前**：告知用户即将启动 20 阶段研究生命周期
2. **运行中**：将工具输出原样展示，用户通过 `[阶段 N/20]` 标记了解当前进度
3. **关键输出**：
   - `[阶段 N/20] stage-name` — 阶段开始
   - `[完成] stage-name` — 阶段完成
   - `[失败] stage-name` — 阶段失败
   - `[审批节点] 阶段: stage-name` — 审批节点
   - `[N/M] 撰写: 小节标题` — 逐段写作进度
4. **完成后**：告知用户输出文件在本篇论文的独立工作目录

## 模型路由

工具内部按任务自动选择模型：
- 联网选题：GPT-5.6 Sol（可由环境变量覆盖）
- 研究方案：Claude Opus 5（与选题模型交叉）
- 文献精读：GPT-5.6 Luna
- 大纲生成：GPT-5.6 Terra
- 段落写作：GPT-5.6 Terra
- 引用核验：GPT-5.6 Terra
- 润色：GPT-5.6 Luna

## 断点续跑

流程中断后，使用 `--output-dir` 指向本篇论文工作目录继续，状态保存在该目录内的 `.dsh-state/`。

## 输出文件

- `output/paper-projects/<项目ID>/final/` — Markdown、DOCX、LaTeX 与 BibTeX 最终交付件
- `output/paper-projects/<项目ID>/milestones/research-brief.md` — 研究任务书
- `output/paper-projects/<项目ID>/milestones/topic-discovery.md` — 联网选题证据
- `output/paper-projects/<项目ID>/milestones/analysis-plan.md` — 冻结研究方案
- `output/paper-projects/<项目ID>/milestones/claim-evidence-matrix.md` — 主张-证据矩阵
- `output/paper-projects/<项目ID>/milestones/data-validation.md` — 数据验收记录
- `output/paper-projects/<项目ID>/milestones/reproducibility/` — 实验代码、数据来源清单、清洗后数据和机器可读结果
- `output/paper-projects/<项目ID>/milestones/scientific-review-round-1.md` 与 `scientific-review-round-2.md` — 两轮跨模型专家评审及改稿记录
- `output/paper-projects/<项目ID>/milestones/` 中的 citation、quality、DOCX 与 submission 报告 — 最终门禁记录
- `output/paper-projects/<项目ID>/.dsh-state/` — 隐藏断点状态；其中临时运行区只在任务未完成时存在

导出 Word 时不得用普通文本替代公式，也不得在 Pandoc 失败后把 Markdown 文件报告为 DOCX 成功；失败时保留源 Markdown 并向用户显示真实错误。
