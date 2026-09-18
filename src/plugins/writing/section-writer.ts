/**
 * 段落写作插件
 *
 * 功能：按大纲节点逐段生成论文正文，支持上下文滑动窗口
 * 这是长链路写作的核心组件
 */

import { getModelClient } from '../../lib/model-client.js';
import { selectBalancedLiterature } from '../../lib/literature-balance.js';
import type { OutlineNode, Paper, PaperNote, Section, Citation, ToolResult } from '../../types.js';

const SYSTEM_PROMPT = `你是一位严格的学术论文共同作者，擅长把证据组织成可投稿正文。
写作要求：
1. 学术化表达，逻辑严密，避免口语化
2. 每个实质性论点必须由“本小节可引用的文献”支撑，引用格式为 [序号]
3. 不得编造文献中没有的数据、实验、结论、页码、作者观点或参考文献
4. 文献不足时写成审慎表述，并明确“仍需进一步验证/补充数据”
5. 段落之间要有逻辑衔接，避免突兀跳转和机械堆引用
6. 保持客观中立的学术语气，优先清晰、可证伪、可审稿
7. 直接输出正文内容，不要包含解释性文字
8. 最近五年文献应与经典文献共同支撑各主要章节，不得集中堆放在某一个段落或章节
9. 定量结果只能使用“已验收实验结果”中明确出现的字段和值；没有结果证据时停止该数字或收缩表述
10. 必须报告与假设不一致的负结果、零效应、失败运行和异常值处理，不得选择性省略
11. 相关、回归和观察性比较只能写关联，除非给出了可核验的因果识别设计
12. 不得从图注、前文、模型记忆或手算恢复 P 值、效应量、相关系数、置信区间或倍数`;

export interface WriteSectionOptions {
  previousSections?: Section[]; // 已完成的前文（用于上下文衔接）
  papers: Paper[];
  notes: Map<string, PaperNote>;
  language?: 'zh' | 'en';
  citationStyle?: 'numbered' | 'author-year';
  journalInstructions?: string;
  evidenceContext?: string;
}

export interface WriteParagraphOptions extends WriteSectionOptions {
  currentSection?: string;
  paragraphIndex: number;
  totalParagraphs: number;
  targetWords: number;
}

/**
 * 撰写单个大纲节点的正文
 */
