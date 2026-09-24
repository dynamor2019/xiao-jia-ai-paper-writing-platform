---
name: literature-review
description: 为学术论文撰写系统性文献综述（独立综述论文或论文文献综述章节）；提供从选题、检索策略、PRISMA 2020 筛选流程、批判性阅读、主题分析到结构化写作的全流程指导。涉及文献检索、研究空白识别、定性主题分析（Braun & Clarke）或系统综述时使用。
---

# Literature Review — 系统性文献综述工作流

## 适用场景

| 任务 | 使用本 skill |
|------|-------------|
| 独立文献综述论文 | ✓ |
| 论文 §2 文献综述章节 | ✓（简化版，跳过 PRISMA 流程图） |
| 系统综述 / Meta 分析 | ✓（PRISMA 流程）+ `statistical-reporting`（荟萃分析统计） |
| 快速文献背景查阅 | × → 直接用 `corpus-memory` + `claim-evidence-matrix` |

---

## 第一阶段：检索策略设计

### 1.1 研究问题精炼（PICO / SPIDER 框架）

定义前须明确可回答性：仅通过现有文献回顾就能回答，不需要收集新数据。

```
P — 研究总体 / 问题（Population / Problem）
I — 干预 / 现象（Intervention / Issue）
C — 对照 / 背景（Comparison / Context）
O — 结局（Outcome）
```

研究问题保存到 `milestones/lit-review-brief.md`，包含：问题陈述、纳入排除标准初稿、时间范围、语言范围。

### 1.2 关键词矩阵

```
主概念           同义词 / 变体                布尔连接
─────────────────────────────────────────────────
[概念 A]         [A1] OR [A2] OR [A3]         AND
[概念 B]         [B1] OR [B2]                 AND
[排除术语]        NOT [X1] NOT [X2]
```

检索式要保存到 `milestones/search-strings.md`，并记录每个数据库的实际检索式（不同数据库语法不同）。

### 1.3 数据库清单

根据学科选择：

| 学科 | 首选数据库 |
|------|-----------|
| 工程 / 计算机 | IEEE Xplore、ACM DL、Scopus、Web of Science |
| 经济 / 管理 | EconLit、SSRN、Web of Science、JSTOR |
| 医学 / 公卫 | PubMed / MEDLINE、Cochrane、Embase |
| 综合 | Scopus、Web of Science、Google Scholar（补充） |
| 中文 | CNKI、万方、维普 |
| 开放 | OpenAlex（2.4 亿+ 学术作品，免费 API） |

追加手动检索：关键期刊卷期翻查、参考文献雪球、灰色文献（报告、学位论文）。

---

## 第二阶段：PRISMA 2020 筛选流程

PRISMA 用于**系统综述**；普通论文的文献综述章节可简化，但须说明纳排规则。

### 筛选四阶段

```
识别（Identification）
  ├─ 数据库检索：N = ____（去重前）
  ├─ 去重后：N = ____
  └─ 其他来源（手动/雪球）：N = ____

筛选（Screening）
  ├─ 标题/摘要审读：排除 N = ____（原因：____）
  └─ 全文获取：N = ____

资格评估（Eligibility）
  ├─ 全文审读：排除 N = ____（原因逐条列出）
  └─ 纳入分析：N = ____

纳入（Included）
  └─ 最终纳入：N = ____
```

保存 PRISMA 流程数字到 `milestones/prisma-counts.json`，输出流程图到 `figures/prisma-flow.png`。

### 纳入/排除标准（须在检索前冻结）

| 维度 | 纳入标准 | 排除标准 |
|------|---------|---------|
| 研究类型 | | |
| 时间范围 | | |
| 语言 | | |
| 研究总体 | | |
| 结局变量 | | |
| 其他 | | |

**双人独立筛选**（系统综述要求）：记录初始一致率（Cohen's κ ≥ 0.80 为良好）；分歧由第三人裁定。

---

## 第三阶段：数据提取与质量评估

### 提取表模板（`milestones/extraction-table.tsv`）

```
paper_id | first_author | year | journal | country | study_design |
sample_n | treatment | outcome | main_finding | effect_size |
limitations | bias_risk | notes
```

### 偏倚风险评估工具

