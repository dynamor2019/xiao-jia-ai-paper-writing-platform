/**
 * 大纲生成插件
 *
 * 功能：基于选题和文献笔记生成三级结构化论文大纲
 */

import { getModelClient } from '../../lib/model-client.js';
import { isRecentPaper, selectBalancedLiterature } from '../../lib/literature-balance.js';
import type { Outline, OutlineNode, Paper, PaperNote, ToolResult } from '../../types.js';

const SYSTEM_PROMPT = `你是一位严谨的学术论文架构师，目标是产出可投稿论文的大纲，而不是泛泛综述。
请根据研究主题和已收集的文献，生成结构化的三级论文大纲。
要求：
1. 明确研究问题、研究空白、本文贡献、方法/框架、结果或论证、局限与讨论
2. 每个核心论点必须绑定提供文献中的 paper.id，不能使用文献序号或编造文献
3. 区分“已有证据支持”“需要作者补充实验/数据”“只能作为讨论”的内容
4. 字数分配合理，引言和结论各占10-15%，主体部分占70-80%
5. 输出为 JSON 格式，不要包含 markdown 代码块标记`;

export async function generateOutline(
  topic: string,
  papers: Paper[],
  notes: Map<string, PaperNote>,
  options: { targetWords?: number; language?: 'zh' | 'en'; journalInstructions?: string } = {}
): Promise<ToolResult<Outline>> {
  try {
    const client = getModelClient();
    const targetWords = options.targetWords ?? 8000;
    const language = options.language ?? 'zh';

    // 构建文献综述上下文
    const literatureContext = selectBalancedLiterature(papers, 30)
      .map((p, i) => {
        const note = notes.get(p.id);
        return `[${i + 1}] paper.id=${p.id}
   标题：${p.title} (${p.year})
   核心发现：${note?.keyFindings || p.abstract.slice(0, 200)}
   可引用点：${note?.citablePoints?.slice(0, 2).join('; ') || '无'}`;
      })
      .join('\n\n');

    const userPrompt = `请为以下研究主题生成论文大纲。

研究主题：${topic}
目标字数：${targetWords}字
语言：${language === 'zh' ? '中文' : 'English'}

目标期刊约束：
${options.journalInstructions || '未指定目标期刊，采用通用研究论文规范。'}

已收集的文献（共${papers.length}篇）：
${literatureContext}

时效性要求：最近五个自然年发表的文献不得少于引用文献的30%，并应轮换分配到各个有文献支撑的主要章节，不能集中堆放在引言或单一小节。

请生成三级大纲，每个节点包含：
- id: 唯一标识（如 "1", "1.1", "1.1.1"）
- level: 层级（1/2/3）
- title: 节点标题
- argument: 该节点的核心论点
- supportingPapers: 支撑该论点的 paper.id 字符串数组（如 ["paper-a", "paper-b"]）
- estimatedWords: 预计字数

如果某个节点缺少足够文献支撑，请在 argument 中明确写出“需作者补充证据”，不要把弱证据包装成强结论。
大纲必须覆盖目标期刊要求的专门板块和审稿关注点；不得为了迎合期刊而编造结果。

输出 JSON 格式：
{
  "topic": "研究主题",
  "nodes": [ ... ],
  "totalEstimatedWords": 总字数
}`;

    const response = await client.generate(SYSTEM_PROMPT, userPrompt, {
      task: 'outline',
      temperature: 0.5,
      maxTokens: 4096,
    });

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: '大纲生成失败：无法解析模型返回的 JSON' };
    }

    const outline = JSON.parse(jsonMatch[0]) as Outline;
    distributeRecentEvidence(outline.nodes, papers);
    return { success: true, data: outline };
  } catch (error) {
    return {
      success: false,
      error: `大纲生成失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function distributeRecentEvidence(nodes: OutlineNode[], papers: Paper[]): void {
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const recentIds = papers.filter((paper) => isRecentPaper(paper)).map((paper) => paper.id);
  if (recentIds.length === 0) return;
  let cursor = 0;
  const visit = (items: OutlineNode[]) => {
    for (const node of items) {
      if (node.supportingPapers.length > 0) {
        const recentCount = node.supportingPapers.filter((id) => {
          const paper = paperById.get(String(id));
          return paper ? isRecentPaper(paper) : false;
        }).length;
        const required = Math.ceil(node.supportingPapers.length * 0.3);
        let count = recentCount;
        let attempts = 0;
        while (count < required && attempts < recentIds.length) {
          const candidate = recentIds[cursor++ % recentIds.length];
          attempts++;
          if (node.supportingPapers.includes(candidate)) continue;
          node.supportingPapers.push(candidate);
          count++;
        }
      }
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
}

/** 扁平化大纲节点为有序列表 */
export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  const result: OutlineNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children) {
      result.push(...flattenOutline(node.children));
    }
  }
  return result;
}

/** dsh 插件导出 */
export const outlineGeneratorPlugin = {
  name: 'outline-generator',
  description: '论文大纲生成',
  tools: {
    generate_outline: {
      description: '基于选题和文献笔记生成三级结构化论文大纲',
      parameters: {
        topic: { type: 'string', description: '研究主题', required: true },
        papers: { type: 'array', description: '文献列表', required: true },
        notes: { type: 'object', description: '文献笔记 Map' },
        targetWords: { type: 'number', description: '目标字数，默认8000' },
        language: { type: 'string', description: '语言 zh/en' },
      },
      handler: generateOutline,
    },
  },
};
