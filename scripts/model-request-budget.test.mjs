import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { apply as installNativeRetry } from '@deepseek-ai/dsh-llm-retry';
import { installWebModelRouter } from '../config/dsh/web/model-router.js';
import { installModelRequestBudget } from './model-request-budget.mjs';
import { isBillingModelFailure } from './model-failure-policy.mjs';
import { Session, canonicalHeader } from '@deepseek-ai/dsh-session';

/** Exercise the real Cordis waterfall with the installed native retry plugin. */
function fixture(t, restored = 0, realCooldown = false) {
  const ctx = new Context();
  const records = [];
  const state = {};
  ctx.sessionProjections = { register: () => ({ stateOf: () => state }), stateOf: () => state };
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
  const cooldowns = [];
  installModelRequestBudget(ctx, realCooldown ? {} : { wait: async (milliseconds, signal) => {
    cooldowns.push(milliseconds);
    return !signal?.aborted;
  } });
  ctx.emit('agent/inbox/claimed', { agent, turn: 1,
    message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'write paper' }] } });
  t.after(() => ctx.fiber.dispose());
  const event = { agent, turn: 1, step: 1, provider: 'rayinai-claude', signal: new AbortController().signal,
    retryPolicy: { mode: 'always', initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } };
  const request = (config = { provider: 'rayinai-claude', model: 'one' }) => ctx.waterfall('agent/request', event, async () => config);
  const fail = async (failure) => {
    agent.session.append('assistant/attempt', { turn: event.turn, step: event.step });
    return ctx.waterfall('agent/request-error', { ...event, failure }, async () => undefined);
  };
  return { ctx, event, records, request, fail, cooldowns };
}

test('native always retry is capped at one retry on the same model', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.request()).model, 'one');
    assert.equal((await f.fail({ code: 'TIMEOUT', message: 'timed out' }))?.kind, i === 0 ? 'retry' : undefined);
  }
  await assert.rejects(f.request(), { code: 'MODEL_RETRY_BUDGET' });
});

test('connection errors receive two cooled retries on the same route and then stop', async t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    const request = await f.request({ provider: i ? 'other' : 'rayinai-claude', model: i ? 'changed' : 'one' });
    assert.equal(request.provider, 'rayinai-claude');
    assert.equal(request.model, 'one');
    const decision = await f.fail({ code: 'TRANSPORT', message: 'Connection error.' });
    assert.equal(decision?.kind, i < 2 ? 'retry' : undefined);
  }
  assert.deepEqual(f.cooldowns, [10000, 30000]);
  await assert.rejects(f.request(), { code: 'MODEL_RETRY_BUDGET' });
});

test('wrapped funding errors never gain transport cooldowns or extra attempts', async t => {
  const f = fixture(t);
  await f.request();
  assert.equal(await f.fail({ code: 'TRANSPORT', cause: { status: 402 } }), undefined);
  assert.deepEqual(f.cooldowns, []);
});

test('stopping during a real transport cooldown cancels before native retry scheduling', async t => {
  const f = fixture(t, 0, true);
  const controller = new AbortController();
  f.event.signal = controller.signal;
  await f.request();
  const recovery = f.fail({ code: 'TRANSPORT', message: 'Connection error.' });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(await recovery, undefined);
  assert.equal(f.records.some(event => event.type === 'llm/retry'), false);
});

test('unclassified failures stop rather than entering native always retry', async (t) => {
  const f = fixture(t);
  assert.equal((await f.request()).model, 'one');
  assert.equal(await f.fail({ code: 'CUSTOM_FAILURE', message: 'unknown failure' }), undefined);
  assert.equal(f.records.filter((e) => e.type === 'llm/retry').length, 0);
});

