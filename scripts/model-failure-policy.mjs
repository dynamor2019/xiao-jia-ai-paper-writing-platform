/** Distinguish account funding failures from temporary throttling. */
export function isBillingModelFailure(error) {
  if (error?.status === 402) return true;
  const message = typeof error?.message === 'string' ? error.message : String(error);
  const code = typeof error?.code === 'string' ? error.code : '';
  return /insufficient_quota|quota_exceeded|billing_hard_limit|insufficient.{0,30}(?:balance|credit|fund)|payment.required|\[402\]|余额不足|欠费/i.test(`${code} ${message}`);
}
