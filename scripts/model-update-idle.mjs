import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Refuse live dependency replacement while the DSH supervisor owns its runtime. */
export function assertModelHostStopped(projectRoot, env = process.env) {
  const states = new Set([join(resolve(projectRoot), '.dsh-state')]);
  if (env.PAPER_DATA_ROOT) states.add(resolve(env.PAPER_DATA_ROOT, env.PAPER_STATE_DIR || '.dsh-state'));
  for (const state of states) {
    const path = join(state, 'web-supervisor.lock.json');
    if (!existsSync(path)) continue;
    let lock;
    try { lock = JSON.parse(readFileSync(path, 'utf8')); } catch {
      throw new Error('Cannot verify DSH supervisor state; refusing live dependency replacement');
    }
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) {
      throw new Error('Invalid DSH supervisor PID; refusing live dependency replacement');
    }
    try { process.kill(lock.pid, 0); } catch (error) {
      if (error.code === 'ESRCH') continue;
      throw new Error('Cannot verify DSH supervisor process; refusing live dependency replacement');
    }
    throw new Error('DSH is running; close the host before installing updates. --check-only remains available');
  }
}
