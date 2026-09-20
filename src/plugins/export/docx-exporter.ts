/**
 * Word (.docx) 导出插件
 *
 * 功能：将论文各节合并导出为 Word 文档
 * 依赖：docx 库（npm install docx）或系统 pandoc
 */

import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Paper, Section, ToolResult } from '../../types.js';

const execFileAsync = promisify(execFile);

export interface ExportOptions {
  title: string;
  authors?: string[];
  abstract?: string;
  keywords?: string[];
  citationStyle?: 'GB-T-7714' | 'APA' | 'IEEE';
  outputDir?: string;
  projectDir?: string;
  figureDir?: string;
  tableDir?: string;
}

/**
 * 导出为 Word 文档
 * 使用 Pandoc 将 Markdown 和 LaTeX 数学公式转换为原生 Word 内容
 */
export async function exportToDocx(
  sections: Section[],
  papers: Paper[],
  options: ExportOptions
): Promise<ToolResult<{ filePath: string; format: 'docx' | 'md' }>> {
  try {
    const dataRoot = process.env.PAPER_DATA_ROOT || join(process.env.USERPROFILE || homedir(), 'Documents', 'XiaoJiaAI Data');
    const outputDir = options.outputDir || resolve(dataRoot, process.env.OUTPUT_DIR || 'output');
    await mkdir(outputDir, { recursive: true });

    // 生成 Markdown 内容
    const markdown = await buildSubmissionMarkdown(sections, papers, options, outputDir);

    const mdPath = join(outputDir, `${sanitizeFilename(options.title)}.md`);
    const docxPath = join(outputDir, `${sanitizeFilename(options.title)}.docx`);
    await writeFile(mdPath, markdown, 'utf-8');

    const pandocPath = resolvePandocPath();
    const projectDir = resolve(options.projectDir || inferProjectDir(outputDir));
    const resourcePath = [process.cwd(), resolve(outputDir), projectDir].join(delimiter);
    const args = [
      mdPath,
      '--from=markdown+tex_math_dollars+tex_math_single_backslash+raw_tex',
      '--to=docx',
      '--standalone',
      '--wrap=none',
      `--resource-path=${resourcePath}`,
      '--output',
      docxPath,
    ];
    const referenceDoc = process.env.PANDOC_REFERENCE_DOC?.trim();
    if (referenceDoc) {
      if (!existsSync(referenceDoc)) throw new Error(`PANDOC_REFERENCE_DOC 不存在: ${referenceDoc}`);
      args.push(`--reference-doc=${referenceDoc}`);
    }

    await execFileAsync(pandocPath, args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    const output = await stat(docxPath);
    if (output.size === 0) throw new Error('Pandoc 生成了空的 DOCX 文件');

    return { success: true, data: { filePath: docxPath, format: 'docx' } };
  } catch (error) {
    return {
      success: false,
      error: `Word 导出失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resolvePandocPath(): string {
  const configured = process.env.PANDOC_PATH?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`PANDOC_PATH 不存在: ${configured}`);
    return configured;
  }
  return 'pandoc';
}

async function buildSubmissionMarkdown(
  sections: Section[],
  papers: Paper[],
  options: ExportOptions,
  outputDir: string
): Promise<string> {
  const markdown = buildMarkdown(sections, papers, options);
  return embedSubmissionAssets(markdown, options, outputDir);
}

async function embedSubmissionAssets(
  markdown: string,
  options: ExportOptions,
  outputDir: string
): Promise<string> {
  const projectDir = resolve(options.projectDir || inferProjectDir(outputDir));
  const figureDir = resolve(options.figureDir || join(projectDir, 'figures'));
  const tableDir = resolve(options.tableDir || join(projectDir, 'tables'));
  let assembled = markdown;

  if (hasFigureReferences(assembled) && !hasMarkdownImages(assembled)) {
    const figures = await discoverFigures(figureDir, outputDir);
    assembled = await insertFigures(assembled, figures);
  }

  if (hasTableReferences(assembled) && !hasMarkdownTables(assembled)) {
    const tables = await discoverTables(tableDir);
    assembled = await insertTables(assembled, tables);
  }

  rejectManualAssemblyMarkers(assembled);
  return assembled;
}

function inferProjectDir(outputDir: string): string {
  const resolved = resolve(outputDir);
  return basename(resolved).toLowerCase() === 'final' ? dirname(resolved) : resolved;
}

function hasFigureReferences(markdown: string): boolean {
  return /\b(?:Figure|Fig\.)\s+\d+[A-Za-z]?\b/i.test(markdown);
}

function hasTableReferences(markdown: string): boolean {
  return /\bTable\s+\d+[A-Za-z]?\b/i.test(markdown);
}

function hasMarkdownImages(markdown: string): boolean {
  return /!\[[^\]]*\]\([^\)]+\)/.test(markdown);
}

function hasMarkdownTables(markdown: string): boolean {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/m.test(markdown);
}

async function discoverFigures(figureDir: string, outputDir: string): Promise<Map<number, string>> {
  if (!existsSync(figureDir)) throw new Error(`正文引用了 Figure，但没有找到图片目录: ${figureDir}`);
  await mkdir(join(outputDir, 'figures'), { recursive: true });
  const files = await readdir(figureDir);
  const byNumber = new Map<number, string>();
  for (const file of files.sort()) {
    const extension = extname(file).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.pdf'].includes(extension)) continue;
    const match = file.match(/(?:^|[^0-9])fig(?:ure)?[_-]?(\d+)(?:[^0-9]|$)/i);
    if (!match) continue;
    const number = Number(match[1]);
    if (byNumber.has(number) && extension !== '.png') continue;
    const source = join(figureDir, file);
    const target = join(outputDir, 'figures', file);
    await copyFile(source, target);
    byNumber.set(number, toMarkdownPath(relative(outputDir, target)));
  }
  return byNumber;
}

async function discoverTables(tableDir: string): Promise<Map<number, string>> {
  if (!existsSync(tableDir)) throw new Error(`正文引用了 Table，但没有找到表格目录: ${tableDir}`);
  const files = await readdir(tableDir);
  const byNumber = new Map<number, string>();
  for (const file of files.sort()) {
    const extension = extname(file).toLowerCase();
    if (!['.tsv', '.csv', '.md'].includes(extension)) continue;
    const match = file.match(/(?:^|[^0-9])table[_-]?(\d+)(?:[^0-9]|$)/i);
    if (!match) continue;
    const number = Number(match[1]);
    if (byNumber.has(number)) continue;
    const content = await readFile(join(tableDir, file), 'utf-8');
    byNumber.set(number, extension === '.md' ? content.trim() : delimitedToMarkdownTable(content, extension === '.tsv' ? '\t' : ','));
  }
  return byNumber;
}

async function insertFigures(markdown: string, figures: Map<number, string>): Promise<string> {
  return insertAssetsAfterReferences(markdown, /\b(?:Figure|Fig\.)\s+(\d+)[A-Za-z]?\b/gi, figures, (number, path) => `![Figure ${number}](${path})`);
}

async function insertTables(markdown: string, tables: Map<number, string>): Promise<string> {
  return insertAssetsAfterReferences(markdown, /\bTable\s+(\d+)[A-Za-z]?\b/gi, tables, (_number, table) => table);
}

function insertAssetsAfterReferences(
  markdown: string,
  pattern: RegExp,
  assets: Map<number, string>,
  render: (number: number, asset: string) => string
): string {
  const required = [...new Set([...markdown.matchAll(pattern)].map((match) => Number(match[1])))].sort((a, b) => a - b);
  const missing = required.filter((number) => !assets.has(number));
  if (missing.length > 0) throw new Error(`投稿稿引用了 ${missing.map((number) => `No.${number}`).join(', ')}，但没有对应资源文件`);
  let assembled = markdown;
  for (const number of required) {
    const asset = assets.get(number);
    if (!asset) continue;
    const reference = new RegExp(`(.*\\b(?:${pattern.source.includes('Table') ? 'Table' : 'Figure|Fig\\.'})\\s+${number}[A-Za-z]?\\b.*(?:\\r?\\n|$))`, 'i');
    assembled = assembled.replace(reference, (match) => `${match.trimEnd()}\n\n${render(number, asset)}\n\n`);
  }
  return assembled;
}

function delimitedToMarkdownTable(content: string, delimiterValue: string): string {
  const rows = content.trim().split(/\r?\n/).map((line) => line.split(delimiterValue).map((cell) => cell.trim()));
  if (rows.length === 0 || rows[0].length === 0) throw new Error('表格文件为空，无法生成 Word 表格');
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
  const header = normalized[0];
  const body = normalized.slice(1);
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

function rejectManualAssemblyMarkers(markdown: string): void {
  if (/manual(?:ly)?\s+(?:insert|convert|copy)|手动(?:插入|转换|复制|排版)|requires?\s+manual/i.test(markdown)) {
    throw new Error('终稿仍包含人工装配要求，不能导出为投稿完成稿');
  }
}

function toMarkdownPath(path: string): string {
  return path.split(sep).join('/');
}

/** 构建完整 Markdown */
function buildMarkdown(
  sections: Section[],
  papers: Paper[],
  options: ExportOptions
): string {
  let md = '';

  // 标题
  md += `# ${options.title}\n\n`;

  // 作者
  if (options.authors?.length) {
    md += `${options.authors.join(', ')}\n\n`;
  }

  // 摘要
  if (options.abstract) {
    md += `## 摘要\n\n${options.abstract}\n\n`;
  }

  // 关键词
  if (options.keywords?.length) {
    md += `**关键词**：${options.keywords.join('；')}\n\n`;
  }

  md += `---\n\n`;

  // 正文
  for (const section of sections) {
    const level = Math.min(section.nodeId.split('.').length + 1, 4);
    md += `${'#'.repeat(level)} ${section.title}\n\n`;
    md += `${section.content}\n\n`;
  }

  // 参考文献
  md += `## 参考文献\n\n`;
  const citedPaperIds = new Set<string>();
  for (const section of sections) {
    for (const citation of section.citations) {
      citedPaperIds.add(citation.paperId);
    }
  }

  const citedPapers = papers.filter((p) => citedPaperIds.has(p.id));
  citedPapers.forEach((paper, idx) => {
    md += `[${idx + 1}] ${formatReference(paper, options.citationStyle)}\n\n`;
  });

  return md;
}

/** 格式化参考文献 */
function formatReference(paper: Paper, style?: string): string {
  const authors = paper.authors.join(', ');
  switch (style) {
    case 'APA':
      return `${authors} (${paper.year}). ${paper.title}.`;
    case 'IEEE':
      return `${authors}, "${paper.title}," ${paper.year}.`;
    case 'GB-T-7714':
    default:
      return `${authors}. ${paper.title}[J]. ${paper.year}.`;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
}

/** dsh 插件导出 */
export const docxExporterPlugin = {
  name: 'docx-exporter',
  description: 'Word 文档导出',
  tools: {
    export_docx: {
      description: '将论文各节、Markdown 和 LaTeX 公式导出为可编辑的 Word 文档',
      parameters: {
        sections: { type: 'array', description: '论文节列表', required: true },
        papers: { type: 'array', description: '文献列表', required: true },
        title: { type: 'string', description: '论文标题', required: true },
        authors: { type: 'array', description: '作者列表' },
        abstract: { type: 'string', description: '摘要' },
        keywords: { type: 'array', description: '关键词' },
        citationStyle: { type: 'string', description: '引用格式' },
        outputDir: { type: 'string', description: '输出目录' },
      },
      handler: exportToDocx,
    },
  },
};
