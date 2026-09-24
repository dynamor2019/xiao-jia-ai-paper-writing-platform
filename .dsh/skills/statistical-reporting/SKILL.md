---
name: statistical-reporting
description: 审核和撰写科技论文中的统计分析与定量结果；涉及样本量、误差、不确定性、显著性、效应量、模型性能、消融或稳健性分析，以及因果推断识别策略选择、计量经济学规范报告时使用。
---

# Statistical Reporting

## 数据优先

先读取原始结果、分析代码和机器生成的统计输出，再写正文；不得靠心算、上下文记忆或语言模型重新计算关键数字。重新分析时保存可运行脚本和结果表，并区分预设分析与探索性分析。

每个正文数字、图内数字和统计标记必须登记到 `milestones/reproducibility/result-provenance.tsv`：`claim_id | manuscript_value | source_file | source_sha256 | row_filter | columns | analysis_script | output_field | status`。`status` 不是 VERIFIED 时禁止写入稿件。绘图脚本只能读取该机器结果，不得用 `random`、按均值重建实例、手填数组或从正文反向恢复数据。

## 最低报告集

- 说明分析单位、样本量、重复次数、缺失值处理、排除规则和数据独立性。
- 对主要指标报告单位、中心趋势、离散程度和不确定性区间；不要只给均值或最佳一次运行。
- 比较研究优先报告效应量及区间；如使用 p 值，给出检验、单双侧、精确 p 值、显著性水平和多重比较校正。
- 检查检验假设；不满足时使用合理替代方法或明确限制，不得只写“满足假设”。
- 区分统计显著性、实际重要性与工程意义，不用阈值替代解释。
- 机器学习结果说明数据划分、泄漏防护、随机种子、运行次数、基线公平性、超参数选择和测试集隔离。
- 消融、敏感性和稳健性结果必须与主要结论对应；负结果和异常结果不得无说明删除。
- 结果筛选规则必须在看数据前冻结。不得通过阈值、条件分支、坐标截断或只标正值隐藏负效应、零效应、失败运行和反例；如需排除，必须报告排除数量、预设规则及包含/排除后的敏感性结果。
- 相关、回归或观察性比较只能支持关联性措辞；只有满足明确的因果识别设计、假设检查和稳健性验证时才允许使用 cause、drive、lead to、confirm mechanism 等因果表述。
- 图表中的 P 值、效应量、置信区间、相关系数和拟合优度必须由同一分析脚本生成；禁止把统计量作为绘图常量硬编码。显著性星号不能替代精确 P 值。

## 输出

在 `reviews/statistical-audit.md` 记录：主张、来源表格、统计方法、效应量/区间、假设检查、复现命令和未解决问题。存在无法从数据复核的数字时停止相关段落，不得以更模糊的措辞掩盖。

