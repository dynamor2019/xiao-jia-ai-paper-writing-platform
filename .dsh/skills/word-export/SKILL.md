---
name: word-export
description: 将包含标题、表格、图片、行内公式和块级 LaTeX 公式的 Markdown 导出为 Word DOCX；当用户要求把 md 转成 Word、导出论文 Word 或修复 Word 公式时使用。
---

# Markdown 转 Word

## 调用

在 `F:\dsh` 中执行：

```bash
npm run word -- "输入文件.md" "输出文件.docx"
```

省略输出路径时，在 Markdown 文件旁生成同名 DOCX。

## 公式约定

- 行内公式使用 `$E=mc^2$` 或 `\(E=mc^2\)`。
- 块级公式使用 `$$...$$` 或 `\[...\]`。
- 不把公式放进代码块，不用图片替代可编辑公式。
- 导出后公式应为 Word 原生 OMML 对象，可在 Word 公式编辑器中继续编辑。

## 质量门

1. 导出命令必须成功，禁止把失败静默伪装成 Markdown 成功。
2. 检查 DOCX 的 `word/document.xml` 中存在 `m:oMath` 或 `m:oMathPara`。
3. 用文档渲染器生成页面 PNG，确认公式、表格、图片和分页实际可见。
4. 运行 `npm run paper:validate -- <source.md> <output.docx>`，检查真实表图、References 后残留和未转换数学标记。
5. 任一检查为 BLOCKED 时不得报告完成；若输入公式语法错误，修正 Markdown 后重新导出，不要删除公式。
