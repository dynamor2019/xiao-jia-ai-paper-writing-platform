import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { registerReviewerFeature } from './reviewer-response-web.mjs';
import { approvedFixture, fixture } from './reviewer-response-test-fixture.mjs';
import { readReview } from './reviewer-response-store.mjs';
import { patchResearchWorkbench } from './patch-dsh-journal-ui.mjs';

/** Real HTTP boundary with the production handlers; no model or browser impersonation. */
async function serverFixture(t, root) {
  const routes = new Map(), tools = new Map();
  registerReviewerFeature({ effect: effect => effect(), webServer: { register: route => routes.set(route.path, route.handler) },
    tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { context: () => {} } },
  { resolveProject: id => id === 'session-test' ? root : undefined, stateRoot: join(root, '.state') });
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (handler) Promise.resolve(handler(req, res)).catch(e => { res.writeHead(500); res.end(e.message); });
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/dsh-paper-reviews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-test', ...body }) });
  return { base, post, tools, routes };
}

test('HTTP import/edit/author-confirm/export/download uses actual evidence and rejects stale packages', async t => {
  const { root, state } = approvedFixture(t), f = await serverFixture(t, root);
  let response = await f.post({ revision: state.revision, action: 'export' });
  assert.equal(response.status, 200); assert.equal((await response.json()).exported.length, 3);
  response = await fetch(`${f.base}/dsh-paper-reviews/download?sessionId=session-test&file=response-to-reviewers.md`);
  assert.equal(response.status, 200); assert.match(await response.text(), /27 evaluated candidates/);
  response = await f.post({ action: 'edit', revision: state.revision, id: 'R1.1', patch: { response: 'New response' } });
  assert.equal(response.status, 200);
  response = await fetch(`${f.base}/dsh-paper-reviews/download?sessionId=session-test&file=response-to-reviewers.md`);
  assert.equal(response.status, 400);
});

test('cross-site changes, arbitrary downloads, missing session and oversized bodies are rejected', async t => {
  const root = fixture(t), f = await serverFixture(t, root);
  let response = await fetch(`${f.base}/dsh-paper-reviews`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.equal((await fetch(`${f.base}/dsh-paper-reviews?sessionId=../../secret`)).status, 400);
  assert.equal((await fetch(`${f.base}/dsh-paper-reviews?sessionId=session-unknown`)).status, 409);
  response = await f.post({ revision: 0, action: 'import', source: 'x'.repeat(270000), reviewer: 'R1' });
  assert.equal(response.status, 413);
  assert.equal((await fetch(`${f.base}/dsh-paper-reviews/download?sessionId=session-test&file=results.json`)).status, 400);
});

test('native DSH tool exposes status/edit without any author-approval operation or direct model call', async t => {
  const { root, state } = approvedFixture(t), f = await serverFixture(t, root);
  const tool = f.tools.get('manage_reviewer_response');
  const value = await tool.execute({ action: 'status' }, { agent: { id: 'session-test' } });
  assert.equal(JSON.parse(value).revision, state.revision);
  assert.equal(JSON.parse(value).state, undefined);
  await tool.execute({ action: 'edit', revision: state.revision, id: 'R1.1', patch: { response: 'DSH drafted text.' } }, { agent: { id: 'session-test' } });
  assert.equal(readReview(root).comments[0].response, 'DSH drafted text.');
  assert.equal(readReview(root).comments[0].approval, undefined);
});

test('real workbench patch contains session-scoped iframe and source-checked native draft handoff', () => {
  const bundle = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url), 'utf8');
  const patched = patchResearchWorkbench(bundle, bundle.includes('\r\n') ? '\r\n' : '\n');
  assert.match(patched, /dsh-paper-reviews\/ui\?sessionId=/);
  assert.match(patched, /event\.source !== frame\?\.contentWindow/);
  assert.match(patched, /inputActions\.setDraft\(event\.data\.task\)/);
  if (bundle.includes('function JournalSelect(')) assert.match(patched, /function JournalSelect\(/);
  assert.equal(patchResearchWorkbench(patched, patched.includes('\r\n') ? '\r\n' : '\n'), patched);
});

