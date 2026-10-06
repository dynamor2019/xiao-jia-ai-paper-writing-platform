import assert from 'node:assert/strict';
import test from 'node:test';
import { assertResumeBillingAllowed, isRecoverablePaperFailure, resolveMaxRecoveries } from './paper-retry-policy.mjs';

test('billing failures are terminal even when log contains earlier transport failures', () => {
  assert.equal(isRecoverablePaperFailure('TimeoutError\nHTTP 403 {"type":"billing_error","message":"insufficient balance"}'), false);
  assert.equal(isRecoverablePaperFailure('HTTP 429 insufficient_quota'), false);
});

test('direct resume cannot bypass billing stop without explicit restored-account confirmation', () => {
  assert.throws(() => assertResumeBillingAllowed('403 billing_error insufficient balance'), /confirm restored/);
  assert.throws(() => assertResumeBillingAllowed('403 billing_error', 'true'), /confirm restored/);
  assert.doesNotThrow(() => assertResumeBillingAllowed('403 billing_error', true));
  assert.doesNotThrow(() => assertResumeBillingAllowed('ETIMEDOUT'));
});

test('transient failures remain recoverable with bounded limits', () => {
  assert.equal(isRecoverablePaperFailure('ETIMEDOUT'), true);
  assert.equal(resolveMaxRecoveries('72'), 3);
  assert.equal(resolveMaxRecoveries('0'), 0);
});
