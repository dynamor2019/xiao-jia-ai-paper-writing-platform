import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { maintainPipelineArtifacts } from './artifact-inventory.js';

test('cleanup retains evidence, archives and unknown files while pruning only expired disposable temps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retention-'));
  try {
    const paths = ['experiments/results/raw.json', 'ARCHIVE_WORK_FILES/old.tmp', '.dsh-state/runtime/work/draft-markers.md', '.dsh-state/runtime/tmp/expired.tmp', '.dsh-state/runtime/tmp/fresh.tmp', 'unknown.tmp'];
    for (const file of paths) {
      const target = join(root, file);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'protected evidence');
    }
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(join(root, paths[3]), old, old);
    await utimes(join(root, paths[1]), old, old);
    const outcome = await maintainPipelineArtifacts(root);
    assert.deepEqual(outcome.removed, [paths[3]]);
    for (const file of paths.filter((_, index) => index !== 3)) assert.ok((await stat(join(root, file))).isFile());
    const manifest = JSON.parse(await readFile(join(root, '.dsh-state/pipeline-artifacts.json'), 'utf8'));
    assert.equal(manifest.artifacts.find((item: { path: string }) => item.path === 'unknown.tmp').action, 'retain');
    assert.equal(manifest.artifacts.find((item: { path: string }) => item.path === paths[0]).role, 'evidence');
  } finally { await rm(root, { recursive: true, force: true }); }
});