test('relay calls retain the pre-upgrade output budget while explicit and other-provider caps remain unchanged', async t => {
  for (const provider of ['rayinai', 'rayinai-claude', 'sub2api-grok', 'other']) {
    for (const maxTokens of [undefined, 4096, 64000]) {
      const f = fixture(t);
      f.event.agent.session.append('model/selection', {});
      const config = { provider, model: 'fixture-model', ...(maxTokens === undefined ? {} : { maxTokens }) };
      const request = await f.request(config);
      assert.equal(request.maxTokens, maxTokens ?? (provider === 'other' ? undefined : 32768));
      await f.fail({ code: 'TRANSPORT' });
      assert.equal((await f.request(config)).maxTokens, request.maxTokens);
    }
  }
});

test('peer reset recovers once on the same route without repeating an exhausted request', async t => {
  const f = fixture(t);
  await f.request();
  const failure = { code: 'PI_AI_ERROR', message: 'upstream stream disconnected: connection reset by peer' };
  assert.equal((await f.fail(failure))?.kind, 'retry');
  assert.equal((await f.request({ provider: 'other', model: 'different' })).model, 'one');
  assert.equal(await f.fail(failure), undefined);
});

test('peer reset never retries after cancellation or a wrapped billing failure', async t => {
  for (const billing of [true, false]) {
    const f = fixture(t);
    await f.request();
    const controller = new AbortController();
    if (!billing) controller.abort();
    f.event.signal = controller.signal;
    assert.equal(await f.fail({ message: 'connection reset by peer',
      ...(billing ? { cause: { status: 402 } } : {}) }), undefined);
  }
});

test('context overflow compacts once before retrying on the same model', async t => {
  const f = fixture(t);
  f.event.agent.session.surface = { replaceGeneration: 0 };
  let calls = 0;
  f.event.agent.ctx = { get: name => name === 'compaction' ? { compactIfNeeded: async (agent, trigger) => {
    calls++;
    assert.equal(trigger, 'context-overflow');
    agent.session.surface.replaceGeneration++;
  } } : undefined };
  await f.request();
  assert.equal((await f.fail({ code: 'CONTEXT_WINDOW_EXCEEDED' }))?.kind, 'retry');
  assert.equal((await f.request({ provider: 'other', model: 'changed' })).model, 'one');
  assert.equal(await f.fail({ code: 'CONTEXT_WINDOW_EXCEEDED' }), undefined);
  assert.equal(calls, 1);
  assert.equal(f.records.some(event => event.type === 'llm/retry'), false);
});

test('failed or ineffective compaction never permits a blind overflow retry', async t => {
  for (const fails of [false, true]) {
    const f = fixture(t);
    f.event.agent.session.surface = { replaceGeneration: 0 };
    f.event.agent.ctx = { get: () => ({ compactIfNeeded: async () => {
      if (fails) throw new Error('Summary unavailable');
    } }) };
    await f.request();
    assert.equal(await f.fail({ code: 'CONTEXT_WINDOW_EXCEEDED' }), undefined);
    assert.equal(f.records.some(event => event.type === 'llm/retry'), false);
  }
});

test('overflow recovery preserves cancellation and wrapped funding failures', async t => {
  for (const failure of [{ code: 'CONTEXT_WINDOW_EXCEEDED', cause: { status: 402 } },
    { code: 'CONTEXT_WINDOW_EXCEEDED', cause: { status: 401 } }]) {
    const f = fixture(t);
    f.event.agent.ctx = { get: () => { assert.fail('No paid compaction for authentication or billing failure'); } };
    await f.request();
    assert.equal(await f.fail(failure), undefined);
  }
  const f = fixture(t);
  f.event.agent.session.surface = { replaceGeneration: 0 };
  f.event.agent.ctx = { get: () => ({ compactIfNeeded: async () => {
    assert.fail('Cancelled work must not compact');
  } }) };
  const controller = new AbortController();
  controller.abort();
  f.event.signal = controller.signal;
  await f.request();
  assert.equal(await f.fail({ code: 'CONTEXT_WINDOW_EXCEEDED' }), undefined);
});

