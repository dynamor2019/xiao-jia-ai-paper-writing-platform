/**
 * 重复率检测插件
 *
 * 功能：基于本地相似度计算检测论文重复率
 * 注意：完整的学术不端检测需要对接知网/Turnitin等专业系统，
 * 本插件提供基础的 n-gram 相似度检测作为初步筛查
 */

import type { Section, ToolResult } from '../../types.js';

export interface PlagiarismResult {
  totalWordCount: number;
  duplicateWordCount: number;
  duplicateRate: number; // 百分比
  suspiciousSegments: { text: string; similarity: number; source?: string }[];
}

/**
 * 基础重复率检测（n-gram 方法）
 * 对比论文内部重复 + 与已有文献摘要的重复
 */
export async function checkPlagiarism(
  sections: Section[],
  referenceTexts?: { title: string; text: string }[]
): Promise<ToolResult<PlagiarismResult>> {
  try {
    const fullText = sections.map((s) => s.content).join('\n\n');
    const totalWordCount = countWords(fullText);

    if (totalWordCount === 0) {
      return { success: true, data: { totalWordCount: 0, duplicateWordCount: 0, duplicateRate: 0, suspiciousSegments: [] } };
    }

    const suspiciousSegments: { text: string; similarity: number; source?: string }[] = [];
    let duplicateWordCount = 0;

    // 1. 检测内部重复（不同段落间的重复内容）
    const internalDuplicates = detectInternalDuplicates(sections);
    suspiciousSegments.push(...internalDuplicates);
    duplicateWordCount += internalDuplicates.reduce((sum, s) => sum + countWords(s.text), 0);

    // 2. 与参考文献对比（如果提供）
    if (referenceTexts && referenceTexts.length > 0) {
      const externalDuplicates = detectExternalDuplicates(fullText, referenceTexts);
      suspiciousSegments.push(...externalDuplicates);
      duplicateWordCount += externalDuplicates.reduce((sum, s) => sum + countWords(s.text), 0);
    }

    const duplicateRate = Math.min(100, (duplicateWordCount / totalWordCount) * 100);

    return {
      success: true,
      data: {
        totalWordCount,
        duplicateWordCount,
        duplicateRate: Math.round(duplicateRate * 100) / 100,
        suspiciousSegments: suspiciousSegments.slice(0, 20),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `重复率检测失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 检测内部重复 */
function detectInternalDuplicates(sections: Section[]): { text: string; similarity: number }[] {
  const results: { text: string; similarity: number }[] = [];
  const n = 8; // 8-gram

  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const gramsA = getNGrams(sections[i].content, n);
      const gramsB = getNGrams(sections[j].content, n);
      const intersection = new Set([...gramsA].filter((g) => gramsB.has(g)));
      const similarity = intersection.size / Math.max(gramsA.size, gramsB.size, 1);

      if (similarity > 0.3) {
        // 找到重复片段
        for (const gram of intersection) {
          results.push({ text: gram, similarity });
        }
      }
    }
  }

  return results;
}

/** 检测与外部文献的重复 */
function detectExternalDuplicates(
  text: string,
  references: { title: string; text: string }[]
): { text: string; similarity: number; source: string }[] {
  const results: { text: string; similarity: number; source: string }[] = [];
  const n = 10; // 10-gram for external
  const textGrams = getNGrams(text, n);

  for (const ref of references) {
    const refGrams = getNGrams(ref.text, n);
    const intersection = new Set([...textGrams].filter((g) => refGrams.has(g)));
    const similarity = intersection.size / Math.max(textGrams.size, 1);

    if (similarity > 0.05) {
      for (const gram of intersection) {
        results.push({ text: gram, similarity, source: ref.title });
      }
    }
  }

  return results;
}

/** 生成 n-gram 集合 */
function getNGrams(text: string, n: number): Set<string> {
  const clean = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i <= clean.length - n; i++) {
    grams.add(clean.slice(i, i + n));
  }
  return grams;
}

function countWords(text: string): number {
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const english = (text.match(/[a-zA-Z]+/g) || []).length;
  return chinese + english;
}

/** dsh 插件导出 */
export const plagiarismCheckerPlugin = {
  name: 'plagiarism-checker',
  description: '论文重复率初步检测',
  tools: {
    check_plagiarism: {
      description: '基于 n-gram 相似度检测论文内部重复和与文献的重复',
      parameters: {
        sections: { type: 'array', description: '论文节列表', required: true },
        referenceTexts: { type: 'array', description: '参考文献全文列表' },
      },
      handler: checkPlagiarism,
    },
  },
};
