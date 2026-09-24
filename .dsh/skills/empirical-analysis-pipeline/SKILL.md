---
name: empirical-analysis-pipeline
description: 执行社会科学 / 经济学实证论文的端到端 Python 分析流水线（8 步：数据清洗 → 变量构造 → 描述统计 → 诊断检验 → 基线建模 → 稳健性检验 → 机制/异质性分析 → 发表级表格与图形）；当用户需要运行完整实证分析、复现经济学论文、生成 AER 风格多列回归表或事件研究图时使用。需要先确定识别策略（causal-inference skill），完成后交接给 statistical-reporting 报告措辞和 paper-writer 正文写作。
---

# Empirical Analysis Pipeline — Python 8-Step Workflow

## 执行纪律

- 每步骤产出至少一个落盘文件（表格或图形），不得"运行完不保存"。
- 每次只改一个决策（样本规则、估计器、聚类层级、导出格式），改完须通过校验门禁再进下一步。
- 策略、PAP、数据合约、样本日志和产出索引统一登记到 `milestones/reproducibility/empirical-manifest.json`；不得再生成与流水线脱节的第二套 `artifacts/` 门禁。
- 任何步骤失败记录到 `analysis_log.md`，回退到上一个通过状态，不跳过。

## 必装库

```bash
pip install pandas numpy scipy matplotlib seaborn \
            statsmodels linearmodels pyfixest \
            rdrobust rddensity \
            econml causalml \
            stargazer missingno pyreadstat arch pingouin
```

---

## 默认输出合约（按设计适用性产出）

### 核心 5 张表

| # | 表 | 文件 |
|---|---|---|
| T1 | 描述统计 & 平衡检验（处理组 vs 对照组 + SMD） | `tables/table1_balance.{xlsx,docx,tex}` |
| T2 ★ | **主结果多列表 M1→M6**（渐进控制 / 识别规格 / 主要估计器） | `tables/table2_main.{xlsx,docx,tex}` |
| T3 | 机制 / 结果阶梯（同一处理，多个结局） | `tables/table3_mechanism.{xlsx,docx,tex}` |
| T4 | 异质性（分子群 × 主系数） | `tables/table4_heterogeneity.{xlsx,docx,tex}` |
| T5 | 稳健性汇总（每列一种检验） | `tables/table5_robustness.{xlsx,docx,tex}` |

> **T2 是核心**：M1→M6 要展示从朴素模型到最终识别规格的变化。只有同步处理 DID 才可使用 TWFE；交错 DID 使用 CS/SA/BJS，IV/RD/RCT/截面设计按本设计的主估计器展开。

### 核心 4 张图

| # | 图 | 文件（PNG ≥ 300 dpi + PDF） |
|---|---|---|
| F1 | 趋势动机图（处理组 vs 对照组时序） | `figures/fig1_trend.{png,pdf}` |
| F2 | 事件研究图（仅 DID / 事件研究设计必需） | `figures/fig2_event_study.{png,pdf}` |
| F3 | 系数图（M1→M6 点估计 + 95% CI） | `figures/fig3_coefplot.{png,pdf}` |
| F4 | 灵敏度 / 规格曲线 | `figures/fig4_sensitivity.{png,pdf}` |

不适用于当前研究设计的表图不得硬凑；必须在 `empirical-manifest.json` 中登记 `{ "status": "not_applicable", "reason": "..." }`。T2 始终必需，F2 仅 DID / 事件研究必需。

---

## Step −1 — 预分析计划（PAP）

在触碰数据前冻结。详见 `computational-reproducibility` skill。

```python
import json, statsmodels.stats.power as smp

# 功效计算
n_req = smp.TTestIndPower().solve_power(
    effect_size=0.20, power=0.80, alpha=0.05)
print(f"每组最少 n = {n_req:.0f}")

pap = {
    "population": "", "treatment": "", "outcome": "",
    "estimand": "ATT", "design": "staggered-DID",
    "alpha": 0.05, "power_target": 0.80, "mde_d": 0.20,
    "n_planned": 0, "frozen_at": "", "git_sha": ""
}
with open("milestones/reproducibility/pap.json", "w") as f:
    json.dump(pap, f, indent=2)
# git add milestones/reproducibility/pap.json && git commit -m "freeze PAP"
```

