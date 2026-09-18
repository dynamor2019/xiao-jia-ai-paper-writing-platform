import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelClient } from './model-client.js';

test('paid proxy failures are not retried by default', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const originalRetries = process.env.MODEL_MAX_RETRIES;
  const originalStrict = process.env.MODEL_STRICT_OUTPUT;
  let calls = 0;

  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = 'https://proxy.invalid/v1';
  process.env.MODEL_STRICT_OUTPUT = 'false';
  delete process.env.MODEL_MAX_RETRIES;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: 'Upstream service temporarily unavailable' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    await assert.rejects(
      new ModelClient().chat(
        [{ role: 'user', content: 'test' }],
        { provider: 'openai', model: 'gpt-5.4', maxTokens: 1 }
      ),
      /为避免重复计费，已停止自动重试/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('OPENAI_API_KEY', originalApiKey);
    restoreEnv('OPENAI_BASE_URL', originalBaseUrl);
    restoreEnv('MODEL_MAX_RETRIES', originalRetries);
    restoreEnv('MODEL_STRICT_OUTPUT', originalStrict);
  }
});

test('uses Claude OpenAI compatibility and falls back after an empty response', async () => {
  const originalFetch = globalThis.fetch;
  const saved = saveEnv([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_MODE',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MODEL_MIN_INTERVAL_MS',
    'ROUTE_PROTOCOL_PROVIDER', 'ROUTE_PROTOCOL_MODEL',
    'ROUTE_PROTOCOL_FALLBACK_PROVIDER', 'ROUTE_PROTOCOL_FALLBACK_MODEL',
    'MODEL_STRICT_OUTPUT',
  ]);
  const urls: string[] = [];
  process.env.ANTHROPIC_API_KEY = 'claude-key';
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.invalid';
  process.env.ANTHROPIC_API_MODE = 'openai-completions';
  process.env.OPENAI_API_KEY = 'openai-key';
  process.env.OPENAI_BASE_URL = 'https://proxy.invalid/v1';
  process.env.MODEL_MIN_INTERVAL_MS = '0';
  process.env.MODEL_STRICT_OUTPUT = 'false';
  process.env.ROUTE_PROTOCOL_PROVIDER = 'claude';
  process.env.ROUTE_PROTOCOL_MODEL = 'claude-opus-5';
  process.env.ROUTE_PROTOCOL_FALLBACK_PROVIDER = 'openai';
  process.env.ROUTE_PROTOCOL_FALLBACK_MODEL = 'gpt-5.6-sol';
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) {
      return Response.json({ choices: [{ message: { content: '' } }], usage: { completion_tokens: 0 } });
    }
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'recovered' }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  };

  try {
    const response = await new ModelClient().chat(
      [{ role: 'user', content: 'test' }],
      { task: 'protocol', maxAttempts: 1 }
    );
    assert.equal(response.content, 'recovered');
    assert.equal(response.provider, 'openai');
    assert.deepEqual(urls, [
      'https://proxy.invalid/v1/chat/completions',
      'https://proxy.invalid/v1/responses',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('falls back to the cross-provider route after a transport failure', async () => {
  const originalFetch = globalThis.fetch;
  const saved = saveEnv([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_MODE',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MODEL_MIN_INTERVAL_MS',
    'ROUTE_PROTOCOL_PROVIDER', 'ROUTE_PROTOCOL_MODEL',
    'ROUTE_PROTOCOL_FALLBACK_PROVIDER', 'ROUTE_PROTOCOL_FALLBACK_MODEL',
    'MODEL_STRICT_OUTPUT',
  ]);
  let calls = 0;
  process.env.ANTHROPIC_API_KEY = 'claude-key';
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.invalid';
  process.env.ANTHROPIC_API_MODE = 'openai-completions';
  process.env.OPENAI_API_KEY = 'openai-key';
  process.env.OPENAI_BASE_URL = 'https://proxy.invalid/v1';
  process.env.MODEL_MIN_INTERVAL_MS = '0';
  process.env.MODEL_STRICT_OUTPUT = 'false';
  process.env.ROUTE_PROTOCOL_PROVIDER = 'claude';
  process.env.ROUTE_PROTOCOL_MODEL = 'claude-opus-5';
  process.env.ROUTE_PROTOCOL_FALLBACK_PROVIDER = 'openai';
  process.env.ROUTE_PROTOCOL_FALLBACK_MODEL = 'gpt-5.6-sol';
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'recovered' }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  };

  try {
    const response = await new ModelClient().chat(
      [{ role: 'user', content: 'test' }],
      { task: 'protocol', maxAttempts: 1 }
    );
    assert.equal(response.content, 'recovered');
    assert.equal(response.provider, 'openai');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('rejects suspiciously short proxy responses in strict mode', async () => {
  const originalFetch = globalThis.fetch;
  const saved = saveEnv(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MODEL_MIN_INTERVAL_MS', 'MODEL_STRICT_OUTPUT']);
  process.env.OPENAI_API_KEY = 'openai-key';
  process.env.OPENAI_BASE_URL = 'https://proxy.invalid/v1';
  process.env.MODEL_MIN_INTERVAL_MS = '0';
  process.env.MODEL_STRICT_OUTPUT = 'true';
  globalThis.fetch = async () => Response.json({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  });

  try {
    await assert.rejects(
      new ModelClient().chat(
        [{ role: 'user', content: 'test' }],
        { provider: 'openai', model: 'gpt-5.6-sol', minOutputChars: 20 }
      ),
      /suspiciously short response/
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('rejects capability-refusal placeholders in strict mode', async () => {
  const originalFetch = globalThis.fetch;
  const saved = saveEnv(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MODEL_MIN_INTERVAL_MS', 'MODEL_STRICT_OUTPUT']);
  process.env.OPENAI_API_KEY = 'openai-key';
  process.env.OPENAI_BASE_URL = 'https://proxy.invalid/v1';
  process.env.MODEL_MIN_INTERVAL_MS = '0';
  process.env.MODEL_STRICT_OUTPUT = 'true';
  globalThis.fetch = async () => Response.json({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'As an AI language model, I cannot access the files.' }] }],
    usage: { input_tokens: 2, output_tokens: 9, total_tokens: 11 },
  });

  try {
    await assert.rejects(
      new ModelClient().chat(
        [{ role: 'user', content: 'test' }],
        { provider: 'openai', model: 'gpt-5.6-sol', minOutputChars: 20 }
      ),
      /capability-refusal placeholder/
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

function saveEnv(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreSavedEnv(saved: Map<string, string | undefined>): void {
  for (const [name, value] of saved) restoreEnv(name, value);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
