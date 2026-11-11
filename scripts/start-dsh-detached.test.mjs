import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { localHostReady, waitForDetachedHost } from './start-dsh-detached.mjs';

test('ready check accepts local authenticated hosts and rejects unavailable ports', async () => {
  const server = createServer((_req, res) => { res.writeHead(401); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  assert.equal(await localHostReady(port), true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await localHostReady(port), false);
});

test('startup waits for readiness and reports failure rather than false success', async () => {
  let checks = 0;
  assert.equal(await waitForDetachedHost({ check: async () => ++checks === 3,
    timeoutMs: 1000, intervalMs: 1 }), true);
  assert.equal(checks, 3);
  assert.equal(await waitForDetachedHost({ check: async () => false,
    timeoutMs: 10, intervalMs: 1 }), false);
});

test('a detached host survives its launcher exiting with independent stdout', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-detach-'));
  const entry = join(root, 'host.mjs'), pidFile = join(root, 'pid');
  writeFileSync(entry, `console.log('host-ready'); setInterval(() => {}, 1000);`);
  const moduleUrl = new URL('./start-dsh-detached.mjs', import.meta.url).href;
  const code = `import { spawnDetachedHost } from ${JSON.stringify(moduleUrl)};
    import { writeFileSync } from 'node:fs';
    const pid = await spawnDetachedHost({projectRoot:${JSON.stringify(root)},
      stateRoot:${JSON.stringify(root)},launchPath:${JSON.stringify(entry)}});
    writeFileSync(${JSON.stringify(pidFile)}, String(pid));`;
  let childPid;
  t.after(async () => {
    if (childPid) try { process.kill(childPid); } catch { /* Already stopped. */ }
    await delay(300);
    const withinTemp = relative(resolve(tmpdir()), resolve(root));
    assert.ok(withinTemp.startsWith('dsh-detach-') && !withinTemp.includes('..'));
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true });
  const [exit] = await once(parent, 'exit');
  assert.equal(exit, 0);
  childPid = Number(readFileSync(pidFile, 'utf8'));
  await delay(300);
  assert.doesNotThrow(() => process.kill(childPid, 0));
});
