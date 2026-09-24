---
name: citation-integrity
description: 学术论文引用完整性核验：定位前因文献、构建文献定位图、五步核验每条引用（存在性/字段/主张/状态/台账）、检测 AI 幻觉引用（包括嵌合型）、通过 OpenAlex CLI 查询文献元数据。AI 辅助写作论文的投稿前必须运行此 skill，任何存在"从记忆生成"嫌疑的引用必须核验。
---

# Citation Integrity — 文献核验全套

> **没有一条引用从记忆中来。** 每一个 `\cite{}` 都必须对照可获取的记录核验后才能留在文稿中。AI 辅助写作的核心风险是幻觉引用——真实作者 + 捏造标题（嵌合型）是最危险的，因为审稿人在 Google Scholar 上找不到，但文献库里有同名作者。

---

## 引用的两项工作

### 工作 1 — 文献定位（在写作前完成）

找出 **3–6 篇最近的前因文献**，填写前因文献表：

```
| 论文 | 研究问题 | 数据/情境 | 识别方法 | 主要发现 | 它没有做的事 |
|---|---|---|---|---|---|
| A (2019) | ... | ... | ... | ... | ... |
```

规则：
- "它没有做的事"必须是关于那篇论文的**事实**，不是对它的贬低
- 如果最近的前因文献使用同样的数据和同样的设计，**贡献主张必须修改**，回到 `causal-inference` 重新设计
- 逐行核验至少达到 `published version`——工作论文与发表版经常不同

**五个检索渠道**（每个渠道找到的论文不重叠，缺一不可）：

1. **工作论文系列**：NBER、CEPR、IZA、SSRN、BFI。被抢先的风险几乎总是来自未发表工作论文，不是已发表论文。
2. **Google Scholar + IDEAS/RePEc**：按研究问题、方法+情境、数据集名称分别搜索。
3. **被引追踪**：从 2–3 篇最明显的前因文献出发，检查所有引用它的论文（按时间倒排）。
4. **近期目录浏览**：目标期刊及其同级期刊近 3–5 年目录，扫描标题。
5. **综述 / JEP**：该领域的综述文章和 *Journal of Economic Perspectives* 是领域自我梳理的地图。

**价值贡献动作（必须明确选一个）**：

| 动作 | 当条件满足时 |
|---|---|
| 新研究问题 | 无前因论文提问此问题 |
| 更可信的识别 | 前因论文使用相关性方法或已被否定的设计 |
| 新数据 | 前因论文缺乏分辨率、覆盖或连接 |
| 新机制 | "是否有效应"已知，"为什么"未知 |
| 符号翻转 / 量级修正 | 可信识别产生不同于既有共识的结果 |
| 统一两条文献 | 两个看似矛盾的文献被单一框架解释 |

---

### 工作 2 — 引用完整性五步协议（写完后、投稿前）

**每条引用**逐步核验，记录到台账。不能跳过任何步骤。

#### 步骤 1 — 存在性

用以下方式之一获取可信记录：

```bash
# 选项 A：OpenAlex CLI（推荐，240M+ 文献）
openalex works search "Callaway Sant'Anna difference-in-differences" --per-page 3
openalex works get https://doi.org/10.1016/j.jeconom.2020.12.001
openalex works get 10.1016/j.jeconom.2020.12.001 --format bibtex   # 直接导出 BibTeX

# 选项 B：跨库 Python 核验（CrossRef + Semantic Scholar + OpenAlex 三库交叉）
python scripts/citation_checker.py references.bib
# 退出码：0=全部核验 / 1=有未找到 / 2=仅可疑
```

**规则**：DOI 无法解析且三个库均无记录 → 该引用不得进入文稿。

#### 步骤 2 — 字段准确性

逐字符比对（对照 CrossRef 或期刊页面）：

