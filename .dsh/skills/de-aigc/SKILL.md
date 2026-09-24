---
name: de-aigc
description: 对学术论文草稿进行 AI 写作痕迹审计与改写，降低 Turnitin AI、GPTZero、知网 AIGC 检测、万方查重等工具的检出信号；支持中英双语，专门针对理工/社科实证类论文风格。输出前必须保留学术准确性，不得篡改数据、结论或引用。投稿前在完稿上运行，不在起草过程中运行。
---

# De-AIGC — 学术论文 AI 痕迹审计与改写

> **在完稿上运行，不在起草中运行。** 边写边降 AI 味会干扰写作过程；本 skill 设计为最终润色步骤，在 `pre-submission-review` 通过后运行。

---

## 水印的三种类型（必须分开处理）

2026 年有三种不同的东西都被叫做"AI 水印"，本 skill 对每种的处理方式不同，每次报告都会说明核验了哪一层：

| 层级 | 是什么 | 本 skill 处理方式 |
|---|---|---|
| **A · 字符载体** | 零宽字符、BiDi 控制符、tag 字符、软连字符等——Claude 本身**不使用**，但复制粘贴链、第三方工具常引入 | `provenance_scrub.py inspect/clean` — 确定性，CJK 安全 |
| **B · 统计水印** | Claude（≥2026-08-02 发布的模型）和 Gemini 对词语采样有偏——无公开检测器 | **所有权改写（Ownership Pass）**——作者亲写关键段落；agent 改写仍是模型输出 |
| **C · 容器元数据** | `.docx` 的 docProps/comments/people.xml；图片的 C2PA manifest；PDF 的 XMP | `provenance_scrub.py clean` + `exiftool`/`qpdf` |

**规则：本 skill 永远不声称文本"无水印"。** 报告只说明 A 层和 C 层已核验，B 层标注为 unknown。

---

## 六步闭环

```
0. 摄入与路由    1. 审计扫描     2. 主张-证据核查
   Intake     →    Audit      →   Claim-evidence
                                       │
5. 冷读复查    4. 五维自评     3. 差异化改写
   Recheck   ←   Self-score  ←    Rewrite
```

Provenance 层贯穿其中：`inspect` 在步骤 1 之前运行（字符载体会污染 n-gram 扫描），`clean` 在步骤 5 运行。

---

### 步骤 0 — 摄入与路由

运行前：
1. **检测语言**：中文 → ZH 模式；英文 → EN 模式；混合 → 各部分独立处理后检查跨语言一致性
2. **映射章节**：摘要 / 引言 / 文献 / 数据 / 实证策略 / 结果 / 机制 / 稳健性 / 讨论 / 结论（各章节改写强度不同，见步骤 3）
3. **识别投稿场景**：CSSCI 中文期刊 / SSCI 英文期刊 / 学位论文（容忍第一人称和谨慎措辞的程度不同）
4. **获取作者声音样本**（可选，效果最好）：若作者有此前的人工撰写段落，对照其句长习惯、连接词使用和谨慎措辞风格，而不是通用"人类风格"
5. **Provenance 扫描**：`python scripts/provenance_scrub.py inspect draft.docx figures/*.png`

```bash
# 检查模式（不修改文件，exit 1 if found）
python scripts/provenance_scrub.py inspect main.docx figures/*.png

# 清理模式（写入 main.clean.docx，docProps blanked）
python scripts/provenance_scrub.py clean main.docx --lang zh

# diff 模式（显示隐藏字符的位置）
python scripts/provenance_scrub.py clean draft.md --diff
```

---

### 步骤 1 — 审计扫描

扫描全文并输出结构化审计报告——**此步骤只扫描，不修改**：

```markdown
## AI 痕迹审计报告

| 段落 | 原文片段 | 规则 | 严重度 |
|---|---|---|---|
| 引言§2 | "毋庸置疑，数字化转型…" | ZH01 四字套话 | 🔴 |
| 结果§3 | "…, underscoring the importance of…" | EN02 -ing尾 | 🔴 |
| 结果§4 | "This proves that the reform caused…" | EN10 过强动词 | 🔴 |

总结：🔴 Critical 3 处；🟡 Major 7 处；🟢 Minor 12 处
预计改写深度：全文精改
Provenance: A层字符载体 0个；C层 docx 作者字段有内容（建议清理）；B层 unknown
```