test('updating the workbench preserves the adjacent live journal component and its IF/JCR controls', () => {
  const bundle = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url), 'utf8');
  const anchor = '\t\t//#region lib/types/client/skeleton/InputBar.js';
  const journal = '\t\tconst JOURNAL_OPTIONS = [{ name: "Journal", impactFactor: "11.5", jcr: "Q1" }];\n\t\tfunction JournalSelect() { return JOURNAL_OPTIONS; }\n';
  const withJournal = bundle.includes('function JournalSelect(') ? bundle : bundle.replace(anchor, journal + anchor);
  const patched = patchResearchWorkbench(withJournal, withJournal.includes('\r\n') ? '\r\n' : '\n');
  assert.match(patched, /function JournalSelect\(/); assert.match(patched, /JOURNAL_OPTIONS/);
  assert.equal((patched.match(/function ResearchWorkbench\(/g) || []).length, 1);
});

test('UI assets use text nodes for imported opinions and forbid remote scripts and form submissions', async t => {
  const f = await serverFixture(t, fixture(t));
  const html = await fetch(`${f.base}/dsh-paper-reviews/ui?sessionId=session-test`);
  assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(html.headers.get('content-security-policy'), /form-action 'none'/);
  const js = await (await fetch(`${f.base}/dsh-paper-reviews/client.js`)).text();
  assert.doesNotMatch(js, /innerHTML\s*=/);
  assert.match(js, /textContent/);
});

test('agent reads are paginated and exclude duplicated source, portal data and historic rounds', async t => {
  const { root, state } = approvedFixture(t), f = await serverFixture(t, root);
  const { changeReview } = await import('./reviewer-response-store.mjs');
  changeReview(root, { action: 'import', revision: state.revision, reviewer: 'R2', source: 'Second issue\n\nThird issue' });
  const tool = f.tools.get('manage_reviewer_response');
  const first = JSON.parse(await tool.execute({ action: 'status', limit: 1 }, { agent: { id: 'session-test' } }));
  assert.equal(first.total, 3); assert.equal(first.comments.length, 1); assert.equal(first.nextOffset, 1);
  assert.equal(first.source, undefined); assert.equal(first.history, undefined); assert.equal(first.browser, undefined);
  const last = JSON.parse(await tool.execute({ action: 'status', offset: first.nextOffset, limit: 2 }, { agent: { id: 'session-test' } }));
  assert.equal(last.nextOffset, null); assert.equal(last.comments[0].id, 'R2.1');
});

test('legacy sessions bind an existing manuscript folder without starting or editing a paper pipeline', async t => {
  const root = fixture(t), other = fixture(t), f = await serverFixture(t, root);
  let response = await fetch(`${f.base}/dsh-paper-reviews?sessionId=session-legacy`);
  assert.equal(response.status, 409); assert.equal((await response.json()).needsProject, true);
  response = await f.post({ sessionId: 'session-legacy', action: 'bind-project', project: root });
  assert.equal(response.status, 400);
  response = await f.post({ sessionId: 'session-legacy', action: 'bind-project', project: root, confirmed: true });
  assert.equal(response.status, 200); assert.equal((await response.json()).state.revision, 0);
  const tool = f.tools.get('manage_reviewer_response');
  assert.equal(JSON.parse(await tool.execute({ action: 'status' }, { agent: { id: 'session-legacy' } })).project, root);
  response = await f.post({ sessionId: 'session-legacy', action: 'bind-project', project: other, confirmed: true });
  assert.equal(response.status, 409);
  response = await f.post({ sessionId: 'session-test', action: 'bind-project', project: other, confirmed: true });
  assert.equal(response.status, 409);
});
