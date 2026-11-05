import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyWebTask, installWebModelRouter } from '../config/dsh/web/model-router.js';

/** Create a minimal agent-event harness without mutating real sessions. */
function fixture(candidates, manual = false) {
  const handlers = new Map();
  const credentials = { resolve: async () => ({ value: 'fixture-key' }) };
  const llm = { listProviders: () => [{ id: 'rayinai' }, { id: 'rayinai-claude' }, { id: 'sub2api-grok' }] };
  const ctx = { on: (name, handler) => handlers.set(name, handler),
    get: (name) => ({ credentials, llm })[name] };
  installWebModelRouter(ctx, async () => candidates);
  const agent = { session: { seq: 1,
    snapshotEvents: () => manual ? [{ type: 'model/selection' }] : [] } };
  const event = { agent, turn: 1, step: 1 };
  handlers.get('agent/inbox/claimed')({ ...event,
    message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'write paper' }] } });
  return { handlers, event };
}

test('automatic routes use the credential service, not only process env', async () => {
  const { handlers, event } = fixture([{ provider: 'claude', model: 'claude-opus-5-5' }]);
  const route = await handlers.get('agent/request')(event,
    async () => ({ provider: 'rayinai', model: 'original' }));
  assert.equal(route.provider, 'rayinai-claude');
  assert.equal(route.model, 'claude-opus-5-5');
});

test('manual selection is preserved, including unavailable-model errors', async () => {
  const { handlers, event } = fixture([{ provider: 'claude', model: 'claude-sonnet-5' }], true);
  const config = { provider: 'rayinai-claude', model: 'claude-sonnet-5-5' };
  assert.deepEqual(await handlers.get('agent/request')(event, async () => config), config);
  assert.equal(handlers.has('agent/request-error'), false);
});

test('the router selects a task model without installing a second error-recovery chain', async () => {
  const candidates = ['one', 'two', 'three', 'four'].map((model) => ({ provider: 'claude', model }));
  const { handlers, event } = fixture(candidates);
  for (let attempt = 0; attempt < 3; attempt++) {
    const route = await handlers.get('agent/request')(event, async () => ({}));
    assert.equal(route.model, candidates[0].model);
  }
  assert.equal(handlers.has('agent/request-error'), false);
});

test('authentication failures do not spend tokens on other model groups', async () => {
  const { handlers, event } = fixture([{ provider: 'claude', model: 'one' }]);
  await handlers.get('agent/request')(event, async () => ({}));
  assert.equal(handlers.has('agent/request-error'), false);
});

test('automatic Grok routing uses its own provider instead of the OpenAI group', async () => {
  const { handlers, event } = fixture([{ provider: 'grok', model: 'grok-4.7' }]);
  const route = await handlers.get('agent/request')(event, async () => ({ provider: 'rayinai', model: 'old' }));
  assert.deepEqual(route, { provider: 'sub2api-grok', model: 'grok-4.7' });
});

test('custom configured credential references are resolved through the service', async () => {
  const handlers = new Map();
  const seen = [];
  const ctx = { on: (name, handler) => handlers.set(name, handler), get: (name) => name === 'llm'
    ? { listProviders: () => [{ id: 'rayinai-claude' }] }
    : { resolve: async (ref) => { seen.push(ref); return { value: 'fixture-key' }; } } };
  installWebModelRouter(ctx, async () => [{ provider: 'claude', model: 'custom-model' }], () => 'USER_SELECTED_REF');
  const agent = { session: { seq: 0, snapshotEvents: () => [] } };
  handlers.get('agent/inbox/claimed')({ agent, turn: 1,
    message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'write paper' }] } });
  const route = await handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => ({}));
  assert.equal(route.provider, 'rayinai-claude');
  assert.deepEqual(seen, ['USER_SELECTED_REF']);
});

test('old citation messages do not overwrite the newest writing task', async () => {
  const handlers = new Map();
  const tasks = [];
  const ctx = { on: (name, handler) => handlers.set(name, handler), get: () => undefined };
  installWebModelRouter(ctx, async (task) => { tasks.push(task); return []; });
  const agent = { session: { seq: 0, snapshotEvents: () => [] } };
  const messages = ['核对引用', '写论文'].map((text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
  await handlers.get('agent/pre-step')({ agent, turn: 1 }, async () => ({ kind: 'enter', messages }));
  await handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => ({}));
  assert.deepEqual(tasks, ['writing']);
});

test('ordinary messages preserve the native session model and reasoning level', async () => {
  const { handlers, event } = fixture([{ provider: 'claude', model: 'writing-model' }]);
  handlers.get('agent/inbox/claimed')({ ...event,
    message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } });
  const original = { provider: 'rayinai', model: 'user-default', reasoningEffort: 'low' };
  assert.deepEqual(await handlers.get('agent/request')(event, async () => original), original);
});

test('missing task candidates do not force a legacy hardcoded model', async () => {
  const { handlers, event } = fixture([]);
  const original = { provider: 'sub2api-grok', model: 'grok-4.7' };
  assert.deepEqual(await handlers.get('agent/request')(event, async () => original), original);
});

test('English doing is not a DOI request while actual DOI identifiers still classify', () => {
  assert.equal(classifyWebTask('What are you doing?'), undefined);
  assert.equal(classifyWebTask('check DOI 10.1000/example'), 'citation');
  assert.equal(classifyWebTask('核对这个DOI号'), 'citation');
});
