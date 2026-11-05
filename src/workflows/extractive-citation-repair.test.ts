import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedOriginalSentences } from './extractive-citation-repair.js';

test('extractive repair can only retain literal original sentences', () => {
  assert.equal(selectedOriginalSentences('Unsupported claim. Supported claim.', [1]), 'Supported claim.');
  assert.equal(selectedOriginalSentences('Unsupported claim.', []), '');
});

test('invented, duplicate or reordered indices cannot become a manuscript edit', () => {
  for (const keep of [[2], [0, 0], [1, 0], ['new prose'], [-1]]) {
    assert.throws(() => selectedOriginalSentences('First. Second.', keep), /Invalid/);
  }
});
