---
name: computational-reproducibility
description: 为计算、仿真、AI 和工程实验论文建立可复现性清单与制品说明；撰写方法、实验设置、数据代码声明或投稿制品包时使用。
---

# Computational Reproducibility

## 可复现清单

在 `reproducibility/manifest.md` 记录并核对：

- 数据来源、许可、版本、纳入/排除规则、清洗与划分方式。
- 代码版本或提交号、依赖锁定、操作系统、运行环境和安装步骤。
- 硬件、随机种子、超参数、停止条件、重复次数和资源预算。
- 从原始数据到每个主表/主图的单一运行命令、预期输出和必要校验值。
- 外部服务、专有软件、私有数据和不可公开部分的可替代验证路径。

## 三重数据校验

正式行文前必须完成三次性质不同的检查，不得把重复读取同一文件冒充独立验证：

1. **结构与完整性**：由确定性程序检查 schema、样本主键、行数、重复、缺失、非有限值、单位、合法范围及结果哈希。
2. **科学与统计**：从冻结方案核对纳排规则、数据泄漏、分析单位、独立性、检验假设、效应量与区间、基线、消融、敏感性、失败运行和反例；不利结果必须保留。
3. **独立复算**：从原始输入用独立入口重新生成主统计量、主表和主图，并逐项比较；代码、输入、输出和环境均记录哈希。随机实验比较预先声明的容差与统计结论，不要求字节完全相同。

每次失败都记录到 `data-validation-history.tsv`，修复代码或数据来源后从第 1 步重新开始。禁止直接编辑机器结果、复制正文数字到脚本、删除失败样本或只重跑不利的随机种子。`data-validation.json` 的结果哈希与当前结果不一致时，所有写作和导出立即 BLOCKED。

`statistical-audit.json` 与 `reproduction-check.json` 必须由保存的程序生成，并至少包含：`status`、`resultSha256`、`command`、非空 `sourceHashes`，以及由 `name`、`status`、`evidence` 组成的检查数组。所有检查均为 PASS 且绑定当前结果哈希时才有效；模型手写一句 PASS 不构成证据。

## 写作规则

方法章节应提供独立研究者复现实验所需的信息，但不要把安装手册塞进正文；细节放入附录或制品说明。明确区分：

- `available`：制品可取得。
- `functional`：制品可运行。
- `reusable`：文档和结构支持复用。
- `reproduced/replicated`：已有独立验证。

除非确有独立验证，不得声称“结果已复现”。无法共享时如实写明原因、访问条件和对验证范围的影响。

终检时从干净环境复算全部主结论；至少逐项核对每个主表和主图所依赖的统计输出，并把失败保留在 `reviews/reproducibility-audit.md`。

依据：[IEEE Research Reproducibility](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/research-reproducibility/)。

## 预注册与预分析计划（PAP）

实验或观察研究开始**前**，将以下内容持久化为 `milestones/reproducibility/pap.json`，并在 `milestones/reproducibility/empirical-manifest.json` 的 `evidence.pap` 中登记文件 SHA256。看到数据后修改方案须写入 amendment 并追加新版本号，不得静默覆盖。

```json
{
  "population":      "描述研究总体",
  "treatment":       "处理变量及赋值方式",
  "outcome":         "主要结局变量（仅一个）",
  "estimand":        "ATE / ATT / LATE / CATE（明确说明）",
  "design":          "DID / RDD / IV / RCT / 匹配 / 其他",
  "alpha":           0.05,
  "power_target":    0.80,
  "mde":             "最小可探测效应量（Cohen's d 或绝对差）",
  "n_planned":       0,
  "frozen_at":       "ISO 8601 时间戳",
  "git_sha":         "<提交哈希>",
  "secondary_outcomes": [],
  "subgroup_analyses":  [],
  "stopping_rules":     ""
}
```

**功效计算最低要求**：报告样本量依据（α、功效、MDE），RCT 须注明设计效应（如分群随机）；观察研究须说明样本量如何达到充分统计功效，或明确承认功效不足为局限。

## 五项数据合约

在 `milestones/reproducibility/data-contract.json` 保存，任一项 FAIL 时停止流水线：

1. **形状与键**：观测数与预期相符；面板键 (id, time) 无重复。
2. **类型与缺失**：关键变量 dtype 正确，关键字段缺失值为零（或记录处理方式）。
3. **取值域**：数值变量在合法范围内（负工资、年龄 > 200 等触发报错）。
4. **面板平衡**：记录是否平衡、不平衡原因及影响。
5. **MCAR 嗅探**：若 Y 的缺失与协变量相关（t 检验 p < 0.05），listwise 删除会引入偏误，须改用 MI / IPW 并记录。

