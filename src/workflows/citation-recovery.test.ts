import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PipelineState } from '../types.js';
import { recoverDraftCitations, refreshDraftCitations, verifyDraftCitations } from './citation-recovery.js';
import { getModelClient } from '../lib/model-client.js';

test('refresh preserves paragraph context including decimal quantities', () => {
  const state = { sections: [{ content: 'A factor of 1.5 is not verified [1].', citations: [] }],
    papers: [{ id: 'source-1' }], notes: new Map() } as unknown as PipelineState;
  refreshDraftCitations(state);
  assert.equal(state.sections[0].citations[0].rawText, state.sections[0].content);
});

test('audit rejection guides one bounded revision and cached resume never repeats paid calls', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-feedback-'));
  try {
    const state = { sections: [{ content: 'Invented saving [1].', citations: [] }],
      papers: [{ id: 'source', title: 'Routing', abstract: 'Spatial routing only' }], notes: new Map() } as unknown as PipelineState;
    refreshDraftCitations(state);
    const failures = [{ citation: state.sections[0].citations[0], status: 'mismatch' as const, reason: 'No savings evidence' }];
    const replies = [JSON.stringify({ content: 'Still an invented saving [1].' }),
      JSON.stringify({ supported: false, reason: 'Saving remains invented' }),
      JSON.stringify({ content: 'The source concerns spatial routing [1].' }),
      JSON.stringify({ supported: true, reason: 'Explicit source support' })];
    const generate = context.mock.method(getModelClient(), 'generate', async (_system: string, prompt: string) => {
      if (replies.length === 2) assert.match(prompt, /Saving remains invented/);
      return replies.shift()!;
    });
    let saves = 0;
    const options = { evidence: 'Conditional experiment', cacheDir: directory };
    assert.equal(await recoverDraftCitations(state, failures, options, () => { saves++; }), 1);
    assert.equal(saves, 1);
    assert.equal(state.sections[0].content, 'The source concerns spatial routing [1].');
    state.sections[0].content = 'Invented saving [1].';
    assert.equal(await recoverDraftCitations(state, failures, options, () => {}), 1);
    assert.equal(generate.mock.callCount(), 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unbound references remain failures, including cached resume', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-recovery-'));
  try {
    const state = { sections: [{ content: 'Unsupported claim [1].', citations: [] }],
      papers: [], notes: new Map() } as unknown as PipelineState;
    const first = await verifyDraftCitations(state, directory);
    assert.equal(first[0].status, 'not-found');
    assert.deepEqual(await verifyDraftCitations(state, directory), JSON.parse(JSON.stringify(first)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repair may cite another supplied source but never saves invented references', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-library-'));
  try {
    const state = { sections: [{ content: 'Wrong attribution [1].', citations: [] }],
      papers: [{ id: 'one' }, { id: 'two' }], notes: new Map() } as unknown as PipelineState;
    refreshDraftCitations(state);
    const failures = [{ citation: state.sections[0].citations[0], status: 'mismatch' as const, reason: 'Wrong source' }];
    const replies = [JSON.stringify({ content: 'Invented source [99].' }),
      JSON.stringify({ content: 'Supported by the other source [2].' }),
      JSON.stringify({ supported: true, reason: 'Provided source two supports this' })];
    const generate = context.mock.method(getModelClient(), 'generate', async () => replies.shift()!);
    let saves = 0;
    assert.equal(await recoverDraftCitations(state, failures, { evidence: '', cacheDir: directory }, () => { saves++; }), 1);
    assert.equal(saves, 1);
    assert.equal(state.sections[0].citations[0].paperId, 'two');
    assert.equal(generate.mock.callCount(), 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('batch ordering cannot change manuscript source identities', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-identity-'));
  try {
    const state = { sections: [{ content: 'Chen describes routing [2]. Calixto describes CP [1].', citations: [] }],
      papers: [{ id: 'CP', title: 'Calixto', abstract: 'CP evidence' },
        { id: 'graph', title: 'Chen', abstract: 'Graph evidence' }], notes: new Map() } as unknown as PipelineState;
    context.mock.method(getModelClient(), 'generate', async (_system: string, prompt: string) => {
      assert.match(prompt, /"marker":"\[1\]","paperId":"CP"/);
      assert.match(prompt, /"marker":"\[2\]","paperId":"graph"/);
      return JSON.stringify({ results: [{ index: 1, status: 'verified', reason: 'Graph source supports Chen' },
        { index: 2, status: 'mismatch', reason: 'Claim not supported by CP source' }] });
    });
    const result = await verifyDraftCitations(state, directory);
    assert.equal(result[0].citation.paperId, 'graph');
    assert.equal(result[0].status, 'verified');
    assert.equal(result[1].citation.paperId, 'CP');
    assert.equal(result[1].status, 'mismatch');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
