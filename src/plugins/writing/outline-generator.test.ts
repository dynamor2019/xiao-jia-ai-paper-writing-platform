import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getModelClient } from '../../lib/model-client.js';
import { generateOutline } from './outline-generator.js';

test('invalid outline response is saved before parsing and reused without another model call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-outline-'));
  const client = getModelClient(), original = client.generate;
  let calls = 0;
  client.generate = async () => { calls++; return '{"topic":"source project","nodes":[{"id":"1"}'; };
  try {
    const responseFile = join(root, 'outline-response.json');
    const options = { responseFile };
    assert.equal((await generateOutline('source project', [], new Map(), options)).success, false);
    assert.match(readFileSync(responseFile, 'utf8'), /source project/);
    assert.equal((await generateOutline('source project', [], new Map(), options)).success, false);
    assert.equal(calls, 1);
  } finally { client.generate = original; rmSync(root, { recursive: true, force: true }); }
});

test('valid bounded outline can continue; duplicate node ids cannot start writing', async () => {
  const client = getModelClient(), original = client.generate;
  const node = { id: '1', level: 1, title: 'Methods', supportingPapers: [], estimatedWords: 300 };
  try {
    client.generate = async () => JSON.stringify({ topic: 'source project', nodes: [node], totalEstimatedWords: 300 });
    assert.equal((await generateOutline('source project', [], new Map())).success, true);
    client.generate = async () => JSON.stringify({ topic: 'source project', nodes: [node, node], totalEstimatedWords: 600 });
    assert.equal((await generateOutline('source project', [], new Map())).success, false);
  } finally { client.generate = original; }
});