初步评分 < 3.0 → 全文改写；3.0–4.0 → 定向优化；> 4.0 → 仅校对。

---

### 步骤 2 — 主张-证据核查（改写前必做）

改写不得破坏主张强度与证据的对应关系：

- 每个定量数字（系数、p 值、样本量、百分点）改写前后必须完全一致
- 动词强度与识别设计匹配：
  - 干净 DID/IV/RD → 直接因果陈述可以
  - 观察性 OLS → 只能用"associated with / 与……相关"
  - 机制证据 → "is consistent with / 与……一致"
- 如果发现主张无锚（没有表格/系数/引用支撑）→ 标注给作者，不改写，不用模糊语言掩盖

记录到 `reviews/de-aigc-claim-check.md`；有不一致项时停止，先修复数据来源。

---

### 步骤 3 — 差异化改写

**优先级顺序（影响最大的先做）**：

#### 1. 打破句长天花板（中英文最高杠杆操作）

每 ~200 词（或 200 字）中：至少一个短句（≤8 词 / ≤15 字）+ 至少一个长句（≥40 词 / ≥50 字）。短句用来开放问题或落地强调；长句承载证据。

AI 文本的最显著特征是**句长方差极低**（几乎全部落在 20–30 词带），这一特征比词汇选择更容易被检测器捕捉。

#### 2. 具体化（替换泛化表述）

| 原文 | 改写 |
|---|---|
| 相关研究表明 | Acemoglu and Restrepo (2020) 估计… |
| profound impact | 使 TFP 提高了 4.3%（t = 3.81） |
| 广泛应用于 | 在 [具体机构/地区/时期] 使用 |

#### 3. 拆除脚手架（删除结构连接词）

删除段首 Moreover / Furthermore / 此外 / 因此 / 在此基础上；改用**语义接力**（下一句开头延续上一句的关键名词）。

例外：真正需要并列的地方保留；不要走极端把所有连接词都删掉。

#### 4. 校准断言强度

- 过强 → 加认知对冲："This likely reflects / 这可能反映…"
- 过弱/过于堆叠 → 删除 "may potentially suggest the possibility that…" 中的冗余对冲

#### 5. 恢复研究者声音（B 层所有权改写）

在**高信号区段**（摘要 / 引言 / 文献综述主张 / 讨论 / 结论）：

本 skill 交付**改写简报**，不交付最终文本：
```
段落目标：[本段须表达什么]
锚点：[表 3 列 4；引用 Autor 2003]
句长布局：[第1句短句：落地发现；第2–3句长句：证据；第4句短句：含义]
已触发规则：EN02 EN10
建议改写（参考）：[...]
```
作者阅读简报后**自行撰写最终句子**，agent 检查忠实度和流畅度，不再改写。

低信号区段（数据节、方程、表格注释、稳健性列表）可保留 agent 润色结果。

每段在变更日志中标注：`author-voiced` / `model-suggested-author-accepted` / `untouched`。

**硬性红线（任何情况下都不做）**：
- 修改数字、系数、标准误、p 值、样本量、方程、变量名、引用内容
- 编造数据、结果或"令人惊讶的发现"来增加趣味性
- 注入错误、俚语或古英语来增大困惑度（检测器不受骗，评审会注意到）
- 改变论文的实质主张
- 将"watermark-free / 无水印 / undetectable / 过检"写入任何报告

---

### 步骤 4 — 五维自评（1–10 分）

| 维度 | 权重 | 检查点 |
|---|---|---|
| 具体性 | 1.5× | 泛化主张已替换为数据/作者/案例？ |
| 节奏性 | 1.2× | 句长方差足够？短-长搭配到位？ |
| 谨慎性 | 1.3× | 动词与证据匹配？对冲措辞存在但不堆叠？ |
| 隐性衔接 | 1.0× | 段落通过语义接力，不是连接词驱动？ |
| 研究者语气 | 1.0× | 选择、权衡、局限可见？ |

**加权总分 < 35 → 返回步骤 3；≥ 42 → 通过。**