依据：[ASA 关于统计显著性与 p 值的官方声明](https://www.amstat.org/asa/files/pdfs/p-valuestatement.pdf)。

## 因果推断识别策略

在报告因果效应前，必须明确识别策略及其核心假设。选错设计是最常见的根本性错误，后续任何润色都无法弥补。

### 识别策略决策表

| 数据结构与问题 | 识别设计 | 核心假设 | Python 估计器 |
|---|---|---|---|
| 面板数据 + 政策冲击 + 平行趋势 | DID（2×2 或交错） | 平行趋势、无预期 | `pyfixest.feols`、CS `att_gt`、SA `sunab` |
| 有外生工具变量 | IV / 2SLS | 排他性约束、相关性、单调性 | `linearmodels.IV2SLS` |
| 连续型断点变量 | 回归断点 (RD) | 断点处潜在结果连续 | `rdrobust` |
| N=1 处理单元 + 长前期面板 | 合成控制 (SCM) | 供体池前期拟合、插值有效 | `pysynth` / `synthdid` |
| 高维协变量 + 可忽略性假设 | DML / 因果森林 | 无混淆 + 重叠 | `econml.dml` |
| 仅截面数据 + 可观测选择 | 匹配 / IPW / 熵平衡 | 强可忽略性 | `causalml` |
| 以上均不满足 | 纯描述性分析 | 无因果识别 | 不得用因果语言 |

### 识别假设必须报告的内容

**DID**：平行趋势检验图（事件研究，基准期 = −1）+ Wald 预趋势检验 p 值；交错时序须用 CS / SA / BJS，不得用 TWFE 遮盖负权重偏误。

**IV**：首阶段 F 统计量（≥ 10 为规则底线，Lee 2022 建议 ≥ 104）；弱工具处理用 Anderson-Rubin 或 LIML；报告简化式和二阶段完整三联表，读者可核验 Wald 比率。

**RD**：McCrary 密度检验（排除操纵）；带宽敏感性（至少报告 0.75h / h / 1.5h 三个带宽）；`rdplot` 散点 + 局部多项式图。

**匹配 / IPW**：倾向得分重叠图（正性诊断）；Love 图展示匹配前后 |SMD|，目标 < 0.10；E-value 量化未观测混淆的最小强度。

### 因果表述规范

- 满足识别设计 + 假设检验 + 稳健性方可用：*cause, drive, lead to, induce, prevent*。
- 纯横截面 OLS 或描述性统计只允许：*associated with, correlated with, predicts, is related to*。
- 混淆两类表述是最常见的审稿拒绝理由；在矩阵中对每个论断记录 `identification_design` 字段。

## 计量经济学报告规范

### 回归表最低要求

- 主表采用渐进式控制（M1 → M6）：原始相关 → 加协变量 → 加行业控制 → 加单位 FE → 加双向 FE → 加交互 FE，让读者跟踪系数稳定性。
- 每列报告：估计系数、括号内标准误类型（须与聚类层级一致）、显著性星号（不替代精确 p 值）、N、R²。
- 聚类层级选择须有论证，不得默认 iid；聚类数 < 50 时考虑 wild bootstrap。
- 固定效应须注明类型，不得只写"控制了固定效应"。

### 稳健性核查清单

在 `reviews/statistical-audit.md` 逐项记录，未完成项不得导出终稿：

- [ ] 替代聚类层级（单位 / 行业 / 年份 / 双向）
- [ ] 替代子样本（去极端值 / 平衡面板 / 排除早期处理组）
- [ ] 安慰剂检验（假时间 / 假处理 / 置换推断）
- [ ] 识别设计稳健性（HonestDiD / Oster δ / E-value / 规格曲线）
- [ ] 替代因变量定义（log / IHS / 百分位数）
- [ ] 多重检验校正（Romano-Wolf / Bonferroni / BH-FDR）

依据：[ASA 关于统计显著性与 p 值的官方声明](https://www.amstat.org/asa/files/pdfs/p-valuestatement.pdf) · [AEA 数据与代码可用性政策](https://www.aeaweb.org/journals/data/data-code-policy)。

## 稳健性：Referee-Anticipating Battery

实证论文中每个主要结果都需要一套**可预判审稿人批评**的稳健性检验。不要等 R&R 才补，要在初稿中就包含。

### 三类必须回答的审稿人问题

**1. 稳健性（Robustness）**：这个结果能活过规格变动吗？

| 检验类型 | 具体做法 | 对应"审稿人会问" |
|---|---|---|
| 替代规格 | 逐一去掉协变量；粗化/细化固定效应；加权 | "结果会不会由某个控制变量驱动？" |
| 替代样本 | 去最大单元；去最有影响力时期；限制平衡面板；限制可比子集 | "会不会由某类特殊观测值驱动？" |
| 替代结局定义 | log/水平/缩尾/替代平减 | "结局变量的构建影响结果吗？" |
| 替代聚类 | 更高层级/双向聚类/wild bootstrap | "标准误是否被低估了？" |
| 替代估计器 | OLS→IV；TWFE→CS；RDD→不同带宽 | "识别策略的选择影响结论吗？" |
| 离群值诊断 | Cook's 距离；剔除 top-1% 影响观测 | "结果由某几个离群值驱动吗？" |

**2. 异质性（Heterogeneity）**：效应在哪里集中，与理论预测一致吗？

- **只报告理论预测的异质性**，不报告数据挖掘发现的
- 报告形式：**交互系数**（最干净）或分子群估计 + Wald 等值检验
- 如果异质性是探索性的，必须明确标注"exploratory"
- 特别重要：交错 DID 下异质性应按处理队列报告

**3. 机制（Mechanism）**：为什么 X 导致 Y？

区分两个目的（不要混淆）：
- **渠道证据**：辅助结局是否与提出的渠道一致（非因果识别）
- **排除替代解释**：找出审稿人最可能提出的 2–3 个替代故事，逐一展示证据反驳

语言规范：机制证据用"与……一致"，永远不写"证明了机制"。

### 安慰剂三种类型（每篇实证论文都应包含至少一种）

| 类型 | 做法 | 期望结果 |
|---|---|---|
| 预处理安慰剂 | 假设政策早 3–4 期发生，在真实处理前的样本期内估计 | 系数应接近零 |
| 跨单元安慰剂 | 把处理随机分配给从未被处理的单元；重复 500 次 | 置换分布应覆盖零，真实系数应是"极端值" |
| 结局安慰剂 | 把设计应用到一个**不应**受影响的结局变量 | 零结果加强主要故事 |

### 规格曲线（Specification Curve）

当结果有争议或反直觉时，展示全部合理分析选择下的系数分布：

```python
import itertools, pyfixest as pf, pandas as pd, numpy as np, matplotlib.pyplot as plt

specs = []
for ctrl in [[], ["age"], ["age","edu"], ["age","edu","tenure"]]:
    for fe in ["| industry+year", "| unit_id+year"]:
        for cl in ["unit_id", "unit_id+year"]:
            for y in ["log_y", "ihs_y"]:
                formula = f"{y} ~ treat" + ("+" + "+".join(ctrl) if ctrl else "") + " " + fe
                try:
                    r = pf.feols(formula, data=df, vcov={"CRV1": cl})
                    b, se = r.coef()["treat"], r.se()["treat"]
                    specs.append({"b": b, "lo": b - 1.96*se, "hi": b + 1.96*se})
                except Exception:
                    pass

sc = pd.DataFrame(specs).sort_values("b").reset_index(drop=True)
fig, ax = plt.subplots(figsize=(9, 4))
ax.errorbar(sc.index, sc["b"],
            yerr=[sc["b"] - sc["lo"], sc["hi"] - sc["b"]],
            fmt="o", ms=3, capsize=2, color="navy", alpha=.7)
ax.axhline(0, ls="--", color="gray")
ax.set_xlabel("规格排序（按点估计）")
ax.set_ylabel("处理效应系数")
plt.tight_layout()
plt.savefig("figures/fig_spec_curve.png", dpi=300)
plt.savefig("figures/fig_spec_curve.pdf")
```

### 灵敏度分析三件套

| 方法 | 用于 | 实现 |
|---|---|---|
| **HonestDiD** | DID：平行趋势对轻微违反的敏感性 | rpy2 → `R::HonestDiD::honest_did` |
| **Oster δ*** | OLS：不可观测选择强度 | 手算或 rpy2 → `R::psacalc` |
| **E-value** | 观察性研究：未测混淆的最低强度 | `evalue(rr_point, rr_lower)` 函数（见下） |

```python
import numpy as np

def oster_delta(beta_ols, beta_full, r2_ols, r2_full, rmax=1.3):
    """Oster (2019) δ* — 推翻 β=0 所需的不可观测选择相对强度。"""
    return ((beta_ols - beta_full) / beta_full) * ((rmax - r2_full) / (r2_full - r2_ols))

def evalue(rr_point, rr_lower):
    """VanderWeele-Ding (2017) E-value：推翻估计所需的最小混淆强度。"""
    e_pt = rr_point + np.sqrt(rr_point * (rr_point - 1))
    e_ci = rr_lower + np.sqrt(rr_lower * (rr_lower - 1)) if rr_lower > 1 else 1.0
    return {"e_point": e_pt, "e_ci": e_ci}
```

### 稳健性汇总表（Table A1 标准格式）

每行一种稳健性检验，所有列的焦点系数对齐主表对应列：

```python
import pyfixest as pf

base    = pf.feols("y ~ treat | unit_id+year", data=df, vcov={"CRV1":"unit_id"})
# ... 其他规格

for ext, type_ in [(".xlsx","xlsx"), (".docx","docx"), (".tex","tex")]:
    pf.etable([base, ...],
              type=type_, file=f"tables/tableA1_robustness{ext}",
              headers=["(1)基线","(2)去极值","(3)平衡","..."],
              keep="treat",
              notes="每列为独立稳健性检验，焦点系数为 treat。")
```

### 不要做的事

- 选取 20 种规格，只在报告中突出显著的两种（审稿人看得出来）
- 把"控制了年份固定效应依然显著"当作稳健性（本来就在主规格里）
- 声称"无更多检验应要求提供"——AER 不接受这种表述
- 在 R&R 早上才补稳健性；这应该在初稿中就完成
