import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelClient } from './model-client.js';

for (const [provider, model] of [['openai', 'gpt-5.5'], ['openai', 'gpt-6.1-sol'], ['claude', 'claude-sonnet-4-6']] as const) {
  test(`${provider}/${model} finishes an open Responses stream with its own credentials`, async () => {
    const originalFetch = globalThis.fetch;
    const names = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_MODE', 'MODEL_MIN_INTERVAL_MS', 'OPENAI_REASONING_EFFORT'];
    const saved = new Map(names.map(name => [name, process.env[name]]));
    let cancelled = false;
    Object.assign(process.env, {
      OPENAI_API_KEY: 'openai-test', OPENAI_BASE_URL: 'https://openai.invalid/v1',
      ANTHROPIC_API_KEY: 'claude-test', ANTHROPIC_BASE_URL: 'https://claude.invalid/v1',
      ANTHROPIC_API_MODE: 'openai-responses', MODEL_MIN_INTERVAL_MS: '0', OPENAI_REASONING_EFFORT: 'medium',
    });
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), `https://${provider}.invalid/v1/responses`);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${provider}-test`);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      if (provider === 'claude') assert.equal(body.reasoning, undefined);
      const event = { type: 'response.completed', response: {
        status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      } };
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const result = await new ModelClient().chat([{ role: 'user', content: 'test' }], {
        provider, model, maxAttempts: 1, minOutputChars: 1, timeoutMs: 1000,
      });
      assert.equal(result.content, 'OK');
      assert.equal(result.provider, provider);
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}
