/**
 * 论文润色插件
 *
 * 功能：对论文各章节进行自动润色，提升文采和表达准确性
 * 模型：按 task: 'polish' 路由（默认 gpt-5.6-luna）
 */

import { getModelClient } from '../../lib/model-client.js';

export interface PolishResult {
  sectionId: string;
  originalTitle: string;
  polishedContent: string;
  changes: string[];
}

/**
 * 润色单个章节
 */
export async function polishSection(
  sectionId: string,
  title: string,
  content: string,
  paperTopic: string,
  journalInstructions?: string
): Promise<PolishResult> {
  const client = getModelClient();

  const systemPrompt = `你是一位保守的学术论文润色编辑。你的任务是提升清晰度、逻辑密度和投稿表达质量，同时保持学术严谨性和原意不变。

润色原则：
1. 保持原意和核心观点不变
2. 提升语言表达的流畅性和专业性
3. 修正语法错误和不规范表达
4. 优化学术术语的使用
5. 保持引用格式不变
6. 不要添加或删除核心论点
7. 不新增事实、数据、引用、实验结果或未经原文支持的强结论
8. 删除夸张表达、宣传口吻和无法证实的绝对化措辞

请直接输出润色后的完整文本，不要添加解释或评论。`;

  const userPrompt = `论文主题：${paperTopic}

章节标题：${title}

目标期刊约束：
${journalInstructions || '未指定目标期刊，采用通用研究论文规范。'}

原始内容：
${content}

请对以上内容进行学术润色。`;

  try {
    const polished = await client.generate(systemPrompt, userPrompt, {
      task: 'polish',
      temperature: 0.25,
      maxTokens: 4096,
    });

    return {
      sectionId,
      originalTitle: title,
      polishedContent: polished.trim(),
      changes: ['语言流畅性提升', '学术表达优化'],
    };
  } catch (error) {
    console.warn(`章节 "${title}" 润色失败，保留原文: ${error instanceof Error ? error.message : String(error)}`);
    return {
      sectionId,
      originalTitle: title,
      polishedContent: content,
      changes: [],
    };
  }
}

/**
 * 批量润色所有章节
 */
export async function polishAllSections(
  sections: Array<{ id: string; title: string; content: string }>,
  paperTopic: string,
  journalInstructions?: string
): Promise<Array<{ id: string; title: string; content: string }>> {
  console.log(`开始润色 ${sections.length} 个章节...`);
  const results: Array<{ id: string; title: string; content: string }> = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    console.log(`  [${i + 1}/${sections.length}] 润色: ${section.title}`);
    const result = await polishSection(section.id, section.title, section.content, paperTopic, journalInstructions);
    results.push({
      id: section.id,
      title: section.title,
      content: result.polishedContent,
    });
    if (result.changes.length > 0) {
      console.log(`    ✓ 完成 (${result.changes.join(', ')})`);
    } else {
      console.log(`    ⚠ 保留原文`);
    }
  }

  console.log(`润色完成，共处理 ${results.length} 个章节`);
  return results;
}
