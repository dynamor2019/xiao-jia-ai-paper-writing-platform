import 'dotenv/config';

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { formatPaperQualityReport, validateDocxFile, validateMarkdownPaper } from '../plugins/verification/paper-quality-validator.js';
import { formatScientificReview, reviewScientificQuality } from '../plugins/verification/scientific-quality-reviewer.js';
import type { Section } from '../types.js';

async function main(): Promise<void> {
  const markdownPath = process.argv[2] ? resolve(process.argv[2]) : '';
  const docxPath = process.argv[3] && !process.argv[3].startsWith('--') ? resolve(process.argv[3]) : undefined;
  const semantic = process.argv.includes('--semantic');
  if (!markdownPath) throw new Error('用法: npm run paper:validate -- <paper.md> [paper.docx] [--semantic]');

  const markdown = await readFile(markdownPath, 'utf-8');
  const sourceReport = validateMarkdownPaper(markdown);
  const reports = [formatPaperQualityReport('Source Paper Quality Gate', sourceReport)];
  let passed = sourceReport.passed;

  if (docxPath) {
    const docxReport = await validateDocxFile(docxPath, sourceReport.metrics);
    reports.push(formatPaperQualityReport('DOCX Quality Gate', docxReport));
    passed = passed && docxReport.passed;
  }

  if (semantic) {
    const review = await reviewScientificQuality(asReviewSections(markdown), 'General scientific journal');
    if (!review.success || !review.data) throw new Error(review.error || '独立科技审查没有返回结果');
    reports.push(formatScientificReview(review.data));
    const blocking = review.data.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'major');
    passed = passed && review.data.verdict === 'pass' && !blocking;
  }

  const reportPath = markdownPath.replace(/\.md$/i, '.quality-report.md');
  await writeFile(reportPath, reports.join('\n'), 'utf-8');
  console.log(`质量报告: ${reportPath}`);
  console.log(passed ? 'PASS' : 'BLOCKED');
  if (!passed) process.exitCode = 2;
}

function asReviewSections(markdown: string): Section[] {
  const matches = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)];
  if (matches.length === 0) return [createReviewSection('Full Manuscript', markdown, 0)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return createReviewSection(match[1].trim(), markdown.slice(start, end).trim(), index);
  });
}

function createReviewSection(title: string, content: string, index: number): Section {
  return {
    id: `review-${index}`,
    nodeId: `review-${index}`,
    title,
    content,
    citations: [],
    wordCount: content.split(/\s+/).length,
    status: 'needs-review',
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
