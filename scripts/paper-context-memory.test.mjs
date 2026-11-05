import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { Session } from '@deepseek-ai/dsh-session';
import { cacheWindowMetrics, installPaperContextMemory, prefixMetrics, projectMemory } from './paper-context-memory.mjs';

/** Create isolated existing project state; never touch real papers. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = join(root, '.dsh-state', 'paper-runs');
  const outputDir = join(root, 'paper');
  mkdirSync(runs, { recursive: true });
  mkdirSync(join(outputDir, '.dsh-state'), { recursive: true });
  writeFileSync(join(runs, 'session-test.json'), JSON.stringify({ outputDir, topic: 'Original question', status: 'running' }));
  const checkpoint = join(outputDir, '.dsh-state', 'paper-pipeline-state.json');
  writeFileSync(checkpoint, JSON.stringify({ stage: 'writing', metadata: { workflow: {
    tasks: { experiment: { status: 'completed' } },
  } } }));
  return { env: { PAPER_DATA_ROOT: root }, checkpoint };
}

test('memory uses exact bound state and refuses missing or unsafe session bindings', t => {
  const f = fixture(t);
  assert.equal(projectMemory({ id: 'session-test' }, f.env).tasks[0].status, 'completed');
  assert.equal(projectMemory({ id: '../session-test' }, f.env), null);
  assert.equal(projectMemory({ id: 'other' }, f.env), null);
  writeFileSync(f.checkpoint, 'broken JSON');
  assert.equal(projectMemory({ id: 'session-test' }, f.env).stage, 'unknown');
});

test('prefix diagnostics distinguish tail growth from earlier rewrite without exposing content', () => {
  const first = prefixMetrics([], [{ text: 'secret document' }]);
  const growth = prefixMetrics(first.hashes, [{ text: 'secret document' }, { text: 'new' }]);
  assert.equal(growth.metric.sharedPrefixMessages, 1);
  assert.equal(growth.metric.rewritten, false);
  assert.equal(prefixMetrics(growth.hashes, [{ text: 'changed' }]).metric.rewritten, true);
  assert.ok(!JSON.stringify(first).includes('secret document'));
});

test('recent cache share is weighted by input tokens and excludes generated output', () => {
  const usages = [{ inputTokens: 90, cacheReadTokens: 10, outputTokens: 9000 },
    { inputTokens: 0, cacheReadTokens: 900, outputTokens: 9000 }];
  assert.equal(cacheWindowMetrics(usages).hitRate, 0.91);
  assert.equal(cacheWindowMetrics(usages, 1).hitRate, 1);
  assert.equal(cacheWindowMetrics([]).hitRate, null);
  assert.equal(cacheWindowMetrics([{ inputTokens: 50, cacheReadTokens: 25, cacheWriteTokens: 25 }]).hitRate, 0.25);
});

test('native pre-step logs memory once, rehydrates after compaction, and observes changed checkpoint', async t => {
  const f = fixture(t);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const logs = [];
  ctx.logger = { info: text => logs.push(text) };
  installPaperContextMemory(ctx, { env: f.env });
  const session = Session.create('session-test');
  const native = session;
  const events = [{ type: 'user/message', seq: 1,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '禁止重跑实验' }] } }];
  const agent = { id: 'session-test', session: { seq: 1, surface: { replaceGeneration: 0 },
    deriveMessages: () => [], snapshotEvents: after => events.filter(event => event.seq > after),
  } };
  const enter = () => ({ kind: 'enter', messages: [] });
  const step = () => ctx.waterfall('agent/pre-step', { agent }, enter);
  const first = await step();
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].content[0].text, /禁止重跑实验/);
  // Ensure generated notice satisfies the actual durable session message contract.
  native.append('user/message', first.messages[0], { surfaceOp: 'append' });
  assert.equal((await step()).messages.length, 0);
  agent.session.surface.replaceGeneration++;
  events.push({ type: 'compaction/prune', seq: 2, data: {} });
  agent.session.seq = 2;
  assert.equal((await step()).messages.length, 0, 'tool-result pruning must not duplicate recovery notices');
  events.push({ type: 'compaction/summary', seq: 3, data: { compactionId: 'summary-1' } },
    { type: 'compaction/end', seq: 4, data: { compactionId: 'summary-1' } });
  agent.session.seq = 4;
  assert.equal((await step()).messages.length, 1);
  events.push({ type: 'compaction/summary', seq: 5, data: { compactionId: 'summary-2' } },
    { type: 'compaction/end', seq: 6, data: { compactionId: 'summary-2', error: 'cancelled' } });
  agent.session.seq = 6;
  assert.equal((await step()).messages.length, 0, 'failed summaries cannot trigger rehydration');
  writeFileSync(f.checkpoint, JSON.stringify({ stage: 'review' }));
  assert.match((await step()).messages[0].content[0].text, /review/);
  assert.ok(logs.every(log => !log.includes('禁止重跑实验') && !log.includes('Original question')));
});

test('cancelled and rejected steps cannot inject recovery messages', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  installPaperContextMemory(ctx);
  for (const kind of ['reject', 'enter']) {
    const controller = new AbortController();
    controller.abort();
    const decision = { kind, messages: [] };
    assert.equal(await ctx.waterfall('agent/pre-step', { agent: {}, signal: controller.signal },
      async () => decision), decision);
  }
});
