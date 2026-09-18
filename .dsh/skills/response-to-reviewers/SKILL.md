---
name: response-to-reviewers
description: 处理期刊审稿意见、规划修订并生成逐条 Response to Reviewers；收到编辑决定信或需要模拟修改回复时使用。
---

# Response to Reviewers

## 可追溯修订

1. 原样提取编辑与审稿意见，分配稳定 ID，不合并会改变含义的意见。
2. 建立 `reviews/revision-matrix.tsv`：`id | request | category | action | manuscript_location | evidence | status`。
3. 区分必须修改、需澄清、可合理反驳和需要新增实验；先处理会改变结论或方法的高风险意见。
4. 每次只修改一个可验证单元，修改后更新位置和证据；不要先写回复再假装正文已修改。
5. 回复结构为：感谢或确认问题、明确采取的行动、给出修改位置与核心文本、必要时提供数据或理由。
6. 不虚构新实验、编辑要求、页码或审稿人认同；无法完成的实验要说明约束、替代分析及结论如何收缩。
7. 合理反驳时保持克制，用稿件证据和方法依据说明，不攻击审稿人，也不机械地全部同意。

最终生成 `reviews/response-to-reviewers.md`，并在排版完成后刷新页码/行号；只有矩阵全部 resolved 或明确由用户接受的 unresolved 项，才标记修订完成。
