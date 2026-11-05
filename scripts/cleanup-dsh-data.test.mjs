import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

test('cleanup removes only expired transient and pipeline staging files', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-cleanup-'));
  const external = await mkdtemp(join(tmpdir(), 'dsh-cleanup-external-'));
  try {
    const oldFiles = [
      '.dsh-state/expired.log',
      'output/papers/paper-a/.dsh-state/manuscript.md.pipeline.tmp',
      'output/papers/paper-a/final/manuscript-final.md',
      'output/papers/paper-a/milestones/old-review.json',
      'output/papers/paper-a/.dsh-state/citation-recovery/response.json',
      'output/papers/paper-a/ARCHIVE_WORK_FILES/manuscript.before-archived.bak',
      'output/papers/paper-a/.dsh-state/unmanaged.bak',
      '.dsh-state/npm-cache/old-log.log',
      '.dsh-state/tmp/tsx-test/old-cache',
      '.dsh-state/tmp/node-compile-cache/old-cache',
      '.dsh-state/tmp/session-latest.jsonl',
      '.dsh-state/tmp/cv_debug.log',
      '.dsh-state/tmp/unclassified/old-file',
      '.dsh-state/tmp/dsh-workspace-changes-history/captures/unique-before-edit',
      '.dsh-state/tmp/dsh-spill-history/session/tool-result.txt',
    ];
    for (const file of oldFiles) {
      const path = join(dataRoot, file);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'keep unless explicitly disposable');
    }
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await Promise.all(oldFiles.map((file) => utimes(join(dataRoot, file), old, old)));
    const backups = [];
    for (let index = 0; index < 5; index++) {
      const relativePath = `output/papers/paper-a/.dsh-state/manuscript.md.before-run-${index}.bak`;
      const path = join(dataRoot, relativePath);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'recoverable version');
      const modified = new Date(Date.now() - (100 - index * 20) * 24 * 60 * 60 * 1000);
      await utimes(path, modified, modified);
      backups.push(relativePath);
    }
    const externalLog = join(external, 'external.log');
    const uniqueBackup = join(dataRoot, 'output/papers/paper-a/.dsh-state/manuscript.md.before-unique.bak');
    await writeFile(uniqueBackup, 'unique historical evidence, never discard by age');
    const historical = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await utimes(uniqueBackup, historical, historical);
    await writeFile(externalLog, 'outside data root');
    await symlink(externalLog, join(dataRoot, '.dsh-state', 'linked.log'));

    const result = spawnSync(process.execPath, ['scripts/cleanup-dsh-data.mjs', '--apply'], {
      cwd: process.cwd(), env: { ...process.env, PAPER_DATA_ROOT: dataRoot }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await stat(join(dataRoot, oldFiles[0])).catch(() => null)), null);
    assert.equal((await stat(join(dataRoot, oldFiles[1])).catch(() => null)), null);
    assert.equal((await stat(join(dataRoot, backups[0])).catch(() => null)), null);
    assert.equal((await stat(join(dataRoot, backups[1])).catch(() => null)), null);
    assert.ok(JSON.parse(await readFile(join(dataRoot, '.dsh-state', 'last-cleanup.json'), 'utf8')).lastRunAt);
    for (const file of [...oldFiles.slice(2, 8), ...oldFiles.slice(10), ...backups.slice(2)]) assert.ok((await stat(join(dataRoot, file))).isFile(), file);
    for (const file of oldFiles.slice(8, 10)) assert.equal(await stat(join(dataRoot, file)).catch(() => null), null, file);
    assert.ok((await stat(join(dataRoot, oldFiles[7])).catch(() => null))?.isFile(), 'npm cache is not traversed by the default cleanup');
    assert.equal((await readFile(externalLog, 'utf8')), 'outside data root');
    assert.equal(await readFile(uniqueBackup, 'utf8'), 'unique historical evidence, never discard by age');

    const npxServer = join(dataRoot, '.dsh-state/npm-cache/_npx/server/node_modules/server.js');
    await mkdir(dirname(npxServer), { recursive: true });
    await writeFile(npxServer, 'active MCP runtime, not a download cache');
    await utimes(npxServer, old, old);
    const cacheCleanup = spawnSync(process.execPath, ['scripts/cleanup-dsh-data.mjs', '--apply', '--npm-cache-days=30'], {
      cwd: process.cwd(), env: { ...process.env, PAPER_DATA_ROOT: dataRoot }, encoding: 'utf8',
    });
    assert.equal(cacheCleanup.status, 0, cacheCleanup.stderr);
    assert.equal(await stat(join(dataRoot, oldFiles[7])).catch(() => null), null);
    assert.ok((await stat(npxServer)).isFile(), 'even expired npx runtimes must be retained');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('default cleanup deduplicates exact archive copies and retains one byte-identical result', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-cleanup-dedupe-'));
  try {
    const content = Buffer.alloc(1024 * 1024, 7);
    const canonical = 'output/papers/paper-a/ARCHIVE_WORK_FILES/experiments/results/run-a/result.json';
    const duplicate = 'output/papers/paper-a/ARCHIVE_WORK_FILES/experiments/results/run-b/result.json';
    const different = 'output/papers/paper-a/ARCHIVE_WORK_FILES/experiments/results/run-c/result.json';
    const archiveCopy = 'output/papers/paper-a/ARCHIVE_WORK_FILES/delivery/archive-a/support.zip';
    const duplicateArchiveCopy = 'output/papers/paper-a/ARCHIVE_WORK_FILES/delivery/archive-b/support.zip';
    for (const [file, bytes] of [
      [canonical, content], [duplicate, content], [different, Buffer.alloc(content.length, 8)],
      [archiveCopy, content], [duplicateArchiveCopy, content],
    ]) {
      const path = join(dataRoot, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }

    const preview = spawnSync(process.execPath, ['scripts/cleanup-dsh-data.mjs'], {
      cwd: process.cwd(), env: { ...process.env, PAPER_DATA_ROOT: dataRoot }, encoding: 'utf8',
    });
    assert.equal(preview.status, 0, preview.stderr);
    assert.ok((await stat(join(dataRoot, duplicate))).isFile(), 'dry-run never deletes data');

    const reports = await readdir(join(dataRoot, '.dsh-state', 'cleanup-reports'));
    const report = JSON.parse(await readFile(join(dataRoot, '.dsh-state', 'cleanup-reports', reports[0]), 'utf8'));
    assert.equal(report.candidateItems, 2);
    const resultAction = report.actions.find((action) => action.path === duplicate);
    const archiveAction = report.actions.find((action) => action.path === duplicateArchiveCopy);
    assert.equal(resultAction.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(resultAction.retainedPath, canonical);
    assert.equal(archiveAction.retainedPath, archiveCopy);

    const applied = spawnSync(process.execPath, ['scripts/cleanup-dsh-data.mjs', '--apply'], {
      cwd: process.cwd(), env: { ...process.env, PAPER_DATA_ROOT: dataRoot }, encoding: 'utf8',
    });
    assert.equal(applied.status, 0, applied.stderr);
    assert.ok((await stat(join(dataRoot, canonical))).isFile());
    assert.equal(await stat(join(dataRoot, duplicate)).catch(() => null), null);
    assert.ok((await stat(join(dataRoot, different))).isFile());
    assert.ok((await stat(join(dataRoot, archiveCopy))).isFile());
    assert.equal(await stat(join(dataRoot, duplicateArchiveCopy)).catch(() => null), null);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
