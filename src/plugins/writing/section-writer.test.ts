import assert from 'node:assert/strict';
import test from 'node:test';
import type { Paper } from '../../types.js';
import { extractCitations, PARAGRAPH_REQUEST_PREFIX, SECTION_REQUEST_PREFIX } from './section-writer.js';

test('writing requests keep stable prefixes before dynamic paper content', () => {
  assert.match(SECTION_REQUEST_PREFIX, /动态任务字段：$/);
  assert.match(PARAGRAPH_REQUEST_PREFIX, /动态任务字段：$/);
  assert.ok(SECTION_REQUEST_PREFIX.indexOf('所有定量主张') < SECTION_REQUEST_PREFIX.indexOf('动态任务字段：'));
  assert.ok(PARAGRAPH_REQUEST_PREFIX.indexOf('所有定量主张') < PARAGRAPH_REQUEST_PREFIX.indexOf('动态任务字段：'));
});

test('numeric and author-year markers preserve source identity without approving evidence', () => {
  const papers = [{ id: 'source-1', citationLabel: '(Li et al., 2025)' }] as unknown as Paper[];
  const citations = extractCitations('Routing [1].\n\nPiping (Li et al., 2025).', papers);
  assert.deepEqual(citations.map((citation) => citation.paperId), ['source-1', 'source-1']);
  assert.ok(citations.every((citation) => !citation.verified));
  assert.equal(citations[1].rawText, 'Piping (Li et al., 2025).');
});

test('unknown author-year and numeric markers remain explicit missing references', () => {
  const citations = extractCitations('Unknown (Smith, 2024) and [9].', []);
  assert.ok(citations.every((citation) => citation.paperId.startsWith('missing-reference-')));
  assert.equal(citations.length, 2);
});