| 研究类型 | 推荐工具 |
|---------|---------|
| RCT | Cochrane RoB 2 |
| 观察研究 | Newcastle-Ottawa Scale (NOS) |
| 诊断研究 | QUADAS-2 |
| 定性研究 | CASP 清单 |
| 系统综述 | AMSTAR 2 |

---

## 第四阶段：主题分析（Braun & Clarke 六阶段）

定性综述或混合综述采用此流程；纯定量系统综述跳过此阶段。

1. **熟悉数据**：通读全文，初步记录想法。
2. **初始编码**：系统标记数据中有意义的片段，保持描述层面。
3. **寻找主题**：将编码归组，形成候选主题。
4. **审查主题**：反复比对原文，合并/拆分/舍弃主题。
5. **定义命名**：为每个主题起精确名称，写主题定义。
6. **撰写报告**：将主题组织为叙事，嵌入代表性引用。

输出：`milestones/thematic-map.md`（主题-编码-文献来源三级结构）。

---

## 第五阶段：综合与差距识别

### 必须识别的五类信息

| 要素 | 说明 | 如何呈现 |
|------|------|---------|
| **趋势与模式** | 方法/理论/结果随时间的演变 | 时序叙述 |
| **反复出现的主题** | 跨文献共同概念 | 主题小节 |
| **争议与矛盾** | 文献间分歧 | 对比段落 |
| **关键里程碑论文** | 改变领域方向的文献 | 明确标出，不埋没 |
| **研究空白** | 未回答的问题、方法局限、人群盲点 | 结论前独立小节 |

研究空白须具体（如"现有研究样本集中于高收入国家，发展中国家情境下的效果尚不明确"），不得只写"需要更多研究"。

---

## 第六阶段：写作规范

### 结构（独立文献综述论文）

```
1. 引言（背景 + 综述必要性 + 研究问题 + 结构预告）
2. 检索方法（数据库、检索式、纳排标准、PRISMA 流程）
3. 文献综合（按主题/时序/方法论分节）
4. 讨论（争议、研究空白、局限）
5. 结论（核心发现 + 未来研究方向）
参考文献
附录（PRISMA 清单、提取表、偏倚风险表）
```

### 写作质量控制

- **综合而非罗列**：不得逐篇"Author(year) found…"堆砌，需跨文献综合。
- **批判性评估**：每项主要发现须提及方法局限或证据强度。
- **证据层级意识**：RCT/SR > 队列研究 > 横截面 > 案例研究；不同来源不等权。
- **引用一致性**：正文引用与参考文献列表双向对应（引用核验使用 `claim-evidence-matrix`）。
- **时效性**：近 5 年文献不得低于 30%；不得将综述代替决定性的原始研究证据。

### PRISMA 2020 报告清单（27 项，提交系统综述时必须附）

| # | 条目 | 位置 |
|---|------|------|
| 1 | 标题识别（系统综述/Meta分析） | 标题 |
| 2 | 摘要结构化（PRISMA-A 扩展） | 摘要 |
| 3-4 | 理论基础、目标 | 引言 |
| 5-10 | 资格标准、信息来源、检索策略、选择过程、数据收集、数据条目 | 方法 |
| 11-12 | 偏倚风险、效应量测量 | 方法 |
| 13-15 | 综合方法、报告偏倚评估、确定性评估 | 方法 |
| 16 | 研究筛选结果（PRISMA 流程图） | 结果 |
| 17-21 | 研究特征、偏倚风险、单项结果、综合结果、报告偏倚 | 结果 |
| 22-23 | 确定性/可信度、局限 | 讨论 |
| 24-27 | 结论、资金来源、利益冲突、注册/协议 | 结论/其他 |

---

## 工具推荐

| 用途 | 工具 |
|------|------|
| 文献管理 | Zotero（推荐，免费）、Mendeley、EndNote |
| 筛选协作 | Rayyan、Covidence |
| 文献检索 API | OpenAlex（`pyalex`）、Semantic Scholar、PubMed Entrez |
| 主题分析辅助 | NVivo、ATLAS.ti、MAXQDA |
| PRISMA 流程图 | `prismaflowdiagram`（Python）、draw.io |

依据：[PRISMA 2020 Statement](https://www.prisma-statement.org/) · [Braun & Clarke (2006) Thematic Analysis](https://doi.org/10.1191/1478088706qp063oa) · [Cochrane Handbook v6](https://training.cochrane.org/handbook)。
