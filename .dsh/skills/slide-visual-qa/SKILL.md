---
name: slide-visual-qa
description: 基于逐页截图审查科技演示文稿的可读性、版式、证据表达和跨页一致性，并驱动 SVG 返工；在 PPTX 导出或 worktree ready 前使用。
---

# Slide Visual QA

本 skill 只接受实际渲染的逐页截图作为视觉证据。结构数据、SVG 源码、lint 通过或文件成功导出都不能代替截图。

## 输入

读取 `deck-brief.md`、storyboard、逐页 SVG、`univer_lint` 结果和 `univer_screenshot` 生成的 PNG。每批最多审查五页，保持足够图像细节；contact sheet 只检查节奏，不用于判断小字、溢出或局部对齐。

详细判定阈值见 [审查量表](references/rubric.md)。

## 审查流程

1. 逐页确认页面任务、结论标题和主视觉是否一致。
2. 检查裁切、溢出、遮挡、异常换行、低对比、对齐漂移、图例混乱和引用不可读。
3. 检查信息密度：观众是否能在数秒内找到标题、主证据和结论。
4. 检查科学表达：轴、单位、样本量、不确定性、基线、统计标记和来源是否可见。
5. 检查跨页节奏：结构是否多样但系统一致，颜色和字体是否保持同一语义。
6. 把每个问题定位到页面和 SVG 元素/区域，给出可执行修复，不使用“再美化一下”等模糊意见。

## 返工规则

- 任一阻断项出现即判定该页 FAIL。
- 修复必须编辑对应 `page-NN.svg`，使用 `replace` 重新编译，再运行 inspect、lint 和 screenshot。
- 同一种缺陷出现两次时，扫描全部页面并一次性修复同类问题。
- 每页最多连续返工三轮；仍失败时保留 FAIL，明确说明需要人工判断的取舍，不得降低标准后宣称通过。

## 输出

持续更新 workspace 的 `slide-visual-qa.md`：

```text
Page | Verdict | Blocking issues | Improvements | Evidence screenshot | Iteration
```

文件末尾给出 `Deck verdict: PASS|FAIL`，并分别列出：阻断页、跨页一致性问题、未验证内容。只有所有页面均 PASS 且不存在跨页阻断项时，Deck 才能 PASS。

