import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../config/dsh.config.js';
import type { ScientificReview } from '../plugins/verification/scientific-quality-reviewer.js';
import { runQualityReviewRounds } from './quality-review-progress.js';

const PASS: ScientificReview = { verdict: 'pass', findings: [] };

test('a stopped secondary review reuses the saved primary review and completes exactly two rounds', async () => {
  const state = createInitialState('Synthetic test');
  state.sections = [{ id: 'I01', nodeId: 'I01', title: 'Introduction', content: 'Finite scope.',
    citations: [], wordCount: 2, status: 'completed' }];
  const calls: string[] = [];
  let interrupted = true;
  let diskState = structuredClone(state);
  const services = {
    review: async (task: 'quality' | 'qualityCrossReview') => {
      calls.push(task);
      if (task === 'qualityCrossReview' && interrupted) return { success: false, error: 'Interrupted' };
      return { success: true, data: PASS };
    },
    revise: async () => ({ success: true, data: { sections: state.sections, summary: 'No changes requested' } }),
    save: () => { diskState = structuredClone(state); },
  };
  await assert.rejects(runQualityReviewRounds(state, services), /Interrupted/);
  Object.assign(state, diskState);
  interrupted = false;
  const rounds = await runQualityReviewRounds(state, services);
  assert.equal(rounds.length, 2);
  assert.deepEqual(calls, ['quality', 'qualityCrossReview', 'qualityCrossReview', 'quality', 'qualityCrossReview']);
  await runQualityReviewRounds(state, services);
  assert.equal(calls.length, 5);
  state.sections[0].content = 'Changed scope.';
  await runQualityReviewRounds(state, services);
  assert.equal(calls.length, 9);
});
