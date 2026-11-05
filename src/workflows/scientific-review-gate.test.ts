import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getModelClient } from '../lib/model-client.js';
import type { Section } from '../types.js';
import { manuscriptReviewBlocked, manuscriptRevisionReview, type ScientificReview } from '../plugins/verification/scientific-quality-reviewer.js';
import { validateReviewEvidence } from '../plugins/verification/review-evidence.js';
import { reviewWithAdjudication } from './scientific-review-gate.js';

const MANUSCRIPT = 'We measured all 405 outcomes in the field.';
const EVIDENCE = 'All 405 outcomes are conditional model calculations.';
const SECTIONS: Section[] = [{ id: 'R1', nodeId: '1', title: 'Results', content: MANUSCRIPT,
  citations: [], wordCount: 9, status: 'completed' }];
const PASS: ScientificReview = { verdict: 'pass', findings: [] };
const DEFECT: ScientificReview = { verdict: 'revise', findings: [{ category: 'experiments',
  severity: 'critical', section: 'Results', blockingStage: 'manuscript',
  issue: 'Model calculations are falsely presented as field measurements.', requiredAction: 'Remove the field measurement claim.',
  claimQuote: MANUSCRIPT, evidenceSource: 'validated-evidence', evidenceQuote: EVIDENCE }] };
const MINOR: ScientificReview = { verdict: 'revise', findings: [{ category: 'presentation',
  severity: 'minor', section: 'Results', blockingStage: 'manuscript',
  issue: 'Repeated phrasing.', requiredAction: 'Consolidate wording.' }] };
const SUBMISSION: ScientificReview = { verdict: 'revise', findings: [{ category: 'reproducibility',
  severity: 'major', section: 'Availability', blockingStage: 'submission', submissionRequirement: 'source-access',
  issue: 'Disclosed source release permissions remain unresolved.', requiredAction: 'Resolve rights before submission.' }] };

test('minor opinions and disclosed submission requirements do not block the manuscript or trigger rewriting', () => {
  for (const review of [MINOR, SUBMISSION]) {
    validateReviewEvidence(review, MANUSCRIPT, EVIDENCE);
    assert.equal(manuscriptReviewBlocked(review), false);
    assert.equal(manuscriptRevisionReview(review).findings.length, 0);
    assert.equal(review.verdict, 'revise');
  }
});

test('a traceable false measurement claim remains blocking even if verdict says pass', () => {
  validateReviewEvidence(DEFECT, MANUSCRIPT, EVIDENCE);
  assert.equal(manuscriptReviewBlocked(DEFECT), true);
  assert.equal(manuscriptReviewBlocked({ ...DEFECT, verdict: 'pass' }), true);
});

test('a reviewer cannot accuse a manual 48 of 50 result while quoting a disclosed limitation', () => {
  const statement = 'Physical accuracy has not been established by a traceable inspection record.';
  const review: ScientificReview = { verdict: 'revise', findings: [{ ...DEFECT.findings[0],
    issue: 'Manuscript asserts manual inspection validated 48 of 50 edges but no sample is supplied.',
    claimQuote: statement }] };
  assert.throws(() => validateReviewEvidence(review, statement, EVIDENCE), /numerical accusation/);
});

test('a known access-restriction schema alias stays unresolved without changing a scientific verdict', async context => {
  const response = { verdict: 'pass', findings: [{ ...SUBMISSION.findings[0], severity: 'minor',
    submissionRequirement: 'public-repository|restricted-access-disclosure' }] };
  context.mock.method(getModelClient(), 'generate', async () => JSON.stringify(response));
  const { reviewScientificQuality } = await import('../plugins/verification/scientific-quality-reviewer.js');
  const result = await reviewScientificQuality(SECTIONS, EVIDENCE);
  assert.equal(result.success, true);
  assert.equal(result.data?.findings[0].submissionRequirement, 'source-access');
  assert.equal(result.data?.findings[0].blockingStage, 'submission');
  assert.equal(result.data?.verdict, 'pass');
  assert.equal(response.findings[0].submissionRequirement, 'public-repository|restricted-access-disclosure');
  validateReviewEvidence(result.data!, MANUSCRIPT, EVIDENCE);
});

test('serious findings require literal claim and evidence anchors, not merely filled text fields', () => {
  for (const patch of [{ claimQuote: undefined }, { claimQuote: 'Nonexistent claim' },
    { evidenceQuote: 'Invented record' }, { evidenceSource: undefined }, { blockingStage: undefined }]) {
    const review = { ...DEFECT, findings: [{ ...DEFECT.findings[0], ...patch }] } as ScientificReview;
    assert.throws(() => validateReviewEvidence(review, MANUSCRIPT, EVIDENCE), /REVIEW_EVIDENCE_INVALID/);
  }
});