## 样本构建日志（脚注 4 规范）

每次筛选步骤打印并保存到 `milestones/reproducibility/sample-construction.json`：

```
原始数据                     N = xxx,xxx
1. 删除缺失主结局             N = xxx,xxx
2. 限年龄 18–65               N = xxx,xxx
3. 保留目标行业               N = xxx,xxx
最终分析样本                  N = xxx,xxx
```

该日志直接粘贴为论文脚注；任何步骤删除 > 5% 须在方法中说明原因。

## 复现包标准（AEA / 顶刊风格）

`milestones/reproducibility/empirical-manifest.json` 须包含：当前机器结果文件完整 SHA256、Python/Stata/R 版本、随机种子、数据集 SHA256 前 16 位、样本量、估计量、聚类标准误、95% CI、预分析计划文件路径、数据合约路径、样本日志路径，以及每个表图是否适用的证据记录。

README 须在干净环境中可用单条命令重现所有主表和主图；不得依赖"在我的机器上能运行"的私有路径或未锁定依赖。

依据：[AEA 数据与代码可用性政策](https://www.aeaweb.org/journals/data/data-code-policy) · [TIER Protocol 4.0](https://www.projecttier.org/)。

## AEA 复现包规范（接受后提交）

本节基于 AEA 2026 年 2 月版数据与代码可用性政策。

### 目录结构（推荐）

```
replication-package/
├── README.pdf                     ← AEA 最终存档必须为 PDF
├── README.md                      ← 可编辑源文件（可选）
├── LICENSE                        ← 代码 MIT/BSD；数据遵原始许可
├── data/
│   ├── raw/                       ← 原始文件，从不修改
│   ├── intermediate/              ← 清洗后分析数据集
│   └── codebook/source-register.md  ← 每个数据源：来源/许可/访问方式/访问日期
├── code/
│   ├── 00_setup.do   (或 .R / .py)
│   ├── 01_clean.do
│   ├── 02_analysis.do
│   ├── 03_tables.do
│   └── 04_figures.do
├── output/
│   ├── tables/
│   └── figures/
└── docs/
    ├── exhibit-register.md        ← 图表-脚本映射表（按发表顺序）
    └── computing_environment.txt  ← OS/软件/包版本/预计运行时间
```

### README 七节要求

AEA Data Editor 审查 README 是否包含以下七节；缺任何一节都会退回：

1. **总览**：包含什么、对应哪篇论文、需要什么软件
2. **数据可用性声明**：每个数据集 → 来源/引用/许可/访问日期/是否已存档或原因
3. **数据集列表**：文件名 | 描述 | 来源 | 备注
4. **计算需求**：操作系统、软件版本、依赖包精确版本、估计运行时间、内存需求
5. **程序说明**：每个脚本做什么、运行顺序
6. **复现步骤**：字面步骤（下载 → 解压 → 设置路径 → 运行 master 脚本）
7. **图表-脚本映射表**

### 图表-脚本映射表格式

```
| 图/表 | 脚本 | 脚本行号 | 输出文件 |
|---|---|---|---|
| Table 1 | 03_tables.do | 12 | output/tables/tab1.tex |
| Figure 2 | 04_figures.do | 8 | output/figures/fig2.pdf |
```

每个发表图/表必须有对应行；手绘/概念图须标注"概念图，非程序生成"。

### Data Editor 实际检查的五件事

1. README 是否存在且按模板填写？
2. master 脚本能否端到端运行无报错？
3. 生成的数字是否与发表版匹配？
4. 每个数据源是否有完整溯源文档？
5. 数据存档是否完整，或受限原因是否充分说明？

### 受限数据处理

若数据无法公开：
- README 中提供**精确的获取说明**（机构名称、申请流程、预计费用和周期）
- 提供能在合规访问后运行的**完整代码**
- 可选：提供保留相同 schema 的**合成数据**，用于代码冒烟测试
- 承诺保留数据和代码 ≥ 5 年并响应合理复现请求

### 常见 Data Editor 退回原因

- 硬编码绝对路径（`/Users/firstname/...`）
- 缺少软件包版本记录
- master 脚本在干净环境报错
- 发表表格与存档生成的表格数值不同
- 受限数据无溯源文档
- 把 main result 放在 appendix 里而不在主包里

依据：[AEA 数据与代码可用性政策 2026-02](https://www.aeaweb.org/journals/data/data-code-policy) · [TIER Protocol 4.0](https://www.projecttier.org/) · [Horiuchi replication-package-guide](https://github.com/yhoriuchi/replication-package-guide)。
