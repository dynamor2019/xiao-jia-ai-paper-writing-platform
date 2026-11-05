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

test('grouped citations bind every source while preserving the literal claim marker', () => {
  const papers = [{ id: 'li', citationLabel: '(Li et al., 2025)' },
    { id: 'xu', citationLabel: '(Xu et al., 2025)' }] as unknown as Paper[];
  const citations = extractCitations('Routing (Li et al., 2025; Xu et al., 2025).', papers);
  assert.deepEqual(citations.map(item => item.paperId), ['li', 'xu']);
  assert.ok(citations.every(item => item.marker === '(Li et al., 2025; Xu et al., 2025)'));
});

test('an unknown member of a citation group is not silently discarded', () => {
  const papers = [{ id: 'li', citationLabel: '(Li et al., 2025)' }] as unknown as Paper[];
  const citations = extractCitations('Claim (Li et al., 2025; Unknown, 2024).', papers);
  assert.equal(citations.length, 2);
  assert.match(citations[1].paperId, /^missing-reference-/);
});

test('lowercase corporate names remain visible to the citation audit', () => {
  const citations = extractCitations('IFC (buildingSMART International, 2023).', []);
  assert.equal(citations.length, 1);
  assert.match(citations[0].paperId, /^missing-reference-/);
});

test('narrative citations retain their literal marker and permanent source identity', () => {
  const papers = [{ id: 'calixto', citationLabel: '(Calixto et al., 2026)' }] as unknown as Paper[];
  const citations = extractCitations('Calixto et al. (2026) describe CP solvers.', papers);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].marker, 'Calixto et al. (2026)');
  assert.equal(citations[0].paperId, 'calixto');
});

test('unknown narrative citations remain explicit failures instead of disappearing', () => {
  const citations = extractCitations('| Jorens et al. (2018) | Optimizes layout. |', []);
  assert.equal(citations.length, 1);
  assert.match(citations[0].paperId, /missing-reference-/);
});
