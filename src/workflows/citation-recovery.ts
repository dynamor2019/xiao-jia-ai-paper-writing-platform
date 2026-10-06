import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModelClient } from '../lib/model-client.js';
import type { PipelineState } from '../types.js';
import type { VerificationResult } from '../plugins/verification/citation-verifier.js';
import { extractCitations } from '../plugins/writing/section-writer.js';
import { renderCanonicalMarkdown } from './canonical-draft.js';
import { verifyCitations } from '../plugins/verification/citation-verifier.js';

/** Verify small bounded batches and reuse exact evidence-bound assessments on resume. */
export async function verifyDraftCitations(state: PipelineState, directory: string): Promise<VerificationResult[]> {
  refreshDraftCitations(state);
  mkdirSync(directory, { recursive: true });
  const results: VerificationResult[] = [];
  for (const section of state.sections) {
    for (let index = 0; index < section.citations.length; index += 2) {
      const citations = section.citations.slice(index, index + 2);
      const key = createHash('sha256').update(JSON.stringify({ version: 1, citations,
        papers: state.papers, notes: [...state.notes] })).digest('hex');
      const path = join(directory, `${key}.json`);
      if (existsSync(path)) {
        results.push(...JSON.parse(readFileSync(path, 'utf8')));
        continue;
      }
      const response = await verifyCitations([{ ...section, citations }], state.papers, state.notes);
      if (!response.success || !response.data) throw new Error(response.error || 'Citation verification failed');
      writeFileSync(path, JSON.stringify(response.data, null, 2) + '\n', 'utf8');
      results.push(...response.data);
    }
  }
  return results;
}

/** Cache every raw reply before parsing; failed replies must not trigger repeated paid attempts. */
async function cachedReply(directory: string, system: string, prompt: string, task: 'writing' | 'citation'): Promise<string> {
  const key = createHash('sha256').update(system + prompt).digest('hex');
  const path = join(directory, `${key}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')).response;
  const response = await getModelClient().generate(system, prompt, {
    task, temperature: 0, maxTokens: 2048, minOutputChars: task === 'citation' ? 32 : 64,
  });
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify({ key, response }, null, 2) + '\n', 'utf8');
  return response;
}

/** Parse complete JSON only, without reconstructing truncated replies or guessed content. */
function objectReply(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Citation recovery response is not complete JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

/** Rebind literal markers before each real verification pass, including previously saved drafts. */
export function refreshDraftCitations(state: PipelineState): void {
  if (renderCanonicalMarkdown(state.sections) !== undefined) return;
  for (const section of state.sections) section.citations = extractCitations(section.content, state.papers);
}

/** Require independent support for all revised assertions, not just sentences retaining citations. */
async function supportedRevision(candidate: string, evidence: string, directory: string): Promise<{ supported: boolean; reason: string }> {
  const raw = await cachedReply(directory,
    'Audit ALL factual/quantitative assertions in the candidate paragraph, including uncited claims. Use ONLY the provided source passages and validated experiment. Reject invented literature results, unprovided numbers, field claims, overstated baselines or uncertainty studies attributed to a spatial-routing paper. Claim deletion or cosmetic rephrasing is not evidence. Return strict JSON {"supported":true|false,"reason":"one brief evidence-based reason"}. Use false for unknown or unsupported assertions.',
    `Evidence:\n${evidence}\n\nCandidate paragraph:\n${candidate}`, 'citation');
  const verdict = objectReply(raw);
  if (typeof verdict.supported !== 'boolean' || typeof verdict.reason !== 'string' || !verdict.reason.trim()) {
    throw new Error('Incomplete independent citation-recovery assessment');
  }
  return { supported: verdict.supported, reason: verdict.reason };
}

/** Revise only failed draft paragraphs; keep unchanged paragraphs, experiments and canonical sources intact. */
export async function recoverDraftCitations(
  state: PipelineState,
  failures: VerificationResult[],
  options: { evidence: string; cacheDir: string },
  save: () => void,
): Promise<number> {
  if (renderCanonicalMarkdown(state.sections) !== undefined) return 0;
  const sources = state.papers.map((paper, index) => ({ marker: `[${index + 1}]`, paperId: paper.id,
    title: paper.title, evidence: state.notes.get(paper.id)?.keyFindings || paper.abstract }));
  const evidence = `Source evidence (scope limitations are binding):\n${JSON.stringify(sources)}\n\nValidated conditional experiment:\n${options.evidence}`;
  let repaired = 0;
  for (const section of state.sections) {
    const paragraphs = section.content.split(/\n\s*\n/);
    for (let index = 0; index < paragraphs.length; index++) {
      const original = paragraphs[index].trim();
      const findings = failures.filter((failure) => failure.citation.rawText?.trim() === original
        && !/JSON|漏掉|尚未返回/.test(failure.reason));
      if (!findings.length) continue;
      let feedback = '';
      for (let attempt = 0; attempt < 2; attempt++) {
      const response = await cachedReply(options.cacheDir,
        'Repair ONLY the specified paragraph against explicit failed-citation findings. Return strict JSON {"content":"complete revised paragraph"}. Keep the supported topic, method and evidence. Remove or narrow unsupported CLAIMS, not merely their citation markers. Delete fabricated literature percentages/intensities and wrong author attributions. Do not invent replacement sources, findings, savings, significance or experiments. You may remove unsupported numbers/citations; preserve valid project quantities, formulas and assumptions. Do not expand scope. Return a complete coherent paragraph, not editorial instructions.',
        `Evidence:\n${evidence}\n\nFailed findings:\n${JSON.stringify(findings.map((finding) => ({ marker: finding.citation.marker, reason: finding.reason })))}\n\nOriginal paragraph:\n${original}${feedback}`, 'writing');
      const candidate = objectReply(response).content;
      if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('Empty citation-recovery paragraph');
      if (candidate.trim() === original) break;
      const citations = extractCitations(candidate, state.papers);
      if (citations.some((citation) => citation.paperId.startsWith('missing-reference-'))) {
        feedback = '\n\nPrevious revision used a reference absent from the provided library. Remove that unsupported source and its dependent assertions; only provided library markers are permitted.';
        continue;
      }
      const assessment = await supportedRevision(candidate, evidence, options.cacheDir);
      if (!assessment.supported) {
        feedback = `\n\nIndependent audit rejected the previous revision: ${assessment.reason}\nPrevious rejected revision:\n${candidate}\nDelete the unsupported assertions identified by this audit; do not merely remove reference markers. A shorter supported paragraph is preferable to unsupported background claims.`;
        continue;
      }
      paragraphs[index] = candidate.trim();
      section.content = paragraphs.join('\n\n');
      section.citations = extractCitations(section.content, state.papers);
      section.wordCount = (section.content.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g) || []).length;
      save();
      repaired++;
      console.log(`[引用改稿] ${section.id} 第${index + 1}段已通过独立证据核对并保存`);
      break;
      }
    }
  }
  return repaired;
}
