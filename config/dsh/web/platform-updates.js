import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'xiaojia-platform-updates';
export const inject = ['webServer', 'agents'];

/** Add authenticated same-origin update status without contributing model prompts. */
export async function apply(ctx) {
  const root = resolve(process.env.DSH_PAPER_PROJECT_DIR || '__DSH_PAPER_PROJECT_DIR__');
  const data = resolve(process.env.PAPER_DATA_ROOT || '__PAPER_DATA_ROOT__');
  const { PlatformUpdater } = await import(pathToFileURL(join(root, 'scripts/platform-updater.mjs')).href);
  const updater = new PlatformUpdater({ projectRoot: root,
    stateRoot: resolve(data, process.env.PAPER_STATE_DIR || '.dsh-state'),
    busy: () => ctx.agents.list().some(agent => agent.status !== 'idle') });
  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path, handler,
  }), `platform-update:${path}`);
  route('/dsh-platform-update/client.js', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(readFileSync(join(root, 'config/dsh/web/platform-updates-client.js')));
  });
  for (const action of ['status', 'check', 'download']) {
    route(`/dsh-platform-update/${action}`, async (req, res) => {
      try {
        const expected = action === 'status' ? 'GET' : 'POST';
        if (req.method !== expected) { res.writeHead(405); res.end(); return; }
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
          res.writeHead(403); res.end(); return;
        }
        const state = action === 'status' ? updater.snapshot()
          : action === 'check' ? await updater.check(true) : await updater.download();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(state));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ message: error.message }));
      }
    });
  }
  ctx.effect(() => updater.start(), 'platform-update:periodic-check');
}
