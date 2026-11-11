import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { approvedFixture } from './reviewer-response-test-fixture.mjs';
import { changeReview, exportReview, readReview, saveReview } from './reviewer-response-store.mjs';
import { egoJobStatus, portalUrl, prepareEgoFill, startEgoJob, waitEgoJob } from './reviewer-ego.mjs';

test('portal input never becomes shell code and rejects non-web/credential URLs', () => {
  assert.equal(portalUrl('https://journal.example/revision'), 'https://journal.example/revision');
  assert.throws(() => portalUrl('file:///C:/secret'));
  assert.throws(() => portalUrl('https://user:password@journal.example'));
  assert.throws(() => portalUrl('http://journal.example'));
  assert.equal(portalUrl('http://127.0.0.1:4101/portal'), 'http://127.0.0.1:4101/portal');
});

test('browser fill requires approval, explicit confirmation, fresh revision and non-duplicate mappings', t => {
  const { root, state } = approvedFixture(t);
  state.browser = { spaceId: 123, url: 'https://journal.example/review', source: 'Comment', fields: [{ key: 'response-0', selector: '#reply', value: '' }] };
  const body = { confirmed: true, revision: state.revision, mappings: [{ id: 'R1.1', key: 'response-0' }] };
  assert.equal(prepareEgoFill(root, state, body)[0].response, state.comments[0].response);
  assert.throws(() => prepareEgoFill(root, state, { ...body, confirmed: false }));
  assert.throws(() => prepareEgoFill(root, state, { ...body, revision: 0 }));
  assert.throws(() => prepareEgoFill(root, state, { ...body, mappings: [...body.mappings, ...body.mappings] }));
  assert.match(prepareEgoFill(root, state, { ...body, mappings: [{ id: 'all', key: 'response-0' }] })[0].response, /Response to Reviewers/);
  changeReview(root, { action: 'edit', revision: state.revision, id: 'R1.1', patch: { response: 'Changed' } });
  assert.throws(() => prepareEgoFill(root, readReview(root), { ...body, revision: state.revision + 1 }), /作者确认/);
});

test('one live browser round is observed, not restarted; simultaneous manuscript edits survive receipt', async t => {
  const { root, state } = approvedFixture(t);
  let complete; const promise = new Promise(resolve => { complete = resolve; });
  const options = { root, stateRoot: join(root, '.dsh-state'), execute: () => promise };
  const body = { revision: state.revision, operation: 'open', url: 'https://journal.example' };
  const job = startEgoJob(options, body);
  assert.equal(job.status, 'running'); assert.equal(egoJobStatus(root).id, job.id);
  assert.throws(() => startEgoJob(options, body), { status: 409 });
  changeReview(root, { revision: state.revision, action: 'edit', id: 'R1.1', patch: { response: 'Concurrent author edit' } });
  complete({ spaceId: 123, page: 'p1', source: 'Actual reviewer text', fields: [] });
  assert.equal((await waitEgoJob(root)).status, 'completed');
  assert.equal(readReview(root).comments[0].response, 'Concurrent author edit');
  assert.equal(readReview(root).browser.spaceId, 123);
});

test('partial write errors preserve receipts and force re-reading fields without a retry', async t => {
  const { root, state } = approvedFixture(t);
  state.browser = { spaceId: 123, source: 'Text', fields: [{ key: 'a', selector: '#reply', value: '' }] };
  const saved = saveReview(root, state.revision, state);
  let calls = 0;
  startEgoJob({ root, stateRoot: root, execute: async () => { calls++; return { error: 'Disconnected after write', filled: ['R1.1'] }; } },
    { operation: 'fill', revision: saved.revision, confirmed: true, mappings: [{ id: 'R1.1', key: 'a' }] });
  const job = await waitEgoJob(root);
  assert.equal(job.status, 'failed'); assert.equal(calls, 1); assert.deepEqual(job.filled, ['R1.1']);
  assert.equal(readReview(root).browser.fields, undefined);
});

test('upload uses only current approved exports and an observed file input', async t => {
  const { root, state } = approvedFixture(t);
  state.browser = { spaceId: 123, uploads: [{ key: 'file0', selector: '#attachment' }] };
  const saved = saveReview(root, state.revision, state); exportReview(root, saved);
  let captured;
  const options = { root, stateRoot: root, execute: async (_dir, input) => { captured = input; return { uploaded: ['response-to-reviewers.md'], submitted: false }; } };
  const body = { operation: 'upload', revision: saved.revision, confirmed: true, key: 'file0', file: 'response-to-reviewers.md' };
  assert.throws(() => startEgoJob(options, { ...body, file: 'results.json' }), /允许/);
  startEgoJob(options, body); await waitEgoJob(root);
  assert.equal(captured.file, join(root, 'reviews/response-to-reviewers.md'));
  assert.equal(readReview(root).lastBrowserJob.submitted, false);
});

test('host restart observes a live recorded PID and blocks replacing its browser job', t => {
  const { root, state } = approvedFixture(t);
  writeFileSync(join(root, 'reviews/browser-operation.json'), JSON.stringify({ id: 'recorded', operation: 'fill', status: 'running', cliPid: process.pid }));
  assert.equal(egoJobStatus(root).status, 'running');
  assert.throws(() => startEgoJob({ root, stateRoot: root }, { revision: state.revision, operation: 'read' }), { status: 409 });
});

test('missing recorded process is interrupted and cannot cause a blind second upload', t => {
  const { root, state } = approvedFixture(t);
  state.browser = { spaceId: 123 };
  const saved = saveReview(root, state.revision, state);
  writeFileSync(join(root, 'reviews/browser-operation.json'), JSON.stringify({ id: 'dead', operation: 'upload', status: 'running', cliPid: 2147483647 }));
  assert.equal(egoJobStatus(root).interrupted, true);
  assert.throws(() => startEgoJob({ root, stateRoot: root }, { revision: saved.revision, operation: 'upload', confirmed: true }), /中断/);
});
