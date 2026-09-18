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
