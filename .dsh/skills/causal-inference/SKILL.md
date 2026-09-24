---
name: causal-inference
description: 为社会科学、经济学、公共卫生等领域的实证论文选择识别策略并执行完整因果推断工作流；涉及 DID（差分中的差分）、IV（工具变量）、RDD（回归断点）、SCM（合成控制）、Shift-Share/Bartik、DML/因果森林、RCT 分析时使用。与 statistical-reporting 配合报告，与 computational-reproducibility 配合锁定 PAP，与 aer-paper-sections 配合撰写实证策略章节。
---

# Causal Inference — 识别策略选择与执行

> **识别就是论文。** 设计残缺，写作无法补救。在写任何代码或正文前，先通过本 skill 确定策略并保存为 `milestones/reproducibility/strategy.md`，并登记到 `empirical-manifest.json`。

---

## 主决策树

```
数据 + 研究问题
│
├─ 处理由研究者随机分配？
│   └─ 是 → RCT / 实地实验 → computational-reproducibility (PAP first)
│
├─ 有连续型断点变量 + 赋值规则？
│   └─ RDD ——→ rdrobust (本地线性，禁用 ≥2 阶多项式)
│
├─ 有外生工具变量 Z？
│   ├─ 单一工具 → 2SLS (weak-IV: 若 F<50 必用 AR 置信区间)
│   └─ 行业份额 × 宏观冲击 → Shift-Share/Bartik (先定来源)
│
├─ 面板数据 + 政策冲击？
│   ├─ 单一处理时间 / 同步处理 → 2×2 DID (TWFE 仅此可用)
│   └─ 交错处理时序 → 禁用 TWFE → CS/SA/BJS
│
├─ 单一处理单元 + 长前期面板？
│   └─ 合成控制 (SCM / 增强 SCM / SDiD)
│
├─ 高维协变量 + 可忽略性假设？
│   └─ DML / 因果森林 (econml)
│
├─ 截面数据 + 可观测选择？
│   └─ PSM / IPW / 熵平衡 + E-value
│
└─ 以上均不满足？ → 重新设计研究问题，纯描述性分析禁用因果语言
```

---

## 策略文档模板（预注册，必须在看数据前提交）

```markdown
# 因果推断策略 — strategy.md
**冻结时间**：YYYY-MM-DD  Git SHA: <paste>

**总体**：<研究对象>
**处理变量 D**：<精确定义>
**结局变量 Y**（主，≤3 个）：<精确定义>
**估计量**：ATT / ATE / LATE / CATE（明确选择一个）
**识别设计**：<选择>

## 估计方程
  Y_it = α_i + λ_t + β·D_it + X'γ + ε_it

## 核心识别假设
1. <假设 1（如：平行趋势）>
2. <假设 2（如：无预期效应）>

## 设计威胁与应对
| 威胁 | 检验方法 | 稳健性备选 |

## 稳健性备选估计器
- <备选 1 及理由>
```

---

## DID — 差分中的差分

### TWFE 的使用边界

**唯一可用 TWFE 的情形**：处理时间同步（所有处理组同一时间被处理）且控制组永不被处理。

**交错时序必须用现代估计器**：TWFE 在交错时序下会产生负权重偏误（Goodman-Bacon 2021），估计值可能符号反转。

| 现代估计器 | 适用场景 | Python/R |
|---|---|---|
| Callaway-Sant'Anna (CS) | 通用，最稳健 | `csdid`(Stata) / `did`(R) / rpy2 |
| Sun-Abraham (SA) | 事件研究图，`pyfixest::sunab` | `pf.feols("y ~ sunab(G,t) | i+t")` |
| Borusyak-Jaravel-Spiess (BJS) | 填补估计量 | `did_imputation`(R) |
| de Chaisemartin-D'Haultfœuille | 多期多值处理 | `did_multiplegt`(Stata/R) |
| 合成 DID (SDiD) | 不依赖平行趋势 | `synthdid`(R) via rpy2 |

### 必须报告的诊断

```python
import pyfixest as pf

# 1. Sun-Abraham 事件研究（基准期 = -1）
es = pf.feols(
    "y ~ sunab(first_treat_year, year) | unit_id + year",
    data=df, vcov={"CRV1": "unit_id"}
)
fig = pf.iplot(es, figsize=(7, 4))
fig.savefig("figures/fig_event_study.png", dpi=300)
fig.savefig("figures/fig_event_study.pdf")

# 2. 预趋势 Wald 联合检验（不能仅凭目视）
pre_idx = [k for k in es.coef().index if "::-" in k and "ref" not in k]
W = es.wald_test(pre_idx)
print(f"预趋势 Wald F = {W.statistic:.2f}, p = {W.pvalue:.3f}")  # 期望 p > 0.10

# 3. Goodman-Bacon 分解（诊断 TWFE 权重来源）
# rpy2 → R::bacondecomp，或 Python bacondecomp 包（若已安装）

# 4. Callaway-Sant'Anna（R via rpy2）
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri; pandas2ri.activate()
ro.r('''
library(did)
cs <- att_gt(yname="y", tname="year", idname="unit_id",
             gname="first_treat_year", data=df,
             control_group="nevertreated")
aggte(cs, type="dynamic")
''')
```

