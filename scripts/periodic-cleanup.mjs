import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_LOCK_AGE_MS = 2 * 60 * 60 * 1000;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function removeOwnedLock(path, runId) {
  if (readJson(path)?.runId === runId) rmSync(path, { force: true });
}

/** Start bounded daily cleanup without delaying the DSH web-server startup. */
export function startPeriodicCleanup({ dataRoot, stateDir, projectRoot, env, spawnProcess = spawn, log = console.warn }) {
  if (env.DSH_AUTO_CLEANUP === 'false') return false;
  const configuredDays = Number(env.DSH_AUTO_CLEANUP_DAYS || '1');
  const intervalDays = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 1;
  const stampPath = join(stateDir, 'last-cleanup.json');
  const lockPath = join(stateDir, 'cleanup-running.json');
  const stamp = readJson(stampPath);
  if (Date.now() - Date.parse(stamp?.lastRunAt) < intervalDays * 24 * 60 * 60 * 1000) return false;

  const priorLock = readJson(lockPath);
  if (priorLock && Date.now() - Date.parse(priorLock.startedAt) < MAX_LOCK_AGE_MS) return false;
  rmSync(lockPath, { force: true });

  const runId = randomUUID();
  try {
    writeFileSync(lockPath, JSON.stringify({ runId, startedAt: new Date().toISOString() }), { flag: 'wx' });
  } catch {
    return false;
  }

  let child;
  try {
    child = spawnProcess(process.execPath, ['scripts/cleanup-dsh-data.mjs', '--apply'], {
      cwd: projectRoot,
      env: { ...env, PAPER_DATA_ROOT: dataRoot, DSH_CLEANUP_RUN_ID: runId },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (error) {
    removeOwnedLock(lockPath, runId);
    log(`自动清理无法启动：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  child.once('error', (error) => {
    removeOwnedLock(lockPath, runId);
    log(`自动清理启动失败：${error.message}`);
  });
  child.once('close', (code) => {
    removeOwnedLock(lockPath, runId);
    if (code === 0) writeFileSync(stampPath, JSON.stringify({ lastRunAt: new Date().toISOString() }, null, 2), 'utf8');
    else log(`自动清理跳过：退出码 ${code ?? 'unknown'}`);
  });
  child.unref();
  return true;
}

/** Recheck the successful-cleanup interval while DSH remains online. */
export function schedulePeriodicCleanup(options, schedule = setInterval) {
  if (options.env.DSH_AUTO_CLEANUP === 'false') return undefined;
  startPeriodicCleanup(options);
  const timer = schedule(() => startPeriodicCleanup(options), 60 * 60 * 1000);
  timer.unref();
  return timer;
}