---

## Step 0 — 样本日志 & 五项数据合约

```python
import pandas as pd, numpy as np, json
from scipy import stats

sample_log = []
df_raw = pd.read_csv("raw.csv")
sample_log.append(("0. 原始", len(df_raw)))

df1 = df_raw.dropna(subset=["outcome"])
sample_log.append(("1. 删除缺失主结局", len(df1)))

df = df1.copy()
for label, n in sample_log:
    print(f"  {label:<30s}  N = {n:>10,d}")
with open("milestones/reproducibility/sample-construction.json", "w") as f:
    json.dump(sample_log, f, indent=2)

# 五项合约
def data_contract(df, y, treatment, id_col=None, time_col=None, covariates=()):
    keys = [y, treatment] + ([id_col, time_col] if id_col else []) + list(covariates)
    c = {"n_obs": len(df),
         "n_missing": df[keys].isna().sum().to_dict(),
         "n_dupes": int(df.duplicated([id_col, time_col]).sum()) if id_col else 0,
         "y_range": (float(df[y].min()), float(df[y].max())),
         "treatment_share": float(df[treatment].mean())}
    if id_col:
        bal = df.groupby(id_col).size()
        c["panel_balanced"] = bool((bal == bal.max()).all())
    # MCAR 嗅探
    miss = df[y].isna()
    c["mcar_hint"] = "likely MCAR"
    for cov in covariates:
        if miss.any() and df[cov].dtype.kind in "fi":
            _, p = stats.ttest_ind(df.loc[miss, cov].dropna(),
                                   df.loc[~miss, cov].dropna(), equal_var=False)
            if p < 0.05:
                c["mcar_hint"] = f"NOT MCAR (y-miss differs on {cov}, p={p:.3f}) → MI/IPW"
                break
    assert c["n_dupes"] == 0, f"面板键重复: {c['n_dupes']} 行"
    with open("milestones/reproducibility/data-contract.json", "w") as f:
        json.dump(c, f, indent=2, default=str)
    return c

contract = data_contract(df, y="outcome", treatment="treat",
                          id_col="unit_id", time_col="year",
                          covariates=["age", "edu"])
```

---

## Step 1 — 数据清洗

```python
# dtype 修正
df["year"]    = pd.to_numeric(df["year"], errors="coerce")
df["outcome"] = pd.to_numeric(df["outcome"], errors="coerce")

# 缺失值——逐变量决策，绝不整体删除
key_vars = ["outcome", "treat", "unit_id", "year"]
df = df.dropna(subset=key_vars)
df["covariate_x"] = df["covariate_x"].fillna(df["covariate_x"].median())

# 去重（面板键）
assert not df.duplicated(["unit_id", "year"]).any(), "面板键重复"

# 离群值标记（先标记，Step 2 再 winsorize）
df["outcome_z"] = (df["outcome"] - df["outcome"].mean()) / df["outcome"].std()
n_out = (df["outcome_z"].abs() > 4).sum()
print(f"离群值（|z|>4）: {n_out} 行")
```

---

## Step 2 — 变量构造

```python
from scipy.stats.mstats import winsorize

# 变换
df["log_y"]  = np.log(df["outcome"].clip(lower=1))
df["ihs_y"]  = np.arcsinh(df["outcome"])
df["y_w"]    = winsorize(df["outcome"], limits=[0.01, 0.01]).data   # 1/99 缩尾

# 交错 DID 时序变量
df = df.sort_values(["unit_id", "year"])
df["first_treat_year"] = df.groupby("unit_id")["treat"].transform(
    lambda x: df.loc[x.index, "year"][x.astype(bool)].min() if x.any() else np.nan)
df["rel_time"] = df["year"] - df["first_treat_year"]

# 滞后 / 超前
df["y_lag1"] = df.groupby("unit_id")["log_y"].shift(1)
df["y_diff"] = df.groupby("unit_id")["log_y"].diff()
```

---

## Step 3 — 描述统计 & Table 1

