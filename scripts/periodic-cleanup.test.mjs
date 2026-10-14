import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { schedulePeriodicCleanup, startPeriodicCleanup } from './periodic-cleanup.mjs';

test('periodic cleanup starts asynchronously, records success and respects its interval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-periodic-cleanup-'));
  const stateDir = join(root, '.dsh-state');
  await mkdir(stateDir, { recursive: true });
  const child = new EventEmitter();
  child.unref = () => {};
  const calls = [];
  try {
    const started = startPeriodicCleanup({
      dataRoot: root,
      stateDir,
      projectRoot: root,
      env: { DSH_AUTO_CLEANUP_DAYS: '1' },
      spawnProcess: (...args) => { calls.push(args); return child; },
      log: (message) => assert.fail(message),
    });
    assert.equal(started, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].detached, true);
    assert.equal(calls[0][2].windowsHide, true);
    assert.equal(calls[0][2].env.PAPER_DATA_ROOT, root);
    assert.ok((await readFile(join(stateDir, 'cleanup-running.json'), 'utf8')).includes('runId'));

    child.emit('close', 0);
    assert.ok(JSON.parse(await readFile(join(stateDir, 'last-cleanup.json'), 'utf8')).lastRunAt);
    assert.equal(await readFile(join(stateDir, 'cleanup-running.json'), 'utf8').catch(() => null), null);
    assert.equal(startPeriodicCleanup({
      dataRoot: root, stateDir, projectRoot: root, env: { DSH_AUTO_CLEANUP_DAYS: '1' },
      spawnProcess: () => assert.fail('cleanup should respect the successful-run interval'),
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('periodic cleanup does not spawn a second worker while its lease is fresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-periodic-cleanup-lock-'));
  const stateDir = join(root, '.dsh-state');
  await mkdir(stateDir, { recursive: true });
  const lockPath = join(stateDir, 'cleanup-running.json');
  try {
    await writeFile(lockPath, JSON.stringify({
      runId: 'live-cleanup', startedAt: new Date().toISOString(),
    }));
    assert.equal(startPeriodicCleanup({
      dataRoot: root, stateDir, projectRoot: root, env: {},
      spawnProcess: () => assert.fail('fresh cleanup lock must prevent another worker'),
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('periodic cleanup rechecks hourly without repeating a successful run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-periodic-cleanup-timer-'));
  const stateDir = join(root, '.dsh-state');
  await mkdir(stateDir, { recursive: true });
  const child = new EventEmitter();
  child.unref = () => {};
  let callback;
  let interval;
  let unreferenced = false;
  let spawns = 0;
  try {
    const options = {
      dataRoot: root, stateDir, projectRoot: root, env: {},
      spawnProcess: () => { spawns += 1; return child; },
    };
    const activeTimer = schedulePeriodicCleanup(options, (run, milliseconds) => {
      callback = run;
      interval = milliseconds;
      return { unref: () => { unreferenced = true; } };
    });
    assert.ok(activeTimer);
    assert.equal(spawns, 1);
    assert.equal(interval, 60 * 60 * 1000);
    assert.equal(unreferenced, true);
    child.emit('close', 0);
    callback();
    assert.equal(spawns, 1, 'hourly checks respect the successful-run timestamp');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