test('critical scientific defects cannot be reclassified as submission requirements', () => {
  const review = { ...DEFECT, findings: [{ ...DEFECT.findings[0], blockingStage: 'submission' as const }] };
  assert.throws(() => validateReviewEvidence(review, MANUSCRIPT, EVIDENCE), /submission-only/);
});

test('a concrete absent-evidence obligation is distinguished from a fabricated source quotation', () => {
  const finding = { ...DEFECT.findings[0], evidenceSource: 'missing' as const, evidenceQuote: '',
    requiredEvidence: 'Field records supporting the affirmative measurement claim.' };
  validateReviewEvidence({ ...DEFECT, findings: [finding] }, MANUSCRIPT, EVIDENCE);
  assert.throws(() => validateReviewEvidence({ ...DEFECT, findings: [{ ...finding, requiredEvidence: '' }] }, MANUSCRIPT, EVIDENCE));
});

test('unexplained revise with no findings remains an invalid response, not automatic approval', () => {
  assert.throws(() => validateReviewEvidence({ verdict: 'revise', findings: [] }, MANUSCRIPT, EVIDENCE));
});

test('no secondary request is made for a valid clear manuscript review', async () => {
  let calls = 0;
  const result = await reviewWithAdjudication(SECTIONS, EVIDENCE, 'quality', undefined,
    async () => { calls++; return { success: true, data: MINOR }; });
  assert.equal(result.success, true);
  assert.equal(calls, 1);
  assert.equal(result.data, MINOR);
});

test('an ungrounded review receives exactly one bounded independent adjudication', async () => {
  const tasks: string[] = [];
  const invalid = { ...DEFECT, findings: [{ ...DEFECT.findings[0], claimQuote: 'Invented assertion' }] };
  const result = await reviewWithAdjudication(SECTIONS, EVIDENCE, 'quality', undefined,
    async (_sections, evidence, task) => {
      tasks.push(task!);
      if (tasks.length === 2) assert.match(evidence, /not a vote or an automatic pass/);
      return { success: true, data: tasks.length === 1 ? invalid : PASS };
    });
  assert.deepEqual(tasks, ['quality', 'qualityCrossReview']);
  assert.deepEqual(result.data, PASS);
});

test('a corroborated actual scientific defect stays blocked after adjudication', async () => {
  let calls = 0;
  const result = await reviewWithAdjudication(SECTIONS, EVIDENCE, 'quality', undefined,
    async () => { calls++; return { success: true, data: DEFECT }; });
  assert.equal(calls, 2);
  assert.equal(manuscriptReviewBlocked(result.data!), true);
});

test('a second invalid opinion stops without a third review or invented pass', async () => {
  let calls = 0;
  const result = await reviewWithAdjudication(SECTIONS, EVIDENCE, 'quality', undefined,
    async () => { calls++; return { success: false, failureKind: 'review-response', error: 'Malformed review' }; });
  assert.equal(calls, 2);
  assert.equal(result.success, false);
});

test('timeouts, balance failures and other transport errors do not initiate adjudication', async () => {
  for (const error of ['TIMEOUT', 'Insufficient balance', 'TRANSPORT']) {
    let calls = 0;
    const result = await reviewWithAdjudication(SECTIONS, EVIDENCE, 'quality', undefined,
      async () => { calls++; return { success: false, failureKind: 'request', error }; });
    assert.equal(calls, 1);
    assert.equal(result.error, error);
  }
});

test('invalid raw reviews and adjudication are cached without deleting history or repeated paid calls', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'review-adjudication-'));
  try {
    const raw = '{"verdict":"revise","findings":[';
    const generate = context.mock.method(getModelClient(), 'generate', async (_system: string, prompt: string) =>
      prompt.includes('BOUNDED REVIEW ADJUDICATION') ? JSON.stringify(PASS) : raw);
    assert.equal((await reviewWithAdjudication(SECTIONS, EVIDENCE, 'quality', directory)).success, true);
    assert.equal((await reviewWithAdjudication(SECTIONS, EVIDENCE, 'quality', directory)).success, true);
    assert.equal(generate.mock.callCount(), 2);
    const files = readdirSync(directory).map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')));
    assert.ok(files.some(file => file.response === raw));
    assert.ok(files.some(file => file.primary && file.submissionApproved === false));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('review output schema requires real quotes and distinguishes editorial suggestions', async context => {
  context.mock.method(getModelClient(), 'generate', async (system: string) => {
    assert.match(system, /"claimQuote"/);
    assert.match(system, /"evidenceQuote"/);
    assert.match(system, /never insert ellipses, paraphrases, bracketed descriptions/);
    assert.match(system, /Classify them as minor unless a separate demonstrated error/);
    return JSON.stringify(PASS);
  });
  assert.equal((await reviewWithAdjudication(SECTIONS, EVIDENCE)).success, true);
});
