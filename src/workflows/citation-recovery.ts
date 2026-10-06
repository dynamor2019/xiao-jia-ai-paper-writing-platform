import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModelClient } from '../lib/model-client.js';
import type { PipelineState } from '../types.js';
import type { VerificationResult } from '../plugins/verification/citation-verifier.js';
import { extractCitations } from '../plugins/writing/section-writer.js';
import { renderCanonicalMarkdown } from './canonical-draft.js';

/** Isolate attributed sentences without splitting decimal quantities or renumbering markers. */
export function citationClaimContext(citation: VerificationResult['citation']): string {
  const segments = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' })
    .segment(citation.rawText || ''), (entry) => entry.segment.trim());
  const claims = segments.flatMap((segment, index) => {
    if (!segment.includes(citation.marker)) return [];
    if (segment.startsWith(citation.marker) && index > 0) return [`${segments[index - 1]} ${segment}`];
    return [segment];
  });
  return claims.join(' ');
}

/** Preserve manuscript reference identities; batch position must never rename a source. */
async function verifyBoundBatch(state: PipelineState, citations: VerificationResult['citation'][], directory: string): Promise<VerificationResult[]> {
  const library = state.papers.map((paper, index) => ({ marker: `[${index + 1}]`, paperId: paper.id,
    title: paper.title, evidence: (state.notes.get(paper.id)?.keyFindings || paper.abstract || '').slice(0, 20000) }));
  const reviewable = citations.filter((citation) => state.papers.some((paper) => paper.id === citation.paperId));
  let rows: Array<Record<string, unknown>> = [];
  if (reviewable.length) {
    const response = await cachedReply(directory,
      'Verify citation attribution using ONLY the supplied evidence. Library marker and paperId are permanent manuscript identities, NOT batch positions. For each citation, identify assertions actually attributed to its marker in the paragraph; do not demand that one paper support assertions attributed to OTHER markers or project results. Unsupported assertions attributed to this marker must fail. Check existence, attribution and strength; use needs-review when evidence is insufficient. Return strict JSON {"results":[{"index":1,"status":"verified|not-found|mismatch|needs-review","reason":"brief evidence-specific reason"}]}. Cover each request index exactly once; do not rename sources.',
      `Permanent library:\n${JSON.stringify(library)}\nCitation requests (only the sentences actually carrying each marker):\n${JSON.stringify(reviewable.map((citation, index) => ({ index: index + 1, marker: citation.marker, paperId: citation.paperId, claim: citationClaimContext(citation) })))}`, 'citation');
    try {
      const parsed = objectReply(response).results;
      if (Array.isArray(parsed)) rows = parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.warn('[Citation assessment] Invalid or conflicting JSON retained in raw cache; no approval');
    }
  }
  return citations.map((citation) => {
    const paper = state.papers.find((item) => item.id === citation.paperId);
    if (!paper) return { citation, status: 'not-found', reason: 'Reference is absent from the supplied library' };
    const index = reviewable.indexOf(citation) + 1;
    const matches = rows.filter((row) => row.index === index);
    const row = matches.length === 1 ? matches[0] : undefined;
    const valid = row && ['verified', 'not-found', 'mismatch', 'needs-review'].includes(String(row.status))
      && typeof row.reason === 'string' && row.reason.trim();
    return { citation, paper, status: valid ? row.status as VerificationResult['status'] : 'needs-review',
      reason: valid ? row.reason as string : 'Missing or invalid assessment; no evidence approval' };
  });
}

/** Verify small bounded batches and reuse exact evidence-bound assessments on resume. */
export async function verifyDraftCitations(state: PipelineState, directory: string): Promise<VerificationResult[]> {
  refreshDraftCitations(state);
  mkdirSync(directory, { recursive: true });
  const results: VerificationResult[] = [];
  for (const section of state.sections) {
    for (let index = 0; index < section.citations.length; index += 2) {
      const citations = section.citations.slice(index, index + 2);
      const key = createHash('sha256').update(JSON.stringify({ version: 3, citations,
        papers: state.papers, notes: [...state.notes] })).digest('hex');
      const path = join(directory, `${key}.json`);
      if (existsSync(path)) {
        results.push(...JSON.parse(readFileSync(path, 'utf8')));
        continue;
      }
      const assessments = await verifyBoundBatch(state, citations, join(directory, 'raw'));
      writeFileSync(path, JSON.stringify(assessments, null, 2) + '\n', 'utf8');
      results.push(...assessments);
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
    task, temperature: 0, maxTokens: task === 'citation' ? 4096 : 2048,
    minOutputChars: task === 'citation' ? 32 : 64,
  });
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify({ key, response }, null, 2) + '\n', 'utf8');
  return response;
}

/** Parse complete JSON only, without reconstructing truncated replies or guessed content. */
function objectReply(raw: string): Record<string, unknown> {
  const blocks = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  if (blocks.length) {
    const parsed = blocks.map((block) => JSON.parse(block[1].trim()));
    if (parsed.some((value) => !value || typeof value !== 'object' || Array.isArray(value))) {
      throw new SyntaxError('Structured assessment must be a JSON object');
    }
    if (parsed.some((value) => JSON.stringify(value) !== JSON.stringify(parsed[0]))) {
      throw new SyntaxError('Conflicting structured assessments');
    }
    return parsed[0];
  }
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new SyntaxError('Citation recovery response is not complete JSON');
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
  let verdict: Record<string, unknown>;
  try { verdict = objectReply(raw); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { supported: false, reason: 'Independent assessment returned invalid or conflicting JSON; no approval. Return one unambiguous evidence-based assessment.' };
  }
  if (typeof verdict.supported !== 'boolean' || typeof verdict.reason !== 'string' || !verdict.reason.trim()) {
    return { supported: false, reason: 'Incomplete independent citation-recovery assessment; no approval' };
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
      let candidate: unknown;
      try { candidate = objectReply(response).content; } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        feedback = '\n\nPrevious response was invalid or conflicting JSON. Return exactly one complete JSON object with a content string.';
        continue;
      }
      if (typeof candidate !== 'string' || !candidate.trim()) {
        feedback = '\n\nPrevious response lacked a complete content string. Return one complete paragraph in a content string.';
        continue;
      }
      if (candidate.trim() === original) break;
      const citations = extractCitations(candidate, state.papers);
      if (citations.some((citation) => citation.paperId.startsWith('missing-reference-'))) {
        feedback = '\n\nPrevious revision used a reference absent from the provided library. Remove that unsupported source and its dependent assertions; only provided library markers are permitted.';
        continue;
      }
      const assessment = await supportedRevision(candidate, evidence, options.cacheDir);
      if (!assessment.supported) {
        feedback = `\n\nIndependent audit rejected the previous revision: ${assessment.reason}\nPrevious rejected revision:\n${candidate}\nEVIDENCE-ONLY REVISION: return at most 100 words. Keep only assertions explicitly stated in the supplied evidence, with correct library markers. Delete entire sentences containing unsupported claims, even when uncited. Do not preserve the original narrative length, novelty claims, claimed literature gaps, general industry practice, carbon savings, field validation or supposed baseline strategies. Do not repair unsupported claims by presenting them as established background. Prefer a short source-backed paragraph; do not invent connective factual claims.`;
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
