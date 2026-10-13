import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getModelClient } from '../../lib/model-client.js';
import type { Section } from '../../types.js';
import { assert_consistent_review, ReviewConsistencyError } from './review-consistency.js';
import { manuscriptReviewBlocked, reviewScientificQuality } from './scientific-quality-reviewer.js';

const FINDING = { severity: 'critical' as const, category: 'methods' as const, section: 'Methods',
  issue: 'The larger index contradicts the description.',
  requiredAction: 'The code and prose already match this behavior; remove the contradictory restatement.' };

test('acknowledged matching code and prose is invalid review evidence, not a scientific failure or pass', () => {
  assert.throws(() => assert_consistent_review([FINDING]), ReviewConsistencyError);
  assert.equal(FINDING.severity, 'critical');
});

test('a stated absence of numerical contradiction cannot be a major blocking defect', () => {
  assert.throws(() => assert_consistent_review([{ ...FINDING, severity: 'major',
    issue: 'No contradiction exists between 409.5 and 796.4.', requiredAction: 'Otherwise remove this finding.' }]),
  /REVIEW_SELF_CONTRADICTION/);
});

test('a false manuscript assertion quoted by the reviewer does not invalidate a real defect', () => {
  const finding = { ...FINDING, issue: 'The draft says "No contradiction exists", but its table conflicts with the same-source record.',
    requiredAction: 'Correct the conflicting table cell from the original record.' };
  assert.doesNotThrow(() => assert_consistent_review([finding]));
  assert.equal(manuscriptReviewBlocked({ verdict: 'revise', findings: [finding] }), true);
});

test('minor wording advice may acknowledge mathematical equivalence', () => {
  assert.doesNotThrow(() => assert_consistent_review([{ ...FINDING, severity: 'minor' }]));
});

test('valid scientific findings and unresolved submission requirements are left untouched', () => {
  const finding = { ...FINDING, issue: 'Observed values differ from the claimed source record.',
    requiredAction: 'Remove the unsupported measurement claim.' };
  const original = structuredClone(finding);
  assert.doesNotThrow(() => assert_consistent_review([finding]));
  assert.deepEqual(finding, original);
  assert.equal(manuscriptReviewBlocked({ verdict: 'pass', findings: [finding] }), true);
});

test('inconsistent cached reviews fail closed without another paid request or edited raw response', async context => {
  const folder = mkdtempSync(join(tmpdir(), 'review-consistency-'));
  try {
    const raw = JSON.stringify({ verdict: 'revise', findings: [FINDING] });
    const generate = context.mock.method(getModelClient(), 'generate', async () => raw);
    const sections: Section[] = [{ id: 'M', nodeId: 'M', title: 'Methods',
      content: 'Supplied conditional model.', citations: [], wordCount: 3, status: 'completed' }];
    for (let check = 0; check < 2; check++) {
      const result = await reviewScientificQuality(sections, 'Evidence', 'quality', folder);
      assert.equal(result.success, false);
      assert.equal(result.data, undefined);
      assert.match(result.error!, /REVIEW_SELF_CONTRADICTION/);
    }
    assert.equal(generate.mock.callCount(), 1);
    const files = readdirSync(folder);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(readFileSync(join(folder, files[0]), 'utf8')).response, raw);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
