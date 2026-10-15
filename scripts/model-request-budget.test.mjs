import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { apply as installNativeRetry } from '@deepseek-ai/dsh-llm-retry';
import { installWebModelRouter } from '../config/dsh/web/model-router.js';
import { installModelRequestBudget } from './model-request-budget.mjs';
import { isBillingModelFailure } from './model-failure-policy.mjs';

/** Exercise the real Cordis waterfall with the installed native retry plugin. */
function fixture(t, restored = 0) {
  const ctx = new Context();
  const records = [];
  const state = {};
  ctx.sessionProjections = { register: () => {}, stateOf: () => state };
  ctx.logger = { warn: () => {}, info: () => {} };
  const agent = { session: { seq: 0, snapshotEvents: (after = 0) => records.filter((e) => e.seq > after),
    append: (type, data) => {
      const event = { type, data, seq: ++agent.session.seq };
      records.push(event);
      if (type === 'llm/retry') state[JSON.stringify([data.provider, data.policyKey])] = data;
      return event;
    } } };
  for (let i = 0; i < restored; i++) agent.session.append('assistant/attempt', { turn: 1, step: 1 });
  installNativeRetry(ctx);
  const nativeGet = ctx.get.bind(ctx);
  ctx.get = (name) => name === 'credentials' ? { resolve: async () => ({ value: 'fixture-key' }) }
    : name === 'llm' ? { listProviders: () => [{ id: 'rayinai-claude' }] } : nativeGet(name);
  installWebModelRouter(ctx, async () => ['one', 'two', 'three', 'four'].map((model) => ({ provider: 'claude', model })));
  installModelRequestBudget(ctx);
  ctx.emit('agent/inbox/claimed', { agent, turn: 1,
    message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'write paper' }] } });
  t.after(() => ctx.fiber.dispose());
  const event = { agent, turn: 1, step: 1, provider: 'rayinai-claude', signal: new AbortController().signal,
    retryPolicy: { mode: 'always', initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } };
  const request = () => ctx.waterfall('agent/request', event, async () => ({ provider: 'rayinai-claude', model: 'one' }));
  const fail = async (failure) => {
    agent.session.append('assistant/attempt', { turn: event.turn, step: event.step });
    return ctx.waterfall('agent/request-error', { ...event, failure }, async () => undefined);
  };
  return { ctx, event, records, request, fail };
}

test('native always retry and automatic model failover share three total attempts', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.request()).model, ['one', 'two', 'three'][i]);
    assert.equal((await f.fail({ code: 'TIMEOUT', message: 'timed out' }))?.kind, i < 2 ? 'retry' : undefined);
  }
  await assert.rejects(f.request(), { code: 'MODEL_RETRY_BUDGET' });
});

test('same-provider retry followed by route switching consumes the same budget', async (t) => {
  const f = fixture(t);
  assert.equal((await f.request()).model, 'one');
  assert.equal((await f.fail({ code: 'CUSTOM_TRANSIENT', message: 'temporary failure' }))?.kind, 'retry');
  assert.equal((await f.request()).model, 'one');
  assert.equal((await f.fail({ code: 'TIMEOUT', message: 'timed out' }))?.kind, 'retry');
  assert.equal((await f.request()).model, 'two');
  assert.equal(await f.fail({ code: 'TIMEOUT', message: 'timed out' }), undefined);
  assert.equal(f.records.filter((e) => e.type === 'llm/retry').length, 1);
});

test('funding errors veto native always retry without changing its provider policy', async (t) => {
  for (const failure of [{ code: 'RATE_LIMIT', message: 'insufficient_quota' },
    { code: 'SERVER', message: 'payment required', status: 402 },
    { code: 'quota_exceeded', message: 'account exhausted' }]) {
    const f = fixture(t);
    await f.request();
    assert.equal(await f.fail(failure), undefined);
    assert.equal(f.records.some((e) => e.type === 'llm/retry'), false);
    assert.equal(f.event.retryPolicy.mode, 'always');
  }
  assert.equal(isBillingModelFailure({ code: 'RATE_LIMIT', message: 'rate_limit_exceeded' }), false);
});

test('restored same-step failures cannot reset the request budget', async (t) => {
  const f = fixture(t, 2);
  await f.request();
  assert.equal(await f.fail({ code: 'TRANSPORT', message: 'connection error' }), undefined);
  await assert.rejects(f.request(), { code: 'MODEL_RETRY_BUDGET' });
});

test('authentication failures cannot be retried by a native always policy', async (t) => {
  for (const code of ['AUTH', 'MISSING_CREDENTIAL']) {
    const f = fixture(t);
    await f.request();
    assert.equal(await f.fail({ code, message: 'credentials require attention' }), undefined);
    assert.equal(f.records.some((e) => e.type === 'llm/retry'), false);
  }
});

test('a new step or turn gets a fresh budget', async (t) => {
  const f = fixture(t, 3);
  await assert.rejects(f.request(), { code: 'MODEL_RETRY_BUDGET' });
  f.event.step = 2;
  await f.request();
  assert.equal((await f.fail({ code: 'TIMEOUT', message: 'timed out' }))?.kind, 'retry');
  f.event.turn = 2;
  f.event.step = 1;
  await f.request();
});
