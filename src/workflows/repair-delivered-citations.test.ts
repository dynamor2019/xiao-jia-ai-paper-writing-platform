import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDeliveredRevisions } from './repair-delivered-citations.js';
import type { Section } from '../types.js';

test('DSH revision changes only the approved span and preserves the rest verbatim', () => {
  const original = '# Title\n\n## Intro\nOld claim.\n\n## Results\n405 calculations.\n';
  const before = [{ id: 'intro', content: 'Old claim.' }] as Section[];
  const after = [{ id: 'intro', content: 'Supported claim.' }] as Section[];
  assert.equal(applyDeliveredRevisions(original, before, after), original.replace('Old claim.', 'Supported claim.'));
});

test('ambiguous replacements are rejected instead of altering the wrong paragraph', () => {
  const sections = [{ id: 'intro', content: 'Repeated.' }] as Section[];
  assert.throws(() => applyDeliveredRevisions('Repeated.\n\nRepeated.', sections,
    [{ id: 'intro', content: 'Changed.' }] as Section[]), /Ambiguous/);
});
