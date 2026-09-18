/**
 * 文档解析插件 - 支持 PDF 和 DOCX
 *
 * 功能：解析文献全文，提取文本、标题、章节结构
 * 依赖：pdf-parse（PDF）、mammoth（DOCX）
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import type { ToolResult } from '../../types.js';

const execFileAsync = promisify(execFile);

export interface ParsedDocument {
  filePath: string;
  title: string;
  text: string;
  pageCount: number;
  sections: { title: string; content: string; page: number }[];
}

/** 统一文档解析入口：根据扩展名自动选择 PDF 或 DOCX 解析器 */
export async function parseDocument(
  docPath: string,
  options: { outputDir?: string } = {}
): Promise<ToolResult<ParsedDocument>> {
  const ext = extname(docPath).toLowerCase();
  if (ext === '.pdf') {
    return parsePdf(docPath, options);
  }
  if (ext === '.docx') {
    return parseDocx(docPath, options);
  }
  if (ext === '.txt' || ext === '.md') {
    return parseText(docPath, options);
  }
  return { success: false, error: `不支持的文件格式: ${ext}（支持 .pdf / .docx / .txt / .md）` };
}

/**
 * 解析 PDF 文件
 * 优先使用系统 pdftotext（Poppler），不可用时回退到 pdf-parse
 */
export async function parsePdf(
  pdfPath: string,
  options: { outputDir?: string } = {}
): Promise<ToolResult<ParsedDocument>> {
  if (!existsSync(pdfPath)) {
    return { success: false, error: `文件不存在: ${pdfPath}` };
  }

  try {
    let text = '';
    let pageCount = 0;

    // 尝试用 pdftotext 提取
    try {
      const { stdout } = await execFileAsync('pdftotext', ['-layout', pdfPath, '-'], {
        maxBuffer: 50 * 1024 * 1024,
      });
      text = stdout;
      pageCount = (text.match(/\f/g) || []).length + 1;
    } catch {
      // pdftotext 不可用，尝试用 pdf-parse
      try {
        const pdfParseModule = await import('pdf-parse');
        const pdfParse = (pdfParseModule as Record<string, unknown>).default || pdfParseModule;
        const dataBuffer = await readFile(pdfPath);
        const data = await (pdfParse as (buffer: Buffer) => Promise<{ text: string; numpages: number }>)(dataBuffer);
        text = data.text;
        pageCount = data.numpages || 1;
      } catch {
        return {
          success: false,
          error: '无法解析 PDF：请安装系统工具 pdftotext（Poppler）或 npm 包 pdf-parse',
        };
      }
    }

    const title = extractTitle(text, pdfPath);
    const sections = extractSections(text);

    if (options.outputDir) {
      await mkdir(options.outputDir, { recursive: true });
      const outPath = join(options.outputDir, `${basename(pdfPath, extname(pdfPath))}.txt`);
      await writeFile(outPath, text, 'utf-8');
    }

    return {
      success: true,
      data: { filePath: pdfPath, title, text, pageCount, sections },
    };
  } catch (error) {
    return {
      success: false,
      error: `PDF 解析失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 解析 DOCX 文件（使用 mammoth）
 */
export async function parseDocx(
  docxPath: string,
  options: { outputDir?: string } = {}
): Promise<ToolResult<ParsedDocument>> {
  if (!existsSync(docxPath)) {
    return { success: false, error: `文件不存在: ${docxPath}` };
  }

  try {
    const mammothModule = await import('mammoth');
    const mammoth = (mammothModule as Record<string, unknown>).default || mammothModule;
    const dataBuffer = await readFile(docxPath);

    const result = await (mammoth as {
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>;
    }).extractRawText({ buffer: dataBuffer });

    const text = result.value || '';
    // DOCX 没有明确的分页，按字数估算页数（每页约 500 字）
    const pageCount = Math.max(1, Math.ceil(text.length / 1500));

    const title = extractTitle(text, docxPath);
    const sections = extractSections(text);

    if (options.outputDir) {
      await mkdir(options.outputDir, { recursive: true });
      const outPath = join(options.outputDir, `${basename(docxPath, '.docx')}.txt`);
      await writeFile(outPath, text, 'utf-8');
    }

    return {
      success: true,
      data: { filePath: docxPath, title, text, pageCount, sections },
    };
  } catch (error) {
    return {
      success: false,
      error: `DOCX 解析失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 解析纯文本文件 */
async function parseText(
  txtPath: string,
  options: { outputDir?: string } = {}
): Promise<ToolResult<ParsedDocument>> {
  if (!existsSync(txtPath)) {
    return { success: false, error: `文件不存在: ${txtPath}` };
  }
  try {
    const text = await readFile(txtPath, 'utf-8');
    const pageCount = Math.max(1, Math.ceil(text.length / 1500));
    const title = extractTitle(text, txtPath);
    const sections = extractSections(text);
    return { success: true, data: { filePath: txtPath, title, text, pageCount, sections } };
  } catch (error) {
    return { success: false, error: `文本读取失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 从文本中提取标题 */
function extractTitle(text: string, filePath: string): string {
  const firstPage = text.split('\f')[0] || text;
  const lines = firstPage
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 10 && l.length < 200);
  return lines.slice(0, 3).join(' ') || basename(filePath, extname(filePath));
}

/** 基于正则提取章节 */
function extractSections(text: string): { title: string; content: string; page: number }[] {
  const sections: { title: string; content: string; page: number }[] = [];
  const lines = text.split('\n');
  let currentTitle = '前言';
  let currentContent: string[] = [];
  let currentPage = 1;

  const sectionPattern = /^\s*(\d+(?:\.\d+)*)\s+([A-Z][A-Za-z\s]{2,80})$/;

  for (const line of lines) {
    if (line === '\f') {
      currentPage++;
      continue;
    }
    const match = line.match(sectionPattern);
    if (match && currentContent.length > 5) {
      sections.push({
        title: currentTitle,
        content: currentContent.join('\n'),
        page: currentPage,
      });
      currentTitle = `${match[1]} ${match[2].trim()}`;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    sections.push({ title: currentTitle, content: currentContent.join('\n'), page: currentPage });
  }

  return sections;
}

/** dsh 插件导出 */
export const pdfParserPlugin = {
  name: 'pdf-parser',
  description: '文献全文解析（支持 PDF / DOCX / TXT / MD）',
  tools: {
    parse_document: {
      description: '解析文献文件，提取全文文本和章节结构（支持 PDF / DOCX / TXT / MD）',
      parameters: {
        filePath: { type: 'string', description: '文件绝对路径', required: true },
        outputDir: { type: 'string', description: '解析结果输出目录' },
      },
      handler: parseDocument,
    },
  },
};

export const documentParserPlugin = pdfParserPlugin;
