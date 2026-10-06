const DEFAULT_MAX_RECOVERIES = 3;
const HARD_MAX_RECOVERIES = 3;
const BILLING_FAILURE_PATTERN = /insufficient balance|billing_error|insufficient_quota|credit balance.*(?:low|exhausted|insufficient)/i;

/** Require explicit restored-account confirmation before another paid resume after a billing failure. */
export function assertResumeBillingAllowed(error, confirmed = false) {
  if (BILLING_FAILURE_PATTERN.test(String(error || '')) && confirmed !== true) {
    throw new Error('Relay billing failure remains unresolved; confirm restored account access before paid resume (--billing-restored).');
  }
}

export function resolveMaxRecoveries(value) {
  if (value === undefined || value === '') return DEFAULT_MAX_RECOVERIES;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_RECOVERIES;

  return Math.min(parsed, HARD_MAX_RECOVERIES);
}

export function isRecoverablePaperFailure(text) {
  if (BILLING_FAILURE_PATTERN.test(text)) return false;
  if (/为避免重复计费.{0,40}已停止自动重试|已停止自动重试.{0,40}稍后手动继续/i.test(text)) return false;

  return /Service temporarily unavailable|Connection error|TRANSPORT|fetch failed|ECONNRESET|ETIMEDOUT|TimeoutError|operation was aborted|aborted due to timeout|HTTP 408|HTTP 409|HTTP 429|HTTP 5\d\d|\[5\d\d\]|\[429\]|EMPTY_RESPONSE|completed with no visible content/i.test(text);
}
