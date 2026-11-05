import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolvePaperModelEnv } from '../../scripts/paper-model-env.mjs';
import { ModelClient } from './model-client.js';

/** Minimal transport response with a useful visible completion. */
function completion(text = 'fixture result'): Response {
  return Response.json({ choices: [{ message: { content: text } }] });
}

test('concurrent calls isolate credentials, endpoints and protocol across asynchronous boundaries', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const observed: Array<{ url: string; key: string; reasoning: unknown }> = [];
  let release!: () => void;
  const barrier = new Promise<void>((done) => { release = done; });
  let count = 0;
  const client = new ModelClient(() => {
    const index = ++count;
    return { OPENAI_API_KEY: `fixture-${index}`, OPENAI_BASE_URL: `https://fixture-${index}.invalid/v1`,
      OPENAI_API_MODE: index === 1 ? 'openai-completions' : 'openai-responses',
      OPENAI_REASONING_EFFORT: index === 1 ? 'low' : 'medium', MODEL_MIN_INTERVAL_MS: '0' };
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    observed.push({ url: String(url), key: new Headers(init?.headers).get('Authorization') || '', reasoning: body.reasoning });
    if (observed.length === 2) release();
    await barrier;
    return String(url).endsWith('/responses')
      ? Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses fixture' }] }] })
      : completion();
  };
  const results = await Promise.all([1, 2].map(() => client.chat([{ role: 'user', content: 'fixture' }],
    { provider: 'openai', model: 'fixture' })));
  assert.deepEqual(observed.map((row) => [row.url, row.key]), [
    ['https://fixture-1.invalid/v1/chat/completions', 'Bearer fixture-1'],
    ['https://fixture-2.invalid/v1/responses', 'Bearer fixture-2'],
  ]);
  assert.deepEqual(observed[1].reasoning, { effort: 'medium' });
  assert.equal(results.length, 2);
});

test('one long-lived client refreshes Web credentials and stops after a managed credential is removed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-client-refresh-'));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); });
  writeFileSync(join(home, 'settings.yaml'), JSON.stringify({ 'llm-pi-ai': { providers: {
    rayinai: { api: 'openai-completions', apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://managed.invalid/v1' },
  } } }));
  const save = (value?: string) => writeFileSync(join(home, '.credentials.yaml'), JSON.stringify({
    version: 1, refs: value ? { OPENAI_API_KEY: value } : {},
  }));
  save('first-fixture');
  const inherited = resolvePaperModelEnv({ MODEL_MIN_INTERVAL_MS: '0' }, home, home);
  const client = new ModelClient(() => resolvePaperModelEnv(inherited, home, home));
  const keys: string[] = [];
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get('Authorization') || '');
    return completion();
  };
  await client.chat([{ role: 'user', content: 'fixture' }], { model: 'fixture' });
  save('second-fixture');
  await client.chat([{ role: 'user', content: 'fixture' }], { model: 'fixture' });
  save();
  await assert.rejects(client.chat([{ role: 'user', content: 'fixture' }], { model: 'fixture' }), /API key.*not configured/);
  assert.deepEqual(keys, ['Bearer first-fixture', 'Bearer second-fixture']);
  assert.equal(inherited.OPENAI_API_KEY, 'first-fixture');
});

test('configuration resolution failures do not send network requests', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return completion(); };
  const client = new ModelClient(() => { throw new Error('invalid managed configuration'); });
  await assert.rejects(client.chat([{ role: 'user', content: 'fixture' }]), /invalid managed configuration/);
  assert.equal(calls, 0);
});
