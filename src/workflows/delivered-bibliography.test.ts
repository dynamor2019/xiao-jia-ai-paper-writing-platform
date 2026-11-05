import assert from 'node:assert/strict';
import test from 'node:test';
import type { Paper } from '../types.js';
import { pruneDeliveredBibliography } from './delivered-bibliography.js';

test('table citations keep real sources while uncited references are removed', () => {
  const markdown = '| Source | Claim |\n| Jorens et al. (2018) | Layout optimization. |\n\n## References\n\nJorens, S. (2018). Actual source.\n\nUnused, A. (2020). Uncited source.\n';
  const papers = [{ id: 'jorens', citationLabel: '(Jorens et al., 2018)' }] as unknown as Paper[];
  const result = pruneDeliveredBibliography(markdown, papers);
  assert.match(result, /Jorens, S\. \(2018\)/);
  assert.ok(!result.includes('Uncited source'));
  assert.equal(result.split('## References')[0], markdown.split('## References')[0]);
});

test('unknown citations block bibliography pruning instead of losing a reference', () => {
  assert.throws(() => pruneDeliveredBibliography('Claim (Unknown, 2025).\n\n## References\n\nUnknown, A. (2025). Source.', []), /unbound/);
});
