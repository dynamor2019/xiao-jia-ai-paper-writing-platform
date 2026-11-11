import './project-env.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { get } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PROJECT_ROOT, resolveDataRoot } from './project-paths.mjs';

/** Probe only the local host, independently of model/proxy configuration. */
export function localHostReady(port = 3080) {
  return new Promise(resolveReady => {
    const request = get({ hostname: '127.0.0.1', port, path: '/', timeout: 2000 }, response => {
      response.resume();
      resolveReady([200, 401, 403].includes(response.statusCode));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolveReady(false));
  });
}

/** Keep host stdio and lifetime separate from the launcher console. */
export async function spawnDetachedHost({ projectRoot, stateRoot, env = process.env,
  launchPath = join(projectRoot, 'scripts/launch-dsh.mjs') }) {
  mkdirSync(stateRoot, { recursive: true });
  const output = openSync(join(stateRoot, 'host-launch.stdout.log'), 'a');
  const errors = openSync(join(stateRoot, 'host-launch.stderr.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [launchPath], { cwd: projectRoot, env,
      detached: true, windowsHide: true, stdio: ['ignore', output, errors] });
    await once(child, 'spawn');
    child.unref();
    return child.pid;
  } finally {
    closeSync(output);
    closeSync(errors);
  }
}

/** Wait for usable local HTTP before reporting that startup succeeded. */
export async function waitForDetachedHost({ check = localHostReady, timeoutMs = 120000,
  intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return true;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const stateRoot = resolve(resolveDataRoot(), process.env.PAPER_STATE_DIR || '.dsh-state');
    await spawnDetachedHost({ projectRoot: PROJECT_ROOT, stateRoot });
    if (!await waitForDetachedHost()) throw new Error(`Startup timed out; see ${join(stateRoot, 'host-launch.stderr.log')}`);
    console.log('DSH is ready. Closing this launcher window will not stop the service.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