export async function writeSection(
  node: OutlineNode,
  options: WriteSectionOptions
): Promise<ToolResult<Section>> {
  try {
    const client = getModelClient();
    const language = options.language ?? 'zh';

    // 构建上下文：前文摘要（滑动窗口，取最近3节）
    const context = buildContext(options.previousSections || []);

    // 构建该节点的文献支撑
    const supportingPapers = selectBalancedLiterature(node.supportingPapers
      .map((id) => options.papers.find((p, index) => p.id === String(id) || String(index + 1) === String(id)))
      .filter(Boolean) as Paper[], node.supportingPapers.length);

    const literatureSupport = supportingPapers
      .map((p, i) => {
        const note = options.notes.get(p.id);
        const idx = options.papers.findIndex((pp) => pp.id === p.id) + 1;
        return `[${idx}] ${p.title} (${p.year})
   可引用：${note?.citablePoints?.slice(0, 2).join('; ') || p.abstract.slice(0, 150)}`;
      })
      .join('\n\n');

    const userPrompt = `请撰写以下论文小节的正文。

小节标题：${node.title}
核心论点：${node.argument || '请根据标题自行展开'}
预计字数：${node.estimatedWords}字
语言：${language === 'zh' ? '中文' : 'English'}

目标期刊约束：
${options.journalInstructions || '未指定目标期刊，采用通用研究论文规范。'}

${context ? `前文摘要（用于保持逻辑衔接）：\n${context}` : ''}

本小节可引用的文献：
${literatureSupport || '（无指定文献，请基于已有知识撰写，但不要编造具体引用）'}

已验收实验结果（这是定量主张的唯一来源；未出现的数字不得补写）：
${options.evidenceContext || '（本阶段没有提供实验结果，不得写新的实验数字或统计结论）'}

请直接输出正文，遵守目标期刊的写作重点；引用暂使用 [序号] 格式（序号对应上面文献列表的编号），最终排版阶段再转换期刊格式。`;

    const content = await client.generate(SYSTEM_PROMPT, userPrompt, {
      task: 'writing',
      temperature: 0.35,
      maxTokens: Math.min(4096, Math.ceil(node.estimatedWords * 2)),
    });

    // 提取引用
    const citations = extractCitations(content, options.papers);

    const section: Section = {
      id: node.id,
      nodeId: node.id,
      title: node.title,
      content: content.trim(),
      citations,
      wordCount: countWords(content),
      status: 'completed',
    };

    return { success: true, data: section };
  } catch (error) {
    return {
      success: false,
      error: `段落写作失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 每次只撰写并返回一个正文段落，供流水线即时保存检查点。
 */
export async function writeSectionParagraph(
  node: OutlineNode,
  options: WriteParagraphOptions
): Promise<ToolResult<Section>> {
  try {
    const client = getModelClient();
    const language = options.language ?? 'zh';
    const context = buildContext(options.previousSections || []);
    const currentSection = options.currentSection?.trim();
    const literatureSupport = buildLiteratureSupport(node, options.papers, options.notes);

    const userPrompt = `只撰写下面小节的第 ${options.paragraphIndex}/${options.totalParagraphs} 个正文段落。

小节标题：${node.title}
核心论点：${node.argument || '请根据标题和证据展开'}
本段目标长度：约 ${options.targetWords}${language === 'zh' ? '字' : ' words'}
语言：${language === 'zh' ? '中文' : 'English'}

目标期刊约束：
${options.journalInstructions || '未指定目标期刊，采用通用研究论文规范。'}

${context ? `已完成前文摘要：\n${context}` : ''}
${currentSection ? `本小节已经保存的内容（只续写，不要重复）：\n${currentSection.slice(-1600)}` : ''}

本小节可引用的文献：
${literatureSupport || '（无指定文献，不得编造具体引用）'}

已验收实验结果（定量主张只能逐字追溯到这里）：
${options.evidenceContext || '（未提供实验结果，不得写新的实验数字或统计结论）'}

只输出一个可直接追加到论文文件的完整段落。不要输出标题、提纲、写作计划、过程说明或“我将/正在写”等元话语；不要重复已保存内容。引用使用 [序号]。`;

    const content = await client.generate(SYSTEM_PROMPT, userPrompt, {
      task: 'writing',
      temperature: 0.3,
      maxTokens: Math.min(1200, Math.max(500, options.targetWords * 3)),
    });
    const paragraph = content.trim();
    if (!paragraph) {
      throw new Error('模型返回了空段落');
    }

    return {
      success: true,
      data: {
        id: node.id,
        nodeId: node.id,
        title: node.title,
        content: paragraph,
        citations: extractCitations(paragraph, options.papers),
        wordCount: countWords(paragraph),
        status: 'drafting',
        paragraphsCompleted: options.paragraphIndex,
        paragraphsPlanned: options.totalParagraphs,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `段落写作失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 构建前文上下文摘要（滑动窗口） */
function buildContext(previousSections: Section[]): string {
  if (previousSections.length === 0) return '';
  // 取最近3节，每节摘要前200字
  const recent = previousSections.slice(-3);
  return recent
    .map((s) => `【${s.title}】${s.content.slice(0, 200)}...`)
    .join('\n');
}

function buildLiteratureSupport(
  node: OutlineNode,
  papers: Paper[],
  notes: Map<string, PaperNote>
): string {
  const supportingPapers = node.supportingPapers
    .map((id) => papers.find((paper, index) => paper.id === String(id) || String(index + 1) === String(id)))
    .filter(Boolean) as Paper[];
  return selectBalancedLiterature(supportingPapers, supportingPapers.length)
    .map((paper) => {
      const note = notes.get(paper.id);
      const index = papers.findIndex((item) => item.id === paper.id) + 1;
      const evidence = note?.citablePoints?.slice(0, 2).join('; ') || paper.abstract.slice(0, 150);
      return `[${index}] ${paper.title} (${paper.year})\n   可引用：${evidence}`;
    })
    .join('\n\n');
}

/** 从正文中提取引用标记 */
function extractCitations(content: string, papers: Paper[]): Citation[] {
  const citations: Citation[] = [];
  const regex = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const idx = parseInt(match[1], 10) - 1;
    const paper = papers[idx];
    if (paper) {
      citations.push({
        paperId: paper.id,
        marker: match[0],
        verified: false,
        rawText: '',
      });
    }
  }

  return citations;
}

function countWords(text: string): number {
  // 中文字数 + 英文单词数
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const english = (text.match(/[a-zA-Z]+/g) || []).length;
  return chinese + english;
}

/** dsh 插件导出 */
export const sectionWriterPlugin = {
  name: 'section-writer',
  description: '论文正文逐段写作并支持即时检查点',
  tools: {
    write_paragraph: {
      description: '按大纲节点只撰写一个段落，便于即时保存和断点续写',
      parameters: {
        node: { type: 'object', description: '大纲节点', required: true },
        papers: { type: 'array', description: '全部文献列表', required: true },
        notes: { type: 'object', description: '文献笔记' },
        previousSections: { type: 'array', description: '已完成的论文节列表' },
        currentSection: { type: 'string', description: '本小节已保存内容' },
        paragraphIndex: { type: 'number', description: '当前段落序号', required: true },
        totalParagraphs: { type: 'number', description: '本小节计划段落数', required: true },
        targetWords: { type: 'number', description: '本段目标字数', required: true },
      },
      handler: writeSectionParagraph,
    },
  },
};
