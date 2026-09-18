/**
 * 逻辑连贯性检查插件
 *
 * 功能：检查已写段落之间的逻辑衔接，标记需要过渡或修改的地方
 */

import { getModelClient } from '../../lib/model-client.js';
import type { Section, ToolResult } from '../../types.js';

const SYSTEM_PROMPT = `你是一位学术论文审稿人，专门检查论文的逻辑连贯性。
请检查相邻段落之间的逻辑衔接，指出：
1. 逻辑跳跃：前后段落缺乏过渡
2. 论点重复：不同段落论述了相同观点
3. 论点矛盾：前后观点不一致
4. 引用不当：引用位置不合理或缺少引用
输出为 JSON 格式，包含问题列表和修改建议。`;

export interface CoherenceIssue {
  type: 'jump' | 'repeat' | 'contradiction' | 'citation';
  severity: 'high' | 'medium' | 'low';
  location: string; // 涉及的章节标题
  description: string;
  suggestion: string;
}

export async function checkCoherence(
  sections: Section[]
): Promise<ToolResult<CoherenceIssue[]>> {
  if (sections.length < 2) {
    return { success: true, data: [] };
  }

  try {
    const client = getModelClient();

    // 构建待检查文本（每节取标题+前300字）
    const textToCheck = sections
      .map((s) => `【${s.title}】\n${s.content.slice(0, 500)}${s.content.length > 500 ? '...' : ''}`)
      .join('\n\n---\n\n');

    const userPrompt = `请检查以下论文各节之间的逻辑连贯性。

${textToCheck}

请输出 JSON：
{
  "issues": [
    {
      "type": "jump|repeat|contradiction|citation",
      "severity": "high|medium|low",
      "location": "涉及的章节",
      "description": "问题描述",
      "suggestion": "修改建议"
    }
  ]
}`;

    const response = await client.generate(SYSTEM_PROMPT, userPrompt, {
      task: 'coherence',
      temperature: 0.3,
      maxTokens: 2048,
    });

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: '连贯性检查失败：无法解析 JSON' };
    }

    const result = JSON.parse(jsonMatch[0]);
    return { success: true, data: result.issues || [] };
  } catch (error) {
    return {
      success: false,
      error: `连贯性检查失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** dsh 插件导出 */
export const coherenceCheckerPlugin = {
  name: 'coherence-checker',
  description: '论文逻辑连贯性检查',
  tools: {
    check_coherence: {
      description: '检查论文各节之间的逻辑衔接，标记跳跃、重复、矛盾等问题',
      parameters: {
        sections: { type: 'array', description: '已完成的论文节列表', required: true },
      },
      handler: checkCoherence,
    },
  },
};
