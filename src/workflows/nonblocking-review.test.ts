import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../config/dsh.config.js';
import type { ScientificReview } from '../plugins/verification/scientific-quality-reviewer.js';
import { runQualityReviewRounds } from './quality-review-progress.js';
import { runFinalReviewFeedback } from './final-review-feedback.js';

const REVIEW: ScientificReview = { verdict: 'revise', findings: [
  { category: 'presentation', severity: 'minor', section: 'Results', blockingStage: 'manuscript',
    issue: 'Repeated phrasing', requiredAction: 'Consolidate wording' },
  { category: 'reproducibility', severity: 'major', section: 'Availability', blockingStage: 'submission',
    submissionRequirement: 'source-access', issue: 'Disclosed rights pending', requiredAction: 'Obtain author permission' },
] };

test('cross-review retains minor and submission items without paid rewriting', async () => {
  const state = createInitialState('Finite conditional case');
  let revisions = 0;
  const rounds = await runQualityReviewRounds(state, {
    review: async () => ({ success: true, data: REVIEW }),
    revise: async () => { revisions++; return { success: true, data: { sections: state.sections, summary: '' } }; },
    save: () => {},
  });
  assert.equal(revisions, 0);
  assert.equal(rounds[0].primary.findings.length, 2);
});

test('final feedback does not plan rewrites for minor or author-only requirements', async () => {
  const state = createInitialState('Finite conditional case');
  let revisions = 0;
  const result = await runFinalReviewFeedback(state, {
    review: async () => ({ success: true, data: REVIEW }),
    revise: async () => { revisions++; return { success: true, data: { sections: state.sections, summary: '' } }; },
    save: () => {},
  });
  assert.equal(revisions, 0);
  assert.deepEqual(result.data, REVIEW);
});
