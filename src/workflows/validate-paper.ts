import '../../scripts/project-env.mjs';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatPaperQualityReport, validateDocxFile, validateMarkdownPaper } from '../plugins/verification/paper-quality-validator.js';
import { formatScientificReview, reviewScientificQuality } from '../plugins/verification/scientific-quality-reviewer.js';
import { validateReviewEvidence } from '../plugins/verification/review-evidence.js';
import { auditReferenceMetadata } from '../plugins/verification/reference-metadata.js';
import { reviewWithAdjudication } from './scientific-review-gate.js';
import type { Section } from '../types.js';

/** Supply current source passages to scientific review, not an earlier audit's approval label. */
export async function currentCitationEvidence(manuscriptPath: string, sha256: string): Promise<string> {
  const path = join(dirname(manuscriptPath), '.dsh-state', 'citation-support', 'current.json');
  const report = await readFile(path, 'utf8').then(text => JSON.parse(text)).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!report) return '';
  if (report.sha256 !== sha256 || !Array.isArray(report.results)) {
    throw new Error('CITATION_AUDIT_STALE: update the citation audit before paying for scientific review');
  }
  const sources = new Map();
  for (const result of report.results) {
    const paper = result.paper;
    if (paper?.id && paper.abstract?.trim()) sources.set(paper.id,
      { id: paper.id, title: paper.title, url: paper.url, excerpt: paper.abstract });
  }
  return `\nCURRENT CITATION EVIDENCE (same manuscript SHA256 ${sha256}; excerpt-level evidence, not full-text or author approval):\n${JSON.stringify({
    inputs: report.inputs, sources: [...sources.values()],
    locations: report.results.map((result: { citation: unknown }) => result.citation),
  })}\nHistorical absence-of-evidence comments describe that earlier search, not an assertion made by this manuscript. Judge current assertions and supplied passages yourself; do not infer approval from the existence of this evidence bundle.`;
}

async function main(): Promise<void> {
  const markdownPath = process.argv[2] ? resolve(process.argv[2]) : '';
  const docxPath = process.argv[3] && !process.argv[3].startsWith('--') ? resolve(process.argv[3]) : undefined;
  const semantic = process.argv.includes('--semantic');
  if (!markdownPath) throw new Error('用法: npm run paper:validate -- <paper.md> [paper.docx] [--semantic]');

  const markdown = await readFile(markdownPath, 'utf-8');
  const manuscriptHash = createHash('sha256').update(markdown).digest('hex');
  const sourceReport = validateMarkdownPaper(markdown);
  const reports = [`Manuscript SHA256: ${manuscriptHash}\n`, formatPaperQualityReport('Source Paper Quality Gate', sourceReport)];
  let passed = sourceReport.passed;

  if (semantic || process.argv.includes('--references')) {
    const metadataPath = join(dirname(markdownPath), '.dsh-state', 'reference-metadata.json');
    const cached = await readFile(metadataPath, 'utf8').then(value => JSON.parse(value)).catch(() => []);
    const references = await auditReferenceMetadata(markdown, undefined, cached);
    await mkdir(dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, JSON.stringify(references, null, 2) + '\n');
    const unresolved = references.filter(reference => reference.status !== 'metadata-match');
    reports.push('# Reference Metadata Audit', `Status: ${references.length > 0 && !unresolved.length ? 'PASS' : 'BLOCKED'}`,
      'Metadata matching does not verify author identities, non-DOI sources or support for cited claims.',
      ...references.map(reference => `- [${reference.status}] ${reference.doi}: ${reference.reason}${reference.title ? ` Registered title: ${reference.title}` : ''}`));
    passed = passed && references.length > 0 && unresolved.length === 0;
    console.log(`[DSH reference metadata] ${references.length - unresolved.length}/${references.length} matched`);
  }

  if (docxPath) {
    const docxReport = await validateDocxFile(docxPath, sourceReport.metrics);
    reports.push(formatPaperQualityReport('DOCX Quality Gate', docxReport));
    passed = passed && docxReport.passed;
  }

  if (semantic) {
    const evidenceIndex = process.argv.indexOf('--evidence');
    if (evidenceIndex >= 0 && !process.argv[evidenceIndex + 1]) throw new Error('--evidence requires a file');
    const suppliedEvidence = evidenceIndex >= 0 ? await readFile(resolve(process.argv[evidenceIndex + 1]), 'utf8') : 'General scientific journal';
    const evidence = suppliedEvidence + await currentCitationEvidence(markdownPath, manuscriptHash);
    const tasks = process.argv.includes('--cross-review') ? ['quality', 'qualityCrossReview'] as const : ['quality'] as const;
    const cacheDir = join(dirname(markdownPath), '.dsh-state', 'scientific-review-responses');
    const completedRoutes = new Set<string>();
    for (const task of tasks) {
      console.log(`[DSH scientific review] ${task}; manuscript ${manuscriptHash}`);
      let actualTask = task;
      const review = await reviewWithAdjudication(asReviewSections(markdown), evidence, task, cacheDir,
        async (sections, constraints, requestedTask, directory) => {
          actualTask = requestedTask as typeof task;
          return reviewScientificQuality(sections, constraints, requestedTask, directory);
        });
      if (!review.success || !review.data) throw new Error(review.error || '独立科技审查没有返回结果');
      validateReviewEvidence(review.data, markdown, evidence);
      completedRoutes.add(actualTask);
      reports.push(`Requested review route: ${task}\nReview route: ${actualTask}\n`, formatScientificReview(review.data));
      const blocking = review.data.findings.some((finding) => finding.blockingStage !== 'submission' && ['critical', 'major'].includes(finding.severity));
      passed = passed && review.data.verdict === 'pass' && !blocking;
    }
    if (completedRoutes.size !== tasks.length) {
      reports.push('# Independent Review Coverage', 'Status: BLOCKED', 'The final valid verdicts did not cover both independent routes.');
      passed = false;
    }
  }

  if (createHash('sha256').update(await readFile(markdownPath)).digest('hex') !== manuscriptHash) {
    throw new Error('Manuscript changed during review; refusing a verdict for a different version');
  }
  const reportPath = markdownPath.replace(/\.md$/i, '.quality-report.md');
  await writeFile(reportPath, reports.join('\n'), 'utf-8');
  console.log(`质量报告: ${reportPath}`);
  console.log(passed ? 'PASS' : 'BLOCKED');
  if (!passed) process.exitCode = 2;
}

export function asReviewSections(markdown: string): Section[] {
  const matches = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)];
  if (matches.length === 0) return [createReviewSection('Full Manuscript', markdown, 0)];
  const sections = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return createReviewSection(match[1].trim(), markdown.slice(start, end).trim(), index);
  });
  const frontMatter = markdown.slice(0, matches[0].index).trim();
  if (frontMatter) sections.unshift(createReviewSection('Title and author information', frontMatter, -1));
  return sections;
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
