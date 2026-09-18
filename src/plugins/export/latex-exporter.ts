/**
 * LaTeX 导出插件
 *
 * 功能：将论文导出为 LaTeX 源文件，支持常见模板
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Paper, Section, ToolResult } from '../../types.js';

export interface LatexExportOptions {
  title: string;
  authors?: string[];
  abstract?: string;
  keywords?: string[];
  template?: 'article' | 'ieee' | 'ctex';
  outputDir?: string;
  bibliographyStyle?: 'plain' | 'ieeetr' | 'apalike';
}

export async function exportToLatex(
  sections: Section[],
  papers: Paper[],
  options: LatexExportOptions
): Promise<ToolResult<{ texPath: string; bibPath: string }>> {
  try {
    const outputDir = options.outputDir || resolve(process.env.PAPER_DATA_ROOT || 'F:\\DSH data', process.env.OUTPUT_DIR || 'output');
    await mkdir(outputDir, { recursive: true });

    const template = options.template || 'article';
    const baseName = sanitizeFilename(options.title);

    // 生成 .tex 文件
    const texContent = buildLatex(sections, papers, options, template);
    const texPath = join(outputDir, `${baseName}.tex`);
    await writeFile(texPath, texContent, 'utf-8');

    // 生成 .bib 文件
    const bibContent = buildBibtex(papers, sections);
    const bibPath = join(outputDir, `${baseName}.bib`);
    await writeFile(bibPath, bibContent, 'utf-8');

    return { success: true, data: { texPath, bibPath } };
  } catch (error) {
    return {
      success: false,
      error: `LaTeX 导出失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 构建 LaTeX 源文件 */
function buildLatex(
  sections: Section[],
  papers: Paper[],
  options: LatexExportOptions,
  template: string
): string {
  let tex = '';

  // 文档类和宏包
  if (template === 'ctex') {
    tex += `\\documentclass[UTF8]{ctexart}\n`;
  } else if (template === 'ieee') {
    tex += `\\documentclass[conference]{IEEEtran}\n`;
  } else {
    tex += `\\documentclass{article}\n`;
    tex += `\\usepackage[UTF8]{ctex}\n`;
  }

  tex += `\\usepackage{geometry}\n`;
  tex += `\\geometry{a4paper, margin=2.5cm}\n`;
  tex += `\\usepackage{graphicx}\n`;
  tex += `\\usepackage{amsmath}\n`;
  tex += `\\usepackage{hyperref}\n\n`;

  // 标题和作者
  tex += `\\title{${escapeLatex(options.title)}}\n`;
  if (options.authors?.length) {
    tex += `\\author{${options.authors.map(escapeLatex).join(' \\and ')}\\thanks{}}\n`;
  }
  tex += `\\date{\\today}\n\n`;

  tex += `\\begin{document}\n\n`;
  tex += `\\maketitle\n\n`;

  // 摘要
  if (options.abstract) {
    tex += `\\begin{abstract}\n${escapeLatex(options.abstract)}\n\\end{abstract}\n\n`;
  }

  // 关键词
  if (options.keywords?.length) {
    tex += `\\noindent\\textbf{关键词：}${options.keywords.map(escapeLatex).join('；')}\n\n`;
  }

  // 正文
  for (const section of sections) {
    const level = section.nodeId.split('.').length;
    if (level === 1) {
      tex += `\\section{${escapeLatex(section.title)}}\n\n`;
    } else if (level === 2) {
      tex += `\\subsection{${escapeLatex(section.title)}}\n\n`;
    } else {
      tex += `\\subsubsection{${escapeLatex(section.title)}}\n\n`;
    }
    tex += `${escapeLatex(section.content)}\n\n`;
  }

  // 参考文献
  tex += `\\bibliographystyle{${options.bibliographyStyle || 'plain'}}\n`;
  tex += `\\bibliography{${sanitizeFilename(options.title)}}\n\n`;

  tex += `\\end{document}\n`;

  return tex;
}

/** 构建 BibTeX */
function buildBibtex(papers: Paper[], sections: Section[]): string {
  const citedIds = new Set<string>();
  for (const s of sections) {
    for (const c of s.citations) {
      citedIds.add(c.paperId);
    }
  }

  let bib = '';
  papers
    .filter((p) => citedIds.has(p.id))
    .forEach((paper, idx) => {
      const key = `ref${idx + 1}`;
      bib += `@article{${key},\n`;
      bib += `  title = {${paper.title}},\n`;
      bib += `  author = {${paper.authors.join(' and ')}},\n`;
      bib += `  year = {${paper.year}},\n`;
      if (paper.url) {
        bib += `  url = {${paper.url}},\n`;
      }
      bib += `}\n\n`;
    });

  return bib;
}

/** LaTeX 特殊字符转义 */
function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
}

/** dsh 插件导出 */
export const latexExporterPlugin = {
  name: 'latex-exporter',
  description: 'LaTeX 源文件导出',
  tools: {
    export_latex: {
      description: '将论文导出为 LaTeX 源文件 + BibTeX 参考文献',
      parameters: {
        sections: { type: 'array', description: '论文节列表', required: true },
        papers: { type: 'array', description: '文献列表', required: true },
        title: { type: 'string', description: '论文标题', required: true },
        authors: { type: 'array', description: '作者列表' },
        abstract: { type: 'string', description: '摘要' },
        keywords: { type: 'array', description: '关键词' },
        template: { type: 'string', description: '模板: article/ieee/ctex' },
        outputDir: { type: 'string', description: '输出目录' },
      },
      handler: exportToLatex,
    },
  },
};
