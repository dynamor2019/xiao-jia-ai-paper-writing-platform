import assert from 'node:assert/strict';
import test from 'node:test';
import { getModelClient } from '../../lib/model-client.js';
import type { Paper, Section } from '../../types.js';
import { verifyCitations } from './citation-verifier.js';

test('citation review receives supporting evidence and claims beyond legacy truncation limits', async (context) => {
  let prompt = '';
  context.mock.method(getModelClient(), 'generate', async (_system: string, input: string) => {
    prompt = input;
    return JSON.stringify({ results: [{ index: 1, status: 'verified', reason: 'Supported by provided passage' }] });
  });
  const paper: Paper = { id: 'source', title: 'Verified source', authors: [], year: 2026,
    abstract: 'Metadata. '.repeat(70) + 'PRIMARY_PASSAGE_SUPPORT', source: 'manual' };
  const section: Section = { id: 'paragraph', nodeId: 'paragraph', title: 'Introduction',
    content: '', wordCount: 0, status: 'completed', citations: [{ paperId: 'source', marker: '[1]',
      rawText: 'Background. '.repeat(90) + 'ACTUAL_CITED_CLAIM [1]', verified: false }] };
  const result = await verifyCitations([section], [paper], new Map());
  assert.equal(result.success, true);
  assert.equal(result.data?.[0].status, 'verified');
  assert.match(prompt, /PRIMARY_PASSAGE_SUPPORT/);
  assert.match(prompt, /ACTUAL_CITED_CLAIM/);
});

test('missing references remain blocked without calling the model', async (context) => {
  const generate = context.mock.method(getModelClient(), 'generate', async () => '');
  const section: Section = { id: 'paragraph', nodeId: 'paragraph', title: 'Introduction',
    content: 'Unsupported claim [1]', wordCount: 3, status: 'completed',
    citations: [{ paperId: 'missing', marker: '[1]', rawText: 'Unsupported claim [1]', verified: false }] };
  const result = await verifyCitations([section], [], new Map());
  assert.equal(result.data?.[0].status, 'not-found');
  assert.equal(generate.mock.callCount(), 0);
});