- [ ] 作者全名和顺序（含变音符）
- [ ] 年份（工作论文与发表版年份不同）
- [ ] **精确标题**（一个词的差异可能指向不同论文）
- [ ] 期刊名（AEJ:Applied ≠ AEJ:Policy）
- [ ] 卷、期、页码、DOI

**最常见 AI 腐蚀模式**：交换共同作者顺序、工作论文年份 vs 发表年份差一年、把真实作者对配到捏造标题（嵌合型）。

#### 步骤 3 — 主张准确性

对每个 "Author (year) find/show/argue X" 的句子：读摘要，若引用了量值则读原文对应表格。核验：

- [ ] 符号正确
- [ ] 量值量级正确
- [ ] 总体和情境与论文主张匹配
- [ ] 设计局限未被过度外推
- [ ] 对**真实论文**的主张误读比对捏造论文更有破坏性（审稿人可能就是作者）

#### 步骤 4 — 状态核验

- [ ] 该论文是否被撤稿或更正？（检查 Retraction Watch 或期刊网站）
- [ ] 工作论文是否已正式发表？（已发表须引发表版）
- [ ] 数据/结论是否已有实质性修订？

#### 步骤 5 — 台账

维护 `citation-ledger.tsv`，每行一条引用：

```
KEY                  DOI-OK  FIELDS-OK  CLAIM-OK  VERSION       CHECKED-BY  DATE
goodman_bacon_2021   yes     yes        yes       published     manual      2026-09-22
callaway_santa_2021  yes     yes        yes       published     openalex    2026-09-22
```

**规则**：任何行未达到全部 `yes` → 从文稿中移除或明确标注"unverified"给作者处理。**永远不能悄悄保留未核验引用。**

---

## 使用 OpenAlex CLI 的常用查询

```bash
# 搜索论文
openalex works search "staggered difference in differences" --per-page 5

# 按 DOI 获取（自动导出 BibTeX）
openalex works get 10.3982/ECTA16484 --format bibtex

# 查被引（追踪引用了某前因文献的后续论文）
openalex works cited-by W2741809807 --per-page 10

# 按作者查全部论文
openalex authors search "Callaway Brantly" --per-page 3
openalex works list --filter author.orcid:0000-0001-9999-xxxx --sort cited_by_count:desc

# 查期刊近几年目录
openalex works list \
  --filter primary_location.source.display_name:"American Economic Review" \
  --filter publication_year:>2022 \
  --sort publication_date:desc --per-page 20
```

---

## 嵌合型引用检测

嵌合型 = 真实标题 + 错误作者（或真实作者 + 捏造标题）。AI 模型最擅长产生这种类型。

检测方法：

```python
# citation_checker.py 自动检测
python scripts/citation_checker.py references.bib --verbose
# 输出: CHIMERIC 标记 = 标题与作者在数据库中找不到组合匹配
```

手动检测标志：
- Google Scholar 有这个标题，但作者不同
- BibTeX 年份与已知的发表时间线矛盾
- 你"记得"读过但找不到 PDF 原文

---

## BibTeX 卫生规范

- **统一键名**：`lastname_year`（多作者：`lastname1_lastname2_year`）
- 每条 entry 必须含 DOI 或注明"无DOI，已核验URL：<url>"
- 无重复键
- 已发表论文不引用工作论文版（除非发表版确实尚未出现）
- 投稿时检查全部 `\cite{key}` 均能在 `.bib` 中解析（LaTeX 零 unresolved warning）

---

## 引用数量基准

| 期刊类型 | 典型引用量 |
|---|---|
| AER 全文 | 50–110 条 |
| AER:Insights | 明显更少 |
| 方法论论文 | 可更多，但须有用 |

多了是padding（怀疑），少了是不知道文献（也怀疑）。**不要为了取悦潜在审稿人而引用不相关论文**。

---

## 交接

引用台账全部 `yes` 后，路由到：
- `pre-submission-review`（数字一致性 + 模拟审稿）
- `submission-readiness`（最终投稿前清单）
