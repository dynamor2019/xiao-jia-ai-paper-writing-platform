import assert from 'node:assert/strict';
import test from 'node:test';
import type { Section } from '../types.js';
import { buildAuthorReviewSections } from './review-draft.js';

test('author review export retains evidence and never implies approval or mutates checkpoint sections', () => {
  const section = { id: '1', nodeId: '1', title: 'Results', content: '36 unknown cells; objective null.',
    citations: [], wordCount: 6, status: 'completed', canonicalSource: { template: 'Old approved title' } } as Section;
  const before = JSON.stringify(section);
  const framed = buildAuthorReviewSections([section], 'quality-validation');
  assert.match(framed[0].content, /NOT SCIENTIFICALLY APPROVED/);
  assert.match(framed[0].content, /does not advance the pipeline/);
  assert.equal(framed[1].content, section.content);
  assert.equal((framed[1] as Section & { canonicalSource?: unknown }).canonicalSource, undefined);
  assert.equal(JSON.stringify(section), before);
});

test('missing manuscript is not exported as an apparently completed document', () => {
  assert.throws(() => buildAuthorReviewSections([], 'quality-validation'), /nonempty saved manuscript/);
});

test('empty parent headings are retained when saved child prose exists', () => {
  const parent = { id: '3', nodeId: '3', title: 'Methods', content: '', citations: [], wordCount: 0, status: 'completed' } as Section;
  const child = { ...parent, id: '3.1', nodeId: '3.1', title: 'Model', content: 'Explicit assumptions.' };
  assert.equal(buildAuthorReviewSections([parent, child], 'quality-validation').length, 3);
});
