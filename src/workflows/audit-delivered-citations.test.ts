import assert from 'node:assert/strict';
import test from 'node:test';
import { bindDeliveredSources } from './audit-delivered-citations.js';
import type { Paper } from '../types.js';

test('DOI metadata without an excerpt cannot approve citation support', () => {
  const text = 'Claim (Li et al., 2025).\n## References\nLi, J. (2025). Test. https://doi.org/10.1000/test';
  const source = { id: '10.1000/test', title: 'Test', abstract: '' } as Paper;
  assert.equal(bindDeliveredSources(text, [source]).length, 0);
  const bound = bindDeliveredSources(text, [{ ...source, abstract: 'Actual source excerpt' }]);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].abstract, 'Actual source excerpt');
});

test('short surnames cannot match a different longer surname', () => {
  const text = 'Claim (Li et al., 2025).\n## References\nLi, J. (2025). Actual source title. https://doi.org/10.1000/li\n\nLilis, G. (2025). Other source. https://doi.org/10.1000/lilis';
  const source = { id: '10.1000/li', title: 'Actual source title', abstract: 'Actual excerpt' } as Paper;
  assert.equal(bindDeliveredSources(text, [source]).length, 1);
});
