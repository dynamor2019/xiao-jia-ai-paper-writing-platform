import assert from 'node:assert/strict';
import test from 'node:test';
import { getModelClient } from '../../lib/model-client.js';
import type { Section } from '../../types.js';
import { reviseSectionsFromReviews, type ScientificReview } from './scientific-quality-reviewer.js';
import { parseCanonicalSections } from '../../workflows/canonical-draft.js';

const REVIEWS: ScientificReview[] = [{ verdict: 'revise', findings: [{ category: 'presentation',
  severity: 'minor', section: 'I01', issue: 'Unclear scope', requiredAction: 'Clarify existing scope' }] }];

/** Create paragraphs without any external model or filesystem dependency. */
function manuscript(): Section[] {
  return ['I01', 'I02', 'M01'].map((id) => ({ id, nodeId: id, title: id,
    content: 'A supplied finite demonstration.', citations: [], wordCount: 5, status: 'completed' }));
}

test('targeted revisions change only planned paragraphs and require one-section outputs', async (context) => {
  let calls = 0;
  context.mock.method(getModelClient(), 'generate', async () => {
    calls++;
    return calls === 1 ? JSON.stringify({ summary: 'Clarify scope', ids: ['I01'] })
      : JSON.stringify({ summary: 'Clarified', sections: [{ id: 'I01', content: 'A declared finite demonstration.' }] });
  });
  const result = await reviseSectionsFromReviews(manuscript(), REVIEWS, 'Keep synthetic scope');
  assert.equal(result.success, true);
  assert.equal(calls, 2);
  assert.equal(result.data?.sections.length, 3);
  assert.equal(result.data?.sections[1].content, 'A supplied finite demonstration.');
});

test('truncated output resumes only the unsaved paragraph, retaining the saved plan', async (context) => {
  let calls = 0;
  let saved = manuscript();
  context.mock.method(getModelClient(), 'generate', async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ summary: 'Clarify', ids: ['I01', 'I02'] });
    if (calls === 3) return '{"summary":"Truncated';
    const id = calls === 2 ? 'I01' : 'I02';
    return JSON.stringify({ summary: 'Clarified', sections: [{ id, content: 'A declared finite demonstration.' }] });
  });
  const checkpoint = (sections: Section[]) => { saved = structuredClone(sections); };
  const failed = await reviseSectionsFromReviews(saved, REVIEWS, 'Scope', checkpoint);
  assert.equal(failed.success, false);
  assert.equal(saved[0].content, 'A declared finite demonstration.');
  assert.equal(saved[1].content, 'A supplied finite demonstration.');
  const resumed = await reviseSectionsFromReviews(saved, REVIEWS, 'Scope', checkpoint);
  assert.equal(resumed.success, true);
  assert.equal(calls, 4);
});

test('invalid plan ids are rejected before any prose request', async (context) => {
  const generate = context.mock.method(getModelClient(), 'generate', async () => JSON.stringify({ summary: 'Invalid', ids: ['UNKNOWN'] }));
  const result = await reviseSectionsFromReviews(manuscript(), REVIEWS, 'Scope');
  assert.equal(result.success, false);
  assert.equal(generate.mock.callCount(), 1);
});

test('reviews with no findings do not trigger paid revisions', async (context) => {
  const generate = context.mock.method(getModelClient(), 'generate', async () => '');
  const result = await reviseSectionsFromReviews(manuscript(), [{ verdict: 'pass', findings: [] }], 'Scope');
  assert.equal(result.success, true);
  assert.equal(generate.mock.callCount(), 0);
});

test('complete JSON inside prose wrappers is parsed while incomplete JSON remains rejected', async (context) => {
  let calls = 0;
  context.mock.method(getModelClient(), 'generate', async () => {
    calls++;
    const data = calls === 1 ? { summary: 'Clarify', ids: ['I01'] }
      : { summary: 'Clarified', sections: [{ id: 'I01', content: 'A finite declared demonstration.' }] };
    return `I have read the paragraph.\n${JSON.stringify(data)}\nEnd of response.`;
  });
  const result = await reviseSectionsFromReviews(manuscript(), REVIEWS, 'Scope');
  assert.equal(result.success, true);
  assert.equal(result.data?.sections[0].content, 'A finite declared demonstration.');
});

test('unsafe added citations retain source and remain unresolved without repeated paid requests', async (context) => {
  let calls = 0;
  let saved = parseCanonicalSections('## Introduction\n<!-- PARAGRAPH: I01 -->\nA declared demonstration [1].\n## References\n');
  const checkpoint = (sections: Section[]) => { saved = structuredClone(sections); };
  context.mock.method(getModelClient(), 'generate', async (_system: string, prompt: string) => {
    calls++;
    if (calls === 1) return JSON.stringify({ summary: 'Clarify', ids: ['I01'] });
    if (calls === 2) return JSON.stringify({ summary: 'Unsafe', sections: [{ id: 'I01', content: 'A demonstration [1] with added support [2].' }] });
    throw new Error('A cached unsafe candidate must not cause another paid request');
  });
  const first = await reviseSectionsFromReviews(saved, REVIEWS, 'Scope', checkpoint);
  assert.equal(first.success, true);
  assert.match(first.data!.summary, /UNRESOLVED.*I01/);
  assert.equal(saved[0].content, 'A declared demonstration [1].');
  saved[0].citations = [{ marker: '[1]', paperId: 'source-1', rawText: saved[0].content, verified: true }];
  const result = await reviseSectionsFromReviews(saved, REVIEWS, 'Scope', checkpoint);
  assert.equal(result.success, true);
  assert.equal(calls, 2);
  assert.match(result.data!.summary, /UNRESOLVED.*I01/);
  assert.deepEqual(result.data?.sections[0].citations.map(item => item.marker), ['[1]']);
});