```python
import seaborn as sns, matplotlib.pyplot as plt
from scipy import stats as sps

# Table 1：处理组 vs 对照组
def table1(df, by, cols):
    rows = []
    for c in cols:
        t  = df.loc[df[by]==1, c]
        ct = df.loc[df[by]==0, c]
        smd = (t.mean() - ct.mean()) / np.sqrt((t.var() + ct.var()) / 2)
        p = sps.ttest_ind(t.dropna(), ct.dropna(), equal_var=False).pvalue
        rows.append([c, t.mean(), t.std(), ct.mean(), ct.std(), smd, p])
    tbl = pd.DataFrame(rows,
          columns=["变量","处理组均值","SD","对照组均值","SD","SMD","p"])
    tbl.to_excel("tables/table1_balance.xlsx", index=False)
    return tbl

t1 = table1(df, by="treat",
            cols=["log_y", "age", "edu", "covariate_x"])
print(t1.round(3))

# 趋势图（F1）
fig, ax = plt.subplots(figsize=(7, 4))
df.groupby(["year","treat"])["log_y"].mean().unstack().plot(
    ax=ax, marker="o", color={0:"darkred",1:"navy"})
ax.set_xlabel("年份"); ax.set_ylabel("结局均值")
ax.legend(["对照组","处理组"])
plt.tight_layout()
plt.savefig("figures/fig1_trend.png", dpi=300)
plt.savefig("figures/fig1_trend.pdf")
```

---

## Step 3.5 — 识别图形（必须先于回归表）

```python
import pyfixest as pf

# 事件研究图（SA 估计器，基准期 = −1）
es = pf.feols(
    "log_y ~ sunab(first_treat_year, year) | unit_id + year",
    data=df, vcov={"CRV1": "unit_id"})
fig2 = pf.iplot(es, figsize=(7,4))
fig2.savefig("figures/fig2_event_study.png", dpi=300)
fig2.savefig("figures/fig2_event_study.pdf")

# 预趋势 Wald 检验
pre_idx = [k for k in es.coef().index if "::-" in k]
if pre_idx:
    W = es.wald_test(pre_idx)
    print(f"预趋势 Wald p = {W.pvalue:.3f}  （期望 > 0.10）")
```

---

## Step 4 — 诊断检验

```python
import statsmodels.api as sm
from statsmodels.stats.diagnostic import het_breuschpagan, acorr_breusch_godfrey
from statsmodels.stats.outliers_influence import variance_inflation_factor
from statsmodels.stats.stattools import durbin_watson, jarque_bera

X = sm.add_constant(df[["treat","age","edu"]].dropna())
y = df.loc[X.index, "log_y"]
ols = sm.OLS(y, X).fit()

# 正态性（大样本仅参考）
jb_stat, jb_p, _, _ = jarque_bera(ols.resid)
# 异方差
bp = het_breuschpagan(ols.resid, ols.model.exog)
# 自相关
dw = durbin_watson(ols.resid)
bg = acorr_breusch_godfrey(ols, nlags=4)
# 多重共线
vif = pd.DataFrame({
    "var": X.columns,
    "VIF": [variance_inflation_factor(X.values, i) for i in range(X.shape[1])]
})

print(f"JB p={jb_p:.3f}  BP p={bp[1]:.3f}  DW={dw:.2f}  BG p={bg[1]:.3f}")
print(vif)
# VIF > 10 或条件数 > 30 须处理共线性
```

---

## Step 5 — 基线建模（主回归 M1→M6）