### 稳健性标准套件

```python
import numpy as np

# 安慰剂：假处理时间（应接近零）
df["fake_post"] = (df["year"] >= df["first_treat_year"] - 3).astype(int)
placebo = pf.feols("y ~ fake_post | unit_id + year", data=df, vcov={"CRV1":"unit_id"})
print(f"安慰剂系数 = {placebo.coef()['fake_post']:.3f} (SE={placebo.se()['fake_post']:.3f})")

# 置换推断（500次，H0: 无处理效应）
obs = pf.feols("y ~ treat | unit_id + year", data=df).coef()["treat"]
perms = []
for s in range(500):
    d = df.copy()
    d["treat_p"] = d.groupby("unit_id")["treat"].transform(
        lambda x: x.sample(frac=1, random_state=s).values)
    r = pf.feols("y ~ treat_p | unit_id + year", data=d)
    perms.append(r.coef()["treat_p"])
p_ri = (np.abs(perms) >= abs(obs)).mean()
print(f"置换推断 p = {p_ri:.3f}")

# HonestDiD 灵敏度（R via rpy2）
# rpy2 → R::HonestDiD::honest_did(es, ...)
```

---

## IV — 工具变量

### 弱工具现代标准

**F≥10 的旧规则已过时**。2023 年后的实践：

| 情形 | 推荐 |
|---|---|
| F ≥ 104 | 标准 2SLS 置信区间有效 |
| 10 ≤ F < 104 | 同时报告 AR 置信区间（Anderson-Rubin）|
| F < 10 | AR 为主要推断，2SLS 不可靠 |

使用 Olea-Pflueger **effective F statistic** 替代第一阶段 F；`ivDiag`(R) 或 `weakivtest`(Stata) 实现。

```python
from linearmodels.iv import IV2SLS

iv = IV2SLS.from_formula(
    "y ~ 1 + X + [D ~ Z1 + Z2]",
    data=df
).fit(cov_type="clustered", clusters=df["firm_id"])

print(iv.first_stage)      # 报告 Cragg-Donald / KP 统计量
print(iv.summary)

# 三联表（首阶段 + 简化式 + 2SLS）——让读者核验 Wald 比率
fs = pf.feols("D ~ Z1 + Z2 + X | industry + year", df, vcov={"CRV1":"firm_id"})
rf = pf.feols("y ~ Z1 + Z2 + X | industry + year", df, vcov={"CRV1":"firm_id"})
pf.etable([fs, rf], headers=["首阶段", "简化式"],
          type="tex", file="tables/iv_triplet.tex")
```

### 排他性约束的论证方式

1. **制度叙述**（1 段）：Z 通过何种机制影响 Y，且这一路径以外没有其他路径。
2. **安慰剂回归**：Z 是否预测"不应受影响的结局"（应为零）。
3. **违反灵敏度**：Conley et al. (2012) 方法——Z 需要多强的直接效应才能推翻结论。

### Shift-Share / Bartik 特别处理

两种来源的识别逻辑截然不同，**必须明确选择一种**：

| 来源 | 识别假设 | 检验方法 | 引用 |
|---|---|---|---|
| **份额外生**（Goldsmith-Pinkham et al. 2020）| 初期份额条件外生 | Rotemberg 权重分解；检查 top-5 行业驱动了多少识别 | GPS 2020 |
| **冲击外生**（Borusyak-Hull-Jaravel 2022）| 加总冲击随机化 | 冲击级别推断（行业级聚类 SE）| BHJ 2022 |

---

## RDD — 回归断点

### 现代默认设置

- **本地线性回归 + 三角核**（Gelman-Imbens 2019 建议禁用 ≥2 阶多项式）
- **MSE 最优带宽**（CCT 2014，`rdrobust` 默认）+ 鲁棒偏差校正置信区间
- **Donut RDD**：若有断点附近操纵嫌疑

```python
from rdrobust import rdrobust, rdplot, rdbwselect
from rddensity import rddensity, rdplotdensity
import matplotlib.pyplot as plt

# 主估计
rd = rdrobust(y=df["y"], x=df["running"], c=0,
              kernel="triangular", bwselect="mserd")
print(rd)

# 标准 RD 图
rdplot(y=df["y"], x=df["running"], c=0)
plt.savefig("figures/fig_rd.png", dpi=300); plt.savefig("figures/fig_rd.pdf")

# McCrary 操纵检验（p < 0.05 → 有操纵证据，停止分析）
dens = rddensity(X=df["running"], c=0)
print(dens)
rdplotdensity(dens, X=df["running"])
plt.savefig("figures/fig_mccrary.png", dpi=300)

# 带宽灵敏度（至少报告 0.5h / 0.75h / h / 1.5h / 2h）
h_opt = rd.bws["h"]["left"]
for mult in [0.5, 0.75, 1.0, 1.5, 2.0]:
    r = rdrobust(y=df["y"], x=df["running"], c=0, h=h_opt * mult)
    print(f"BW×{mult}: coef={r.coef.iloc[0]:.3f}, p={r.pv.iloc[0]:.3f}")
```

