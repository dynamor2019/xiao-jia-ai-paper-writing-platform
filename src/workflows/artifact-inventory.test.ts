import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { maintainPipelineArtifacts } from './artifact-inventory.js';

test('cleanup retains evidence and archives while pruning only expired pipeline-owned staging files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retention-'));
  try {
    const paths = ['experiments/results/raw.json', 'ARCHIVE_WORK_FILES/old.tmp', '.dsh-state/runtime/work/draft-markers.md', '.dsh-state/runtime/tmp/expired.tmp', '.dsh-state/runtime/tmp/fresh.tmp', 'unknown.tmp', '.dsh-state/manuscript.md.pipeline.tmp'];
    for (const file of paths) {
      const target = join(root, file);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'protected evidence');
    }
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(join(root, paths[3]), old, old);
    await utimes(join(root, paths[1]), old, old);
    await utimes(join(root, paths[6]), old, old);
    const outcome = await maintainPipelineArtifacts(root);
    assert.deepEqual(outcome.removed.sort(), [paths[3], paths[6]].sort());
    for (const file of paths.filter((_, index) => index !== 3 && index !== 6)) assert.ok((await stat(join(root, file))).isFile());
    const manifest = JSON.parse(await readFile(join(root, '.dsh-state/pipeline-artifacts.json'), 'utf8'));
    assert.equal(manifest.artifacts.find((item: { path: string }) => item.path === 'unknown.tmp').action, 'retain');
    assert.equal(manifest.artifacts.find((item: { path: string }) => item.path === paths[0]).role, 'evidence');
  } finally { await rm(root, { recursive: true, force: true }); }
});