```python
import pyfixest as pf

# 六列渐进式控制
m1 = pf.feols("log_y ~ treat",                                                   data=df, vcov={"CRV1":"unit_id"})
m2 = pf.feols("log_y ~ treat + age + edu",                                       data=df, vcov={"CRV1":"unit_id"})
m3 = pf.feols("log_y ~ treat + age + edu + covariate_x",                         data=df, vcov={"CRV1":"unit_id"})
m4 = pf.feols("log_y ~ treat + age + edu + covariate_x | industry + year",       data=df, vcov={"CRV1":"unit_id"})
m5 = pf.feols("log_y ~ treat + age + edu + covariate_x | unit_id + year",        data=df, vcov={"CRV1":"unit_id"})
m6 = pf.feols("log_y ~ treat + age + edu + covariate_x | unit_id + year + industry^year",
              data=df, vcov={"CRV1":"unit_id"})

# 同时导出三种格式
for ext, type_ in [(".xlsx","xlsx"), (".docx","docx"), (".tex","tex")]:
    pf.etable([m1,m2,m3,m4,m5,m6],
              type=type_, file=f"tables/table2_main{ext}",
              headers=["(1)原始","(2)+协变量","(3)+控制",
                       "(4)行业×年FE","(5)单位FE","(6)单位+行业×年FE"],
              digits=3, signif_code=[0.1,0.05,0.01],
              notes="括号内为聚类标准误（unit_id）。* p<0.10, ** p<0.05, *** p<0.01。")

# 系数图（F3）
betas = [r.coef()["treat"] for r in [m1,m2,m3,m4,m5,m6]]
ses   = [r.se()["treat"]   for r in [m1,m2,m3,m4,m5,m6]]
betas, ses = np.array(betas), np.array(ses)
fig3, ax = plt.subplots(figsize=(6,3.5))
ax.errorbar(range(1,7), betas, yerr=1.96*ses, fmt="o", capsize=3, color="navy")
ax.axhline(0, ls="--", color="gray", alpha=.6)
ax.set_xticks(range(1,7)); ax.set_xlabel("规格"); ax.set_ylabel("处理效应系数")
plt.tight_layout()
plt.savefig("figures/fig3_coefplot.png", dpi=300)
plt.savefig("figures/fig3_coefplot.pdf")
```

---

## Step 6 — 稳健性检验套件

```python
# 标准 8 列稳健性汇总表（T5）
base     = pf.feols("log_y ~ treat | unit_id + year", data=df, vcov={"CRV1":"unit_id"})
no99     = pf.feols("log_y ~ treat | unit_id + year",
                    data=df.query("outcome < outcome.quantile(0.99)"), vcov={"CRV1":"unit_id"})
bal_pan  = pf.feols("log_y ~ treat | unit_id + year",
                    data=df.groupby("unit_id").filter(lambda g: len(g)==g["year"].nunique()),
                    vcov={"CRV1":"unit_id"})
cl_firm  = pf.feols("log_y ~ treat | unit_id + year", data=df, vcov={"CRV1":"firm_id"})
cl_2way  = pf.feols("log_y ~ treat | unit_id + year", data=df, vcov={"CRV1":"unit_id+year"})
ihs_y    = pf.feols("ihs_y ~ treat | unit_id + year", data=df, vcov={"CRV1":"unit_id"})

# 安慰剂：假处理时间
df["fake_post"] = (df["year"] >= df["first_treat_year"] - 3).astype(int)
placebo  = pf.feols("log_y ~ fake_post | unit_id + year", data=df, vcov={"CRV1":"unit_id"})

for ext, type_ in [(".xlsx","xlsx"), (".docx","docx"), (".tex","tex")]:
    pf.etable([base, no99, bal_pan, cl_firm, cl_2way, ihs_y, placebo],
              type=type_, file=f"tables/table5_robustness{ext}",
              headers=["(1)基线","(2)去极值","(3)平衡","(4)企业聚类",
                       "(5)双向聚类","(6)IHS","(7)安慰剂"],
              keep="treat",
              notes="每列为独立稳健性检验，焦点系数为 treat。")

# 规格曲线（F4）
import itertools
specs = []
for ctrl in [[], ["age"], ["age","edu"], ["age","edu","covariate_x"]]:
    for fe in ["| industry + year", "| unit_id + year"]:
        for cl in ["unit_id", "unit_id+year"]:
            formula = "log_y ~ treat" + ("+"+"+".join(ctrl) if ctrl else "") + " " + fe
            try:
                r = pf.feols(formula, data=df, vcov={"CRV1": cl})
                b, se = r.coef()["treat"], r.se()["treat"]
                specs.append({"b": b, "lo": b-1.96*se, "hi": b+1.96*se})
            except Exception:
                pass

sc = pd.DataFrame(specs).sort_values("b").reset_index(drop=True)
fig4, ax = plt.subplots(figsize=(8,4))
ax.errorbar(sc.index, sc["b"],
            yerr=[sc["b"]-sc["lo"], sc["hi"]-sc["b"]],
            fmt="o", ms=3, capsize=2, color="navy", alpha=.7)
ax.axhline(0, ls="--", color="gray")
ax.set_xlabel("规格排序（按点估计）"); ax.set_ylabel("处理效应系数")
plt.tight_layout()
plt.savefig("figures/fig4_sensitivity.png", dpi=300)
plt.savefig("figures/fig4_sensitivity.pdf")
```