### 必须报告的 RDD 诊断

- [ ] McCrary/CJM 密度检验（操纵检验）
- [ ] 预定变量连续性检验（协变量平衡表）
- [ ] 伪断点安慰剂（在非真实断点处重跑）
- [ ] 带宽灵敏度（≥3 个带宽）
- [ ] RD 图（`rdplot`，注明分箱方法）

---

## SCM — 合成控制

```python
from SyntheticControlMethods import Synth

sc = Synth(df, "y", "unit_id", "time",
           treatment_period=2015, treated_unit=1, n_optim=10)
sc.plot(["original", "pointwise"])
plt.savefig("figures/fig_synth.png", dpi=300)
```

**必须报告**：
- 安慰剂（对每个供体单元重复分析）
- 供体权重向量（附录，>10% 权重的单元须讨论）
- 前期 MSPE（前期拟合质量是可信度核心）
- Fisher 精确 p 值 = （供体 MSPE 比率 ≥ 处理单元的比例）

**现代扩展**：增强 SCM (Ben-Michael 2021)、合成 DID (Arkhangelsky 2021) 作为稳健性备选。

---

## DML — 双重机器学习

```python
from sklearn.ensemble import GradientBoostingRegressor, GradientBoostingClassifier
from econml.dml import LinearDML, CausalForestDML

# 线性 CATE（ATE）
dml = LinearDML(
    model_y=GradientBoostingRegressor(n_estimators=300),
    model_t=GradientBoostingClassifier(n_estimators=300),
    discrete_treatment=True, cv=5
)
dml.fit(df["y"], df["D"], X=df[X_cols], W=df[W_cols])
ate = dml.ate(df[X_cols])
ci  = dml.ate_interval(df[X_cols])
print(f"ATE = {ate:.3f}  95% CI [{ci[0]:.3f}, {ci[1]:.3f}]")

# 异质效应（因果森林）
cf = CausalForestDML(n_estimators=2000)
cf.fit(df["y"], df["D"], X=df[X_cols])
cate = cf.effect(df[X_cols])
```

**必须报告**：扰动学习器规格、交叉拟合折数、重叠诊断图、CATE 分布（均值/SD/四分位数）。

---

## 识别门禁（Gate Record）

在推进到稳健性检验或写作前，必须在 `milestones/reproducibility/id-gate.md` 记录：

```
策略: DID-SA / IV / RDD / SCM / DML
现代估计器: <是/否，哪个>
必要诊断已完成: <列表>
推断方式: <cluster-robust / AR / wild bootstrap / permutation>
审稿人红线已检查:
  [ ] 交错 DID 使用 TWFE 但无 Bacon 分解
  [ ] IV 首阶段 F < 10 且未用 AR
  [ ] RDD 使用 ≥2 阶多项式
  [ ] SCM 无安慰剂推断
  [ ] 识别假设只在脚注提及
结论: ADVANCE / REVISE DESIGN
```

**有任何红线未清除 → 不得进入正文写作**。

---

## 审稿人红线（以下出现任何一条 → 编辑拒稿）

- 交错 DID 使用 TWFE 且没有 Goodman-Bacon 分解
- 引用 "首阶段 F = 11" 作为工具有效性证据（阈值已提高）
- RDD 多项式阶数为 4（Gelman-Imbens 2019 明确反对）
- 合成控制无安慰剂推断
- DID 对照组为"最终也会被处理"的单元
- IV 排他性约束仅靠"我们控制了 X"来辩护
- 引用 Angrist-Pischke 教材替代展示诊断

---

## 交接

本 skill 完成后，路由到：
- `empirical-analysis-pipeline`（运行 8 步 Python 流水线）
- `statistical-reporting`（报告效应量和识别假设）
- `aer-paper-sections`（撰写实证策略章节）

依据：[CS 2021](https://doi.org/10.1016/j.jeconom.2020.12.001) · [SA 2021](https://doi.org/10.1016/j.jeconom.2020.09.006) · [GPS 2020](https://doi.org/10.3982/ECTA16484) · [BHJ 2022](https://doi.org/10.3982/ECTA19367) · [CCT 2014 rdrobust](https://rdpackages.github.io/) · [Chernozhukov et al. 2018 DML](https://doi.org/10.1111/ectj.12097) · [Gelman-Imbens 2019](https://doi.org/10.1080/07350015.2017.1366909)
