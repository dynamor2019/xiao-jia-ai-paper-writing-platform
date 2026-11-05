import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedModelAttempts, isAuthenticationModelFailure, isBillingModelFailure, isRetryableModelFailure, usesResponsesProtocol } from './model-request-policy.js';

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
  assert.equal(boundedModelAttempts(99), 2);
});

test('billing quota and account balance differ from transient rate limits', () => {
  assert.equal(isBillingModelFailure(new Error('[429] insufficient_quota')), true);
  assert.equal(isBillingModelFailure(new Error('insufficient account balance')), true);
  assert.equal(isBillingModelFailure(new Error('[429] rate_limit_exceeded')), false);
});

test('wrapped funding and credential failures retain their stop policy', () => {
  assert.equal(isBillingModelFailure(new Error('fetch failed', { cause: { statusCode: 402 } })), true);
  assert.equal(isAuthenticationModelFailure(new Error('fetch failed', { cause: { status: 401 } })), true);
  assert.equal(isAuthenticationModelFailure({ statusCode: '403' }), true);
  assert.equal(isAuthenticationModelFailure({ code: 'MISSING_CREDENTIAL' }), true);
  assert.equal(isAuthenticationModelFailure(new Error('[401]: upstream fetch failed')), true);
  assert.equal(isAuthenticationModelFailure(new Error('[429] rate_limit_exceeded')), false);
  const circular: { cause?: unknown } = {};
  circular.cause = circular;
  assert.equal(isAuthenticationModelFailure(circular), false);
  assert.equal(isBillingModelFailure(circular), false);
});

test('only transient failures can retry, including through transport wrappers', () => {
  for (const failure of [{ status: 400, message: 'fetch failed' }, { status: 404 },
    { code: 'EMPTY_RESPONSE' }, { message: '未知模型' }, { code: 'unsupported_model' }]) {
    assert.equal(isRetryableModelFailure(new Error('fetch failed', { cause: failure })), false);
  }
  for (const failure of [{ status: 503 }, { code: 'TIMEOUT' }, { code: 'TRANSPORT' },
    new Error('[429] rate_limit_exceeded')]) assert.equal(isRetryableModelFailure(failure), true);
});
