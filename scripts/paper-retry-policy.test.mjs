import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecoverablePaperFailure, resolveMaxRecoveries } from './paper-retry-policy.mjs';

test('billing failures are terminal even when log contains earlier transport failures', () => {
  assert.equal(isRecoverablePaperFailure('TimeoutError\nHTTP 403 {"type":"billing_error","message":"insufficient balance"}'), false);
  assert.equal(isRecoverablePaperFailure('HTTP 429 insufficient_quota'), false);
});

test('transient failures remain recoverable with bounded limits', () => {
  assert.equal(isRecoverablePaperFailure('ETIMEDOUT'), true);
  assert.equal(resolveMaxRecoveries('72'), 3);
  assert.equal(resolveMaxRecoveries('0'), 0);
});
