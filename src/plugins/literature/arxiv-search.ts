/**
 * arXiv 文献检索插件
 *
 * 功能：根据关键词检索 arXiv 论文，返回结构化文献列表
 * 接口：arXiv API（无需 API Key）
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Paper, ToolResult } from '../../types.js';

const execFileAsync = promisify(execFile);

const ARXIV_API_URLS = [
  'https://export.arxiv.org/api/query',
  'http://export.arxiv.org/api/query',
];

export async function arxivSearch(
  keywords: string,
  options: { maxResults?: number; start?: number; sortBy?: 'relevance' | 'submittedDate' | 'lastUpdatedDate' } = {}
): Promise<ToolResult<Paper[]>> {
  const maxResults = options.maxResults ?? 20;
  const start = options.start ?? 0;
  const sortBy = options.sortBy ?? 'relevance';

  try {
    // arXiv API 查询参数
    const searchQuery = `all:${encodeURIComponent(keywords)}`;
    const queryString = `search_query=${searchQuery}&start=${start}&max_results=${maxResults}&sortBy=${sortBy}&sortOrder=descending`;
    const response = await fetchArxivText(queryString);
    if (!response.ok) {
      return { success: false, error: `arXiv API 请求失败: ${response.status}` };
    }

    const xmlText = response.text;
    if (!looksLikeArxivXml(xmlText)) {
      return {
        success: false,
        error: 'arXiv 返回了非 XML 内容，可能是网络代理、登录页或服务限流页面',
      };
    }

    const papers = parseArxivXml(xmlText);

    return { success: true, data: papers };
  } catch (error) {
    return {
      success: false,
      error: `arXiv 检索异常: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function fetchArxivText(queryString: string): Promise<{ ok: boolean; status: number; text: string }> {
  let lastError: unknown;

  for (const baseUrl of ARXIV_API_URLS) {
    const url = `${baseUrl}?${queryString}`;
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
          'User-Agent': 'paper-agent-dsh/0.1.0 (academic literature search)',
        },
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) {
      lastError = error;
    }

    if (process.platform === 'win32') {
      try {
        const text = await fetchArxivWithPowerShell(url);
        return { ok: true, status: 200, text };
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchArxivWithPowerShell(url: string): Promise<string> {
  const command = [
    '$ProgressPreference = "SilentlyContinue";',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8;`,
    `$r = Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -UseBasicParsing -TimeoutSec 30;`,
    '$r.Content',
  ].join(' ');
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

function looksLikeArxivXml(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith('<?xml') || trimmed.startsWith('<feed');
}

/** 解析 arXiv Atom XML 响应 */
function parseArxivXml(xml: string): Paper[] {
  const papers: Paper[] = [];

  // 用正则提取 entry 块（简单解析，避免依赖 xml 库）
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const idMatch = entry.match(/<id>([^<]+)<\/id>/);
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const publishedMatch = entry.match(/<published>(\d{4})/);

    const authors: string[] = [];
    const authorRegex = /<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g;
    let authorMatch: RegExpExecArray | null;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    const arxivId = idMatch?.[1]?.split('/abs/').pop() || '';

    papers.push({
      id: `arxiv:${arxivId}`,
      title: (titleMatch?.[1] || '').trim().replace(/\s+/g, ' '),
      authors,
      year: publishedMatch ? parseInt(publishedMatch[1], 10) : new Date().getFullYear(),
      abstract: (summaryMatch?.[1] || '').trim().replace(/\s+/g, ' '),
      url: idMatch?.[1],
      source: 'arxiv',
    });
  }

  return papers;
}

/** dsh 插件导出格式 */
export const arxivSearchPlugin = {
  name: 'arxiv-search',
  description: 'arXiv 学术论文检索',
  tools: {
    arxiv_search: {
      description: '根据关键词检索 arXiv 论文，返回标题、作者、摘要等信息',
      parameters: {
        keywords: { type: 'string', description: '检索关键词', required: true },
        maxResults: { type: 'number', description: '最大返回数量，默认20' },
      },
      handler: arxivSearch,
    },
  },
};
