import assert from 'node:assert/strict';
import test from 'node:test';
import { assertModelProvider, getRoute } from './model-routing.js';

test('unknown providers and coerced objects cannot silently use OpenAI credentials', () => {
  assert.throws(() => assertModelProvider('invalid'), /Unsupported model provider/);
  assert.throws(() => assertModelProvider({ toString: () => 'openai' }), /Unsupported model provider/);
});

test('a Grok-only task override chooses a Grok model, not the task default GPT model', () => {
  const saved = [process.env.ROUTE_WRITING_PROVIDER, process.env.ROUTE_WRITING_MODEL, process.env.GROK_MODEL];
  process.env.ROUTE_WRITING_PROVIDER = 'grok';
  delete process.env.ROUTE_WRITING_MODEL;
  process.env.GROK_MODEL = 'grok-4.7';
  try {
    assert.deepEqual(getRoute('writing'), { provider: 'grok', model: 'grok-4.7' });
  } finally {
    ['ROUTE_WRITING_PROVIDER', 'ROUTE_WRITING_MODEL', 'GROK_MODEL'].forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});