test('retry preserves the current step route even if later configuration differs', async (t) => {
  const f = fixture(t);
  assert.equal((await f.request()).model, 'one');
  await f.fail({ code: 'TIMEOUT' });
  f.event.agent.session.append('model/selection', {});
  const retried = await f.request({ provider: 'other', model: 'changed', reasoningEffort: 'high' });
  assert.equal(retried.provider, 'rayinai-claude');
  assert.equal(retried.model, 'one');
  assert.equal(retried.reasoningEffort, undefined);
  f.event.step++;
  assert.equal((await f.request({ provider: 'other', model: 'changed' })).model, 'changed');
});

test('native request/header accepts requests with absent and explicit reasoning effort', async (t) => {
  for (const effort of [undefined, 'high']) {
    const f = fixture(t);
    f.event.agent.session.append('model/selection', {});
    const input = { provider: 'rayinai-claude', model: 'fixture-model',
      ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    const session = Session.create('session-model-header-regression');
    assert.throws(() => session.append('request/header', {
      header: canonicalHeader({ config: { ...input, reasoningEffort: undefined } }), reason: 'initial',
    }), /non-JSON-serializable/);
    const config = await f.request(input);
    if (effort === undefined) assert.equal(Object.hasOwn(config, 'reasoningEffort'), false);
    const initial = session.append('request/header', { header: canonicalHeader({ config }), reason: 'initial' });
    assert.equal(initial.data.header.config.reasoningEffort, effort);
    await f.fail({ code: 'TIMEOUT' });
    const retried = await f.request({ ...input, reasoningEffort: 'low' });
    const retry = session.append('request/header', { header: canonicalHeader({ config: retried }), reason: 'change' });
    assert.equal(retry.data.header.config.reasoningEffort, effort);
  }
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
  const f = fixture(t, 1);
  await f.request();
  assert.equal(await f.fail({ code: 'TIMEOUT', message: 'request timed out' }), undefined);
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

test('wrapped funding and HTTP auth failures veto native always recovery', async (t) => {
  for (const cause of [{ status: 401 }, { statusCode: 403 }, { statusCode: 402 }, { code: 'MISSING_CREDENTIAL' }]) {
    const f = fixture(t);
    await f.request();
    assert.equal(await f.fail(new Error('fetch failed', { cause })), undefined);
    assert.equal(f.records.some((event) => event.type === 'llm/retry'), false);
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

test('unknown models stop without trying automatic candidates', async (t) => {
  const f = fixture(t);
  assert.equal((await f.request()).model, 'one');
  const failure = { code: 'PI_AI_ERROR', message: '404: {"message":"未知模型，请检查模型名称"}' };
  assert.equal(await f.fail(failure), undefined);
  assert.equal(f.records.some((event) => event.type === 'llm/retry'), false);
});

test('manual unknown model stops after one attempt without switching providers', async (t) => {
  for (const failure of [{ code: 'model_not_found' },
    { code: 'PI_AI_ERROR', message: '404: 未知模型' },
    new Error('fetch failed', { cause: { code: 'unsupported_model' } })]) {
    const f = fixture(t);
    f.event.agent.session.append('model/selection', { model: 'manual' });
    await f.request();
    assert.equal(await f.fail(failure), undefined);
    assert.equal(f.records.some((event) => event.type === 'llm/retry'), false);
    assert.equal(f.records.filter((event) => event.type === 'assistant/attempt').length, 1);
  }
});

test('an unavailable final candidate stops before native retry even with spare budget', async (t) => {
  const f = fixture(t);
  f.ctx.emit('agent/inbox/claimed', { agent: f.event.agent, turn: 1,
    message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } });
  await f.request();
  assert.equal(await f.fail({ code: 'PI_AI_ERROR', message: 'unknown model' }), undefined);
  assert.equal(f.records.some((event) => event.type === 'llm/retry'), false);
});

test('a generic endpoint 404 is not mistaken for an unavailable model', async (t) => {
  const f = fixture(t);
  await f.request();
  assert.equal(await f.fail({ code: 'PI_AI_ERROR', message: '404: route not found' }), undefined);
  assert.equal(f.records.some((event) => event.type === 'llm/retry'), false);
});
