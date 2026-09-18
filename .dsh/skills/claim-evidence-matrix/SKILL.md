---
name: claim-evidence-matrix
description: 为科技论文建立并审计“论断—证据”矩阵；在制定段落计划、撰写含引用或数据的正文、检查夸大结论和引用错配时使用。
---

# Claim-Evidence Matrix

## 核心产物

维护 `plan/claim-evidence-matrix.tsv`，每行至少包含：

`claim_id | section | exact_claim | claim_type | source_id | locator | evidence_or_metric | inference_distance | status`

- `claim_type`：background、method、result、comparison、mechanism、limitation 或 contribution。
- `locator`：文献页码/章节/图表，或数据文件、列名、分析脚本与输出表。
- `inference_distance`：direct、derived 或 speculative。
- `status`：verified、supported-inference、unverified 或 contradicted。

## 执行门禁

1. 段落写作前先登记本段拟表达的可核验论断；纯结构性句子无需登记。
2. 文献存在性不等于支持论断，必须读取能支持该论断的原文位置；只有摘要时明确记录证据层级。
3. 数值论断必须指向真实结果文件和计算产物，不得从聊天记忆或模型估算中恢复数字。
4. `derived` 必须写出推导桥梁；`speculative` 只能作为假设或未来工作，不能写成结果。
5. 正文只允许使用 `verified` 和措辞与证据强度匹配的 `supported-inference`；其余项删除、降级表述或补证。
6. 每保存一个段落后同步矩阵中的章节位置和最终措辞，避免后续润色扩大结论。
7. 终审时反向检查：每个矩阵论断在正文有位置，每个正文实质性论断在矩阵有来源。
8. 每次重绘、拆分、合并或重新编号图表后，根据图清单中的 `affected_claim_ids` 重新读取最终图和机器结果；同步更新图注与正文最终措辞。即使只是样式调整，也必须记录已复核且 `semantic_change=none`，不得默认旧结论继续有效。
9. `result`、`comparison` 和 `mechanism` 论断还必须关联 `milestones/reproducibility/result-provenance.tsv` 的 VERIFIED 行；只有文献、图注、绘图代码或语言模型记忆而没有机器结果定位时一律视为 `unverified`。
10. 对照检查所有预设组别、密度、数据集、种子和失败运行是否均进入结果；任何被过滤的负向、零效应或异常结果必须在矩阵中保留并说明处理，不得静默删除。

禁止用相关性证据写因果结论，禁止把单一场景结果外推为普遍规律，禁止把引用堆叠当作证据综合。
