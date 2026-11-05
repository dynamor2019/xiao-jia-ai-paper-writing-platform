/** Inspect bounded cause chains without looping on malformed SDK errors. */
function matchesFailure(error, matches) {
  const seen = new Set();
  for (let depth = 0; error != null && depth < 8 && !seen.has(error); depth++) {
    seen.add(error);
    if (matches(error)) return true;
    error = typeof error === 'object' ? error.cause : undefined;
  }
  return false;
}

/** Normalize transport messages and machine codes without exposing credentials. */
function failureText(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error);
  const code = typeof error?.code === 'string' ? error.code : '';
  return `${code} ${message}`;
}

/** Distinguish account funding failures from temporary throttling. */
export function isBillingModelFailure(error) {
  return matchesFailure(error, (failure) => Number(failure?.status ?? failure?.statusCode) === 402
    || /insufficient_quota|quota_exceeded|billing_hard_limit|insufficient.{0,30}(?:balance|credit|fund)|payment.required|\[402\]|余额不足|欠费/i.test(failureText(failure)));
}

/** Credential failures cannot be repaired by another paid retry or provider group. */
export function isAuthenticationModelFailure(error) {
  return matchesFailure(error, (failure) => [401, 403].includes(Number(failure?.status ?? failure?.statusCode))
    || /^(?:AUTH|MISSING_CREDENTIAL|INVALID_API_KEY)$/i.test(failure?.code || '')
    || /\[(?:401|403)\]|\bHTTP\s+(?:401|403)\b|\binvalid_api_key\b|\bMISSING_CREDENTIAL\b/i.test(failureText(failure)));
}

/** Only temporary transport/service failures may retry the same selected model. */
export function isRetryableModelFailure(error) {
  if (isBillingModelFailure(error) || isAuthenticationModelFailure(error)) return false;
  if (matchesFailure(error, (failure) => /^(?:model_not_found|unsupported_model|EMPTY_RESPONSE)$/i.test(failure?.code || '')
    || /model.*(?:not\s+supported|not found|unsupported|unavailable)|unknown\s+model|未知模型|模型不存在|不支持的模型/i.test(failure?.message || ''))) return false;
  if (matchesFailure(error, (failure) => {
    const status = Number(failure?.status ?? failure?.statusCode);
    return (status >= 400 && status < 500 && ![408, 429].includes(status))
      || /\[(?:400|404|405|422)\]|\bHTTP\s+(?:400|404|405|422)\b/i.test(failureText(failure));
  })) return false;
  return matchesFailure(error, (failure) => {
    const status = Number(failure?.status ?? failure?.statusCode);
    return [408, 429, 500, 502, 503, 504].includes(status)
      || /^(?:TIMEOUT|TRANSPORT|SERVER|RATE_LIMIT|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/i.test(failure?.code || '')
      || /fetch failed|ECONNRESET|connection reset by peer|upstream stream disconnected|ETIMEDOUT|TimeoutError|\[(?:408|429|500|502|503|504)\]|\bHTTP\s+(?:408|429|500|502|503|504)\b/i.test(failureText(failure));
  });
}
