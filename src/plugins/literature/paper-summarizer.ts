/**
 * 文献精读与笔记插件
 *
 * 功能：对每篇文献生成结构化笔记（研究问题、方法、结论、局限性、可引用点）
 */

import { getModelClient } from '../../lib/model-client.js';
import type { Paper, PaperNote, ToolResult } from '../../types.js';

const SYSTEM_PROMPT = `你是一位资深学术研究助手，擅长精读学术论文并提取核心信息。
请根据论文摘要和全文片段，生成结构化的文献笔记。
要求：
1. 准确提取，不编造论文中没有的信息
2. 可引用点要具体，包含可直接引用的原文表述
3. 局限性要客观，包括方法局限和外部效度问题
4. 输出为 JSON 格式，不要包含 markdown 代码块标记`;

const NOTE_SCHEMA = `{
  "researchQuestion": "论文研究的核心问题（1-2句）",
  "methodology": "研究方法与数据来源（2-3句）",
  "keyFindings": "主要研究发现（3-5条，每条1句）",
  "limitations": "研究局限性（2-3条）",
  "citablePoints": ["可直接引用的观点或数据，每条包含原文表述"],
  "summary": "200字以内的综合摘要"
}`;

export async function summarizePaper(
  paper: Paper,
  fullText?: string
): Promise<ToolResult<PaperNote>> {
  try {
    const client = getModelClient();

    const userPrompt = `请精读以下论文并生成结构化笔记。

论文标题：${paper.title}
作者：${paper.authors.join(', ')}
年份：${paper.year}

摘要：
${paper.abstract}

${fullText ? `全文片段（前3000字）：\n${fullText.slice(0, 3000)}` : ''}

请严格按照以下 JSON schema 输出：
${NOTE_SCHEMA}`;

    const response = await client.generate(SYSTEM_PROMPT, userPrompt, {
      task: 'summary',
      temperature: 0.3,
      maxTokens: 2048,
    });

    // 尝试解析 JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: '模型返回内容无法解析为 JSON' };
    }

    const note = JSON.parse(jsonMatch[0]) as PaperNote;
    return { success: true, data: { ...note, paperId: paper.id } };
  } catch (error) {
    return {
      success: false,
      error: `文献精读失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 批量生成文献笔记（带并发控制） */
export async function batchSummarizePapers(
  papers: Paper[],
  fullTexts?: Map<string, string>,
  concurrency = 3
): Promise<Map<string, PaperNote>> {
  const notes = new Map<string, PaperNote>();
  const queue = [...papers];

  async function worker() {
    while (queue.length > 0) {
      const paper = queue.shift()!;
      const result = await summarizePaper(paper, fullTexts?.get(paper.id));
      if (result.success && result.data) {
        notes.set(paper.id, result.data);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, papers.length) }, () => worker());
  await Promise.all(workers);

  return notes;
}

/** dsh 插件导出 */
export const paperSummarizerPlugin = {
  name: 'paper-summarizer',
  description: '文献精读与结构化笔记生成',
  tools: {
    summarize_paper: {
      description: '对单篇论文生成结构化笔记（研究问题、方法、结论、局限性、可引用点）',
      parameters: {
        paper: { type: 'object', description: '文献对象（含 title, authors, year, abstract）', required: true },
        fullText: { type: 'string', description: '论文全文（可选）' },
      },
      handler: summarizePaper,
    },
  },
};
