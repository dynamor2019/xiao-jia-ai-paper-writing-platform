import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReferenceMetadata } from './reference-metadata.js';

test('an existing DOI cannot verify an invented title or unrelated year', async () => {
  const markdown = '## References\nSmith (2024). Invented BIM study. https://doi.org/10.1234/real';
  const records = await auditReferenceMetadata(markdown, async () => ({
    title: ['Actual unrelated study'], published: { 'date-parts': [[2020]] },
  }));
  assert.equal(records[0].status, 'mismatch');
});

test('matching metadata is distinguished from scientific claim verification', async () => {
  const records = await auditReferenceMetadata('## References\nSmith (2024). Actual study. https://doi.org/10.1234/real.',
    async () => ({ title: ['Actual study'], published: { 'date-parts': [[2024]] } }));
  assert.equal(records[0].doi, '10.1234/real');
  assert.equal(records[0].status, 'metadata-match');
  assert.match(records[0].reason, /claim support remain separate/);
});

test('missing registrations and network errors never become verified metadata', async () => {
  const markdown = '## References\nSmith (2024). Study. https://doi.org/10.1234/missing';
  assert.equal((await auditReferenceMetadata(markdown, async () => undefined))[0].status, 'not-found');
  assert.equal((await auditReferenceMetadata(markdown, async () => { throw new Error('timeout'); }))[0].status, 'unavailable');
});