---

### 步骤 5 — 冷读复查

以陌生读者身份重读全文，执行三项检查：

1. **流畅度**：修改是否损害了论点的流动或学术语域？
2. **忠实度**：逐字 diff 所有数字、姓名、年份、引用——零漂移
3. **一致性**：全文声音统一；改写段与未改写段无明显缝隙；中英混合稿件两种语言表达同等强度的相同主张

**包卫生（Package Hygiene）**：

```bash
# 最终 .docx 清理
python scripts/provenance_scrub.py clean final.docx --lang zh
# 输出: final.clean.docx（docProps 已清除）

# PDF 元数据清理（报告命令，需要用户在本地执行）
exiftool -all= paper.pdf
qpdf --linearize paper.pdf paper.clean.pdf

# 图片 EXIF 清理
exiftool -all= figures/*.png figures/*.jpg
```

- Word 修订痕迹和评论须在导出前清除
- `people.xml` 中的贡献者信息须清除（双盲投稿要求）
- 删除 tracked changes，接受所有修订

**最终交付**：干净文本 + 变更日志（哪些段已改写 + 触发规则 + 哪些段为作者声音） + Provenance 报告（A/C 层已核验，B 层 unknown）

---

## SSCI 英文三遍润色流程

在降 AI 痕迹完成后，若用户需要进一步提升英文投稿质量，执行以下三遍：

### 第一遍 — 语法与机械错误

- 主谓一致、代词指称、时态一致性（发现用现在时；描述数据收集用过去时）
- 逗号连缀、句段碎片、并列结构不平行
- 混淆词（affect/effect、imply/infer、comprise/constitute）
- 标点规范（em-dash vs en-dash vs 连字符；引号配对）
- 所有超过 40 词的句子必须拆分（学术期刊标准）

### 第二遍 — 风格与可读性（Strunk & White + McCloskey 原则）

核心规则（Strunk Rule 17）：**省略不必要的词。**

| 删除 | 理由 |
|---|---|
| "It is worth noting that" | 直接陈述事实 |
| "It should be noted" | 同上 |
| "In order to" | 直接用 "to" |
| "Due to the fact that" | 用 "because" |
| "perform/conduct/carry out a regression" | 用 "estimate" 或 "regress Y on X" |
| "Results are reported in Table X" | 改为 "Table X shows..." |

其他规则：
- 主动语态（结果/方法节的被动语态例外：描述无关主体时）
- 简单词优先：use / but / so / people（不用 utilize / however / consequently / agents）
- 名词 + 动词优先，减少形容词 + 副词
- 一个词对应一个含义，不为"优雅变化"而换同义词

### 第三遍 — 学术规范与技术精确性（Thomson 原则）

- 所有符号在首次出现前定义
- 关键方程前后有文字说明（"企业利润为…"后才出现公式）
- 命题 → 直觉性解释 → 正式证明（按此顺序）
- 只给被正文引用的方程编号
- 表格标题为声明式（陈述表格结论，不只是描述内容）
- 引言不以"经济学家长期关注……"或"文献缺少……"开头
- 文献综述叙述故事（有 however 转折），不列举（Smith (2020) found X. Jones (2021) found Y.）

**不改的内容**：技术术语、已定义的符号和变量名、作者的实质性论点和结论、引用格式（除非明显错误）。

---

## 学术诚信声明

本 skill 的目标是**将人工写作和 AI 辅助写作恢复到真实研究者的语言分布**，而不是帮助纯 AI 生成的内容规避检测。

✅ 研究者自己的草稿被检测器误判为 AI  
✅ AI 辅助起草 + 研究者修改，作者对每个主张负责  
✅ 清理投稿包的溯源标记（双盲审稿本来就要求这样做）  
❌ 纯 AI 生成的论文试图伪装成人工写作  
❌ 幽灵写作、抄袭洗白、数据捏造  
❌ 利用 provenance 层隐藏模型作者身份，规避期刊 AI 披露要求（要求披露时须披露）

**学术诚信优先于检测分数。** 任何改写都不能触碰研究主张、数据或引用——发现证据不足时，正确的做法是标注给作者，而不是用模糊语言掩盖。
