import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PipelineState } from '../types.js';
import { refreshDraftCitations, verifyDraftCitations } from './citation-recovery.js';

test('refresh preserves paragraph context including decimal quantities', () => {
  const state = { sections: [{ content: 'A factor of 1.5 is not verified [1].', citations: [] }],
    papers: [{ id: 'source-1' }], notes: new Map() } as unknown as PipelineState;
  refreshDraftCitations(state);
  assert.equal(state.sections[0].citations[0].rawText, state.sections[0].content);
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
