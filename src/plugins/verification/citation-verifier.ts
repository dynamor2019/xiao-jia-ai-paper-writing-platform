/**
 * 引用核验插件（防幻觉核心组件）
 *
 * 功能：逐条核验论文中的引用
 * 1. 文献是否真实存在（在本地文献库中能找到）
 * 2. 引用的观点是否与原文一致
 * 3. 标记无法核验的引用，提示人工确认
 */

import { getModelClient } from '../../lib/model-client.js';
import type { Paper, PaperNote, Section, Citation, ToolResult } from '../../types.js';

const SYSTEM_PROMPT = `你是一位严格的学术诚信审核员，专门核验论文引用的真实性、准确性和证据强度。
对于每一条引用，你需要判断：
1. 该文献是否在提供的文献列表中存在
2. 引用的观点是否与文献摘要/笔记一致
3. 是否存在编造引用（文献不存在或观点与原文不符）
4. 是否把弱证据、背景性材料或未经验证的推测写成强结论
输出为 JSON 格式，逐条给出核验结果。
务必严格：宁可标记为"待人工确认"，也不要放过可能的幻觉引用。`;

const VALID_STATUSES = new Set(['verified', 'not-found', 'mismatch', 'needs-review']);

export interface VerificationResult {
  citation: Citation;
  paper?: Paper;
  status: 'verified' | 'not-found' | 'mismatch' | 'needs-review';
  reason: string;
}

