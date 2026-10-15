import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedModelAttempts, isBillingModelFailure, usesResponsesProtocol } from './model-request-policy.js';

test('explicit API mode overrides GPT model-name inference', () => {
  assert.equal(usesResponsesProtocol('gpt-5.5', { OPENAI_API_MODE: 'openai-completions' }), false);
  assert.equal(usesResponsesProtocol('custom-model', { OPENAI_API_MODE: 'openai-responses' }), true);
  assert.equal(usesResponsesProtocol('gpt-5.5', { OPENAI_USE_RESPONSES_API: 'false' }), false);
  assert.throws(() => usesResponsesProtocol('gpt-5.5', { OPENAI_API_MODE: 'unknown' }), /Unsupported/);
});

test('attempt limits reject unbounded and invalid settings', () => {
  assert.equal(boundedModelAttempts(Infinity), 1);
  assert.equal(boundedModelAttempts(NaN), 1);
  assert.equal(boundedModelAttempts(0), 1);
  assert.equal(boundedModelAttempts(99), 3);
});

test('billing quota and account balance differ from transient rate limits', () => {
  assert.equal(isBillingModelFailure(new Error('[429] insufficient_quota')), true);
  assert.equal(isBillingModelFailure(new Error('insufficient account balance')), true);
  assert.equal(isBillingModelFailure(new Error('[429] rate_limit_exceeded')), false);
});
