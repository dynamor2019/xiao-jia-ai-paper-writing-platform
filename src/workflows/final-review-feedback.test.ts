import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../config/dsh.config.js';
import { finalReviewFeedbackStarted, runFinalReviewFeedback } from './final-review-feedback.js';
import type { ScientificReview } from '../plugins/verification/scientific-quality-reviewer.js';

test('final findings receive one bounded repair and never become an automatic pass', async () => {
  const state = createInitialState('Test');
  const review: ScientificReview = { verdict: 'revise', findings: [{ severity: 'critical', category: 'consistency', section: 'Results', issue: 'Wrong number', requiredAction: 'Use evidence' }] };
  let revisions = 0;
  let interrupted = true;
  const services = {
    review: async () => ({ success: true, data: review }),
    revise: async () => {
      revisions++;
      if (interrupted) return { success: false, error: 'Interrupted' };
      return { success: true, data: { sections: state.sections, summary: 'Still unresolved' } };
    },
    save: () => {},
  };
  assert.equal((await runFinalReviewFeedback(state, services)).success, false);
  interrupted = false;
  assert.equal((await runFinalReviewFeedback(state, services)).data?.verdict, 'revise');
  await runFinalReviewFeedback(state, services);
  assert.equal(revisions, 2);
  await runFinalReviewFeedback(state, { ...services, contextHash: 'author-approved-new-scope' });
  assert.equal(revisions, 3);
  assert.equal(finalReviewFeedbackStarted(state, 'author-approved-new-scope'), true);
  assert.equal(finalReviewFeedbackStarted(state, 'different-scope'), false);
  await runFinalReviewFeedback(state, { ...services, contextHash: 'author-approved-new-scope' });
  assert.equal(revisions, 3);
});