export async function verifyCitations(
  sections: Section[],
  papers: Paper[],
  notes: Map<string, PaperNote>
): Promise<ToolResult<VerificationResult[]>> {
  try {
    // 收集所有引用
    const allCitations: Citation[] = [];
    for (const section of sections) {
      allCitations.push(...section.citations);
    }

    if (allCitations.length === 0) {
      return { success: true, data: [] };
    }

    const client = getModelClient();
    const results: VerificationResult[] = [];

    // 批量核验（每批10条）
    const batchSize = 10;
    for (let i = 0; i < allCitations.length; i += batchSize) {
      const batch = allCitations.slice(i, i + batchSize);
      const result = await verifyBatch(batch, papers, notes, client);
      results.push(...result);
    }

    return { success: true, data: results };
  } catch (error) {
    return {
      success: false,
      error: `引用核验失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function verifyBatch(
  citations: Citation[],
  papers: Paper[],
  notes: Map<string, PaperNote>,
  client: ReturnType<typeof getModelClient>
): Promise<VerificationResult[]> {
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const finalResults: VerificationResult[] = citations.map((citation) => {
    const paper = paperById.get(citation.paperId);
    if (!paper) return buildResult(citation, undefined, 'not-found', 'paperId 不在文献库中');
    if (!citation.rawText?.trim()) return buildResult(citation, paper, 'needs-review', '缺少引用所在句，不能判断文献是否支撑该句');
    return buildResult(citation, paper, 'needs-review', '模型核验尚未返回');
  });
  const reviewable = citations
    .map((citation, originalIndex) => ({ citation, originalIndex, paper: paperById.get(citation.paperId) }))
    .filter((item) => item.paper && item.citation.rawText?.trim());
  if (reviewable.length === 0) return finalResults;

  // 构建文献库上下文
  const paperLibrary = reviewable
    .map(({ paper }, idx) => {
      const note = notes.get(paper!.id);
      return `[${idx + 1}] ID: ${paper!.id}
   标题: ${paper!.title}
   年份: ${paper!.year}
   摘要/核心发现: ${(note?.keyFindings || paper!.abstract).slice(0, 500)}
   可引用点: ${note?.citablePoints?.slice(0, 4).join('; ') || '无结构化笔记'}`;
    })
    .join('\n\n');

  const citationsList = reviewable
    .map(({ citation }, i) => `引用${i + 1}: marker=${citation.marker}, paperId=${citation.paperId}
   引用所在句: ${citation.rawText.slice(0, 800)}`)
    .join('\n');

  const userPrompt = `请核验以下引用。

文献库：
${paperLibrary}

待核验引用：
${citationsList}

对每条引用输出：
{
  "results": [
    {
      "index": 1,
      "status": "verified|not-found|mismatch|needs-review",
      "reason": "核验说明"
    }
  ]
}

判断标准：
- verified: 文献存在且引用合理
- not-found: paperId 在文献库中不存在
- mismatch: 文献存在但引用的观点与原文不符
- needs-review: 证据不足、上下文不足、观点过强或无法确定，需要人工确认

要求：
- results 必须覆盖上面每一条待核验引用，不得省略。
- 只能依据给出的引用所在句、摘要和笔记判断；如果无法确定，输出 needs-review。`;

  const response = await client.generate(SYSTEM_PROMPT, userPrompt, {
    task: 'citation',
    temperature: 0.1,
    maxTokens: 2048,
  });

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    for (const { citation, originalIndex, paper } of reviewable) {
      finalResults[originalIndex] = buildResult(citation, paper, 'needs-review', '核验模型没有返回可解析 JSON');
    }
    return finalResults;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const rows = Array.isArray(parsed.results) ? parsed.results as Array<{ index?: number; status?: string; reason?: string }> : [];
    for (let i = 0; i < reviewable.length; i++) {
      const row = rows.find((item) => item.index === i + 1);
      const { citation, originalIndex, paper } = reviewable[i];
      if (!row) {
        finalResults[originalIndex] = buildResult(citation, paper, 'needs-review', '核验模型漏掉了这条引用');
        continue;
      }
      const status = VALID_STATUSES.has(String(row.status)) ? row.status as VerificationResult['status'] : 'needs-review';
      finalResults[originalIndex] = buildResult(citation, paper, status, row.reason || '核验模型未给出说明');
    }
    return finalResults;
  } catch {
    for (const { citation, originalIndex, paper } of reviewable) {
      finalResults[originalIndex] = buildResult(citation, paper, 'needs-review', '核验模型返回的 JSON 无法解析');
    }
    return finalResults;
  }
}

function buildResult(
  citation: Citation,
  paper: Paper | undefined,
  status: VerificationResult['status'],
  reason: string
): VerificationResult {
  return { citation, paper, status, reason };
}

/** 生成引用核验报告 */
export function generateVerificationReport(results: VerificationResult[]): string {
  const verified = results.filter((r) => r.status === 'verified').length;
  const notFound = results.filter((r) => r.status === 'not-found').length;
  const mismatch = results.filter((r) => r.status === 'mismatch').length;
  const needsReview = results.filter((r) => r.status === 'needs-review').length;

  let report = `# 引用核验报告\n\n`;
  report += `## 统计\n\n`;
  report += `- 总引用数: ${results.length}\n`;
  report += `- ✅ 已验证: ${verified}\n`;
  report += `- ❌ 文献不存在: ${notFound}\n`;
  report += `- ⚠️ 观点不符: ${mismatch}\n`;
  report += `- 🔍 待人工确认: ${needsReview}\n\n`;

  if (notFound > 0 || mismatch > 0 || needsReview > 0) {
    report += `## 问题引用\n\n`;
    for (const r of results.filter((r) => r.status !== 'verified')) {
      report += `### [${r.status}] ${r.citation.marker}\n`;
      report += `- 文献ID: ${r.citation.paperId}\n`;
      if (r.citation.rawText) report += `- 引用所在句: ${r.citation.rawText}\n`;
      report += `- 说明: ${r.reason}\n\n`;
    }
  }

  return report;
}

/** dsh 插件导出 */
export const citationVerifierPlugin = {
  name: 'citation-verifier',
  description: '引用真实性核验（防幻觉）',
  tools: {
    verify_citations: {
      description: '逐条核验论文引用的真实性，标记不存在或观点不符的引用',
      parameters: {
        sections: { type: 'array', description: '论文节列表', required: true },
        papers: { type: 'array', description: '文献库', required: true },
        notes: { type: 'object', description: '文献笔记' },
      },
      handler: verifyCitations,
    },
  },
};