---

## Step 7 — 机制 / 异质性分析

```python
# T3：结果阶梯（机制路径）
outcomes = ["mediator_1", "mediator_2", "log_y"]
ladder = [pf.feols(f"{y} ~ treat | unit_id + year", data=df, vcov={"CRV1":"unit_id"})
          for y in outcomes]
for ext, type_ in [(".xlsx","xlsx"),(".docx","docx"),(".tex","tex")]:
    pf.etable(ladder, type=type_, file=f"tables/table3_mechanism{ext}",
              headers=outcomes, keep="treat")

# T4：异质性（分子群）
subgroups = {
    "全样本": df,
    "女性=0": df[df.female==0],
    "女性=1": df[df.female==1],
}
het = [pf.feols("log_y ~ treat | unit_id + year", data=d, vcov={"CRV1":"unit_id"})
       for d in subgroups.values()]
for ext, type_ in [(".xlsx","xlsx"),(".docx","docx"),(".tex","tex")]:
    pf.etable(het, type=type_, file=f"tables/table4_heterogeneity{ext}",
              headers=list(subgroups.keys()), keep="treat")

# 异质性交互 Wald 检验
from scipy.stats import chi2
b0 = het[1].coef()["treat"]; se0 = het[1].se()["treat"]
b1 = het[2].coef()["treat"]; se1 = het[2].se()["treat"]
wald = ((b0-b1) / np.sqrt(se0**2+se1**2))**2
print(f"异质性 Wald 统计量={wald:.2f}, p={1-chi2.cdf(wald,1):.3f}")
```

---

## Step 8 — 复现印章

```python
import hashlib, sys, pyfixest, json

b_hat = float(base.coef()["treat"])
se    = float(base.se()["treat"])
dataset_sha = hashlib.sha256(
    pd.util.hash_pandas_object(df, index=True).values.tobytes()
).hexdigest()[:16]

stamp = {
    "python_version":   sys.version,
    "pyfixest_version": pyfixest.__version__,
    "seed": 42,
    "resultSha256": "<完整机器结果文件 SHA256>",
    "dataset_sha256_16": dataset_sha,
    "n_obs": int(base._N),
    "estimand": "ATT",
    "estimator": "按识别设计填写：CS/SA/BJS、2SLS、rdrobust、RCT OLS、DML 等；仅同步处理 DID 可写 TWFE",
    "estimate": b_hat,
    "se_cluster": se,
    "ci95": [b_hat-1.96*se, b_hat+1.96*se],
    "pap": "milestones/reproducibility/pap.json",
    "data_contract": "milestones/reproducibility/data-contract.json",
    "sample_log": "milestones/reproducibility/sample-construction.json",
}
with open("milestones/reproducibility/empirical-manifest.json", "w") as f:
    json.dump(stamp, f, indent=2)
print("✓ 实证清单已保存 milestones/reproducibility/empirical-manifest.json")
```

---

## 交接合约（`exhibits_index.md`）

运行结束后生成此文件，供 `paper-writer` 引用：

```markdown
| 产物    | 文件                                   | 支持的主张              | 生成脚本    |
|---------|----------------------------------------|------------------------|-------------|
| Table 2 | tables/table2_main.{tex,docx,xlsx}     | 政策对结局的主效应      | analysis.py |
| Figure 2| figures/fig2_event_study.{png,pdf}     | 无显著预趋势            | analysis.py |
| Figure 3| figures/fig3_coefplot.{png,pdf}        | 跨规格系数稳定性        | analysis.py |
| Table 5 | tables/table5_robustness.{tex,docx}    | 结果对样本/聚类不敏感   | analysis.py |
```

然后路由到 → `statistical-reporting`（报告措辞）→ `paper-writer`（正文成稿）→ `paper-quality-gate`（质量门禁）。

依据：[pyfixest 文档](https://py-econometrics.github.io/pyfixest/) · [AERS Full-empirical-analysis-skill_Python](https://github.com/brycewang-stanford/Auto-Empirical-Research-Skills)。
