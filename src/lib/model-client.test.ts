import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelClient } from './model-client.js';

test('temporary proxy failures retry only once by default', async () => {
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
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('OPENAI_API_KEY', originalApiKey);
    restoreEnv('OPENAI_BASE_URL', originalBaseUrl);
    restoreEnv('MODEL_MAX_RETRIES', originalRetries);
    restoreEnv('MODEL_STRICT_OUTPUT', originalStrict);
  }
});

test('Claude compatibility reports an empty response without switching provider', async () => {
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
    await assert.rejects(new ModelClient().chat(
      [{ role: 'user', content: 'test' }],
      { task: 'protocol', maxAttempts: 1 }
    ), /no visible content/);
    assert.deepEqual(urls, [
      'https://proxy.invalid/v1/chat/completions',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('transport retry keeps the originally selected provider and model', async () => {
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
      choices: [{ message: { content: 'recovered' } }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  };

  try {
    const response = await new ModelClient().chat(
      [{ role: 'user', content: 'test' }],
      { task: 'protocol', maxAttempts: 2 }
    );
    assert.equal(response.content, 'recovered');
    assert.equal(response.provider, 'claude');
    assert.equal(response.model, 'claude-opus-5');
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

test('explicit provider and model remain selected when a task is also supplied', async () => {
  const saved = saveEnv(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_MODE',
    'MODEL_STRICT_OUTPUT', 'ROUTE_PROTOCOL_PROVIDER', 'MODEL_MIN_INTERVAL_MS']);
  const originalFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = 'fixture-key';
  process.env.ANTHROPIC_BASE_URL = 'https://manual.example/v1';
  process.env.ANTHROPIC_API_MODE = 'openai-completions';
  process.env.MODEL_STRICT_OUTPUT = 'false';
  process.env.MODEL_MIN_INTERVAL_MS = '0';
  process.env.ROUTE_PROTOCOL_PROVIDER = 'openai';
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://manual.example/v1/chat/completions');
    assert.equal(JSON.parse(String(init?.body)).model, 'manual-claude');
    return Response.json({ choices: [{ message: { content: 'manual selection preserved' } }] });
  };
  try {
    const response = await new ModelClient().chat([{ role: 'user', content: 'fixture' }],
      { task: 'protocol', provider: 'claude', model: 'manual-claude' });
    assert.equal(response.provider, 'claude');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('configured completions protocol is honored for a GPT model', async () => {
  const saved = saveEnv(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_MODE', 'MODEL_STRICT_OUTPUT']);
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'fixture-key';
  process.env.OPENAI_BASE_URL = 'https://configured.example/v1';
  process.env.OPENAI_API_MODE = 'openai-completions';
  process.env.MODEL_STRICT_OUTPUT = 'false';
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://configured.example/v1/chat/completions');
    return Response.json({ choices: [{ message: { content: 'correct protocol' } }] });
  };
  try {
    assert.equal((await new ModelClient().chat([{ role: 'user', content: 'fixture' }],
      { provider: 'openai', model: 'gpt-5.5' })).content, 'correct protocol');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('temporary failure makes at most two calls without cross-provider fallback', async () => {
  const saved = saveEnv(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_MODE',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_MODE', 'MODEL_MIN_INTERVAL_MS',
    'ROUTE_PROTOCOL_PROVIDER', 'ROUTE_PROTOCOL_MODEL', 'ROUTE_PROTOCOL_FALLBACK_PROVIDER',
    'ROUTE_PROTOCOL_FALLBACK_MODEL']);
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'fixture-key';
  process.env.ANTHROPIC_API_KEY = 'fixture-key';
  process.env.OPENAI_BASE_URL = 'https://fixture.example/v1';
  process.env.ANTHROPIC_BASE_URL = 'https://fixture.example/v1';
  process.env.OPENAI_API_MODE = 'openai-completions';
  process.env.ANTHROPIC_API_MODE = 'openai-completions';
  process.env.MODEL_MIN_INTERVAL_MS = '0';
  process.env.ROUTE_PROTOCOL_PROVIDER = 'claude';
  process.env.ROUTE_PROTOCOL_MODEL = 'primary';
  process.env.ROUTE_PROTOCOL_FALLBACK_PROVIDER = 'openai';
  process.env.ROUTE_PROTOCOL_FALLBACK_MODEL = 'fallback';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: 'unavailable' }, { status: 503 });
  };
  try {
    await assert.rejects(new ModelClient().chat([{ role: 'user', content: 'fixture' }],
      { task: 'protocol', maxAttempts: 2 }), /停止自动重试/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('insufficient quota stops without retrying another model', async () => {
  const saved = saveEnv(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_MODE',
    'ROUTE_PROTOCOL_PROVIDER', 'ROUTE_PROTOCOL_MODEL', 'ROUTE_PROTOCOL_FALLBACK_PROVIDER',
    'ROUTE_PROTOCOL_FALLBACK_MODEL']);
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'fixture-key';
  process.env.OPENAI_BASE_URL = 'https://fixture.example/v1';
  process.env.OPENAI_API_MODE = 'openai-completions';
  process.env.ROUTE_PROTOCOL_PROVIDER = 'openai';
  process.env.ROUTE_PROTOCOL_MODEL = 'primary';
  process.env.ROUTE_PROTOCOL_FALLBACK_PROVIDER = 'claude';
  process.env.ROUTE_PROTOCOL_FALLBACK_MODEL = 'fallback';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 });
  };
  try {
    await assert.rejects(new ModelClient().chat([{ role: 'user', content: 'fixture' }],
      { task: 'protocol', maxAttempts: 3 }), /insufficient_quota/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('authentication transport messages neither retry nor switch providers', async () => {
  const saved = saveEnv(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_MODE',
    'ROUTE_PROTOCOL_PROVIDER', 'ROUTE_PROTOCOL_MODEL', 'ROUTE_PROTOCOL_FALLBACK_PROVIDER',
    'ROUTE_PROTOCOL_FALLBACK_MODEL']);
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, { OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'https://fixture.example/v1',
    OPENAI_API_MODE: 'openai-completions', ROUTE_PROTOCOL_PROVIDER: 'openai',
    ROUTE_PROTOCOL_MODEL: 'primary', ROUTE_PROTOCOL_FALLBACK_PROVIDER: 'claude',
    ROUTE_PROTOCOL_FALLBACK_MODEL: 'fallback' });
  let calls = 0;
  try {
    for (const status of [401, 403]) {
      calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return Response.json({ error: { message: 'upstream fetch failed' } }, { status });
      };
      await assert.rejects(new ModelClient().chat([{ role: 'user', content: 'fixture' }],
        { task: 'protocol', maxAttempts: 3 }), new RegExp(`\\[${status}\\]`));
      assert.equal(calls, 1);
    }
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error('fetch failed', { cause: { code: 'MISSING_CREDENTIAL' } });
    };
    await assert.rejects(new ModelClient().chat([{ role: 'user', content: 'fixture' }],
      { task: 'protocol', maxAttempts: 3 }), /fetch failed/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('Grok uses its own key and Responses protocol rather than the OpenAI group', async () => {
  const saved = saveEnv(['GROK_API_KEY', 'GROK_BASE_URL', 'GROK_API_MODE', 'OPENAI_API_KEY']);
  const originalFetch = globalThis.fetch;
  process.env.GROK_API_KEY = 'fixture-grok-group';
  process.env.GROK_BASE_URL = 'https://grok.example/v1';
  process.env.GROK_API_MODE = 'openai-responses';
  process.env.OPENAI_API_KEY = 'wrong-group-key';
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://grok.example/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-grok-group');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'grok-4.7');
    assert.equal(body.reasoning, undefined);
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] });
  };
  try {
    const response = await new ModelClient().chat([{ role: 'user', content: 'fixture' }],
      { provider: 'grok', model: 'grok-4.7', minOutputChars: 1 });
    assert.equal(response.provider, 'grok');
    assert.equal(response.content, 'OK');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('DeepSeek uses its own key and configured completions endpoint', async () => {
  const saved = saveEnv(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_MODE', 'OPENAI_API_KEY']);
  const originalFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-group';
  process.env.DEEPSEEK_BASE_URL = 'https://deepseek.example/v1/';
  process.env.DEEPSEEK_API_MODE = 'openai-completions';
  process.env.OPENAI_API_KEY = 'wrong-group-key';
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://deepseek.example/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-deepseek-group');
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  try {
    assert.equal((await new ModelClient().chat([{ role: 'user', content: 'fixture' }],
      { provider: 'deepseek', model: 'fixture-model', minOutputChars: 1 })).provider, 'deepseek');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('unknown provider stops before making an HTTP request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  try {
    await assert.rejects(new ModelClient().chat([{ role: 'user', content: 'fixture' }],
      { provider: 'unconfigured-group' as 'openai', model: 'fixture-model' }), /Unsupported model provider/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('native DeepSeek Messages protocol retains its own authentication and response identity', async () => {
  const saved = saveEnv(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_MODE', 'ANTHROPIC_API_KEY']);
  const originalFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = 'native-deepseek-key';
  process.env.DEEPSEEK_BASE_URL = 'https://native.example/anthropic';
  process.env.DEEPSEEK_API_MODE = 'anthropic-messages';
  process.env.ANTHROPIC_API_KEY = 'wrong-claude-group';
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://native.example/anthropic/v1/messages');
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'native-deepseek-key');
    assert.equal(JSON.parse(String(init?.body)).system, 'system instructions');
    return Response.json({ content: [{ type: 'text', text: 'OK' }] });
  };
  try {
    const response = await new ModelClient().chat([{ role: 'system', content: 'system instructions' },
      { role: 'user', content: 'fixture' }], { provider: 'deepseek', model: 'fixture-model', minOutputChars: 1 });
    assert.equal(response.provider, 'deepseek');
    assert.equal(response.content, 'OK');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});
