/** Honor an explicitly configured protocol before legacy model-name discovery. */
export function usesResponsesProtocol(model: string, env: NodeJS.ProcessEnv): boolean {
  const mode = env.OPENAI_API_MODE?.trim().toLowerCase();
  if (mode === 'openai-responses' || mode === 'responses') return true;
  if (mode === 'openai-completions' || mode === 'openai') return false;
  if (mode) throw new Error(`Unsupported OPENAI_API_MODE: ${mode}`);
  if (env.OPENAI_USE_RESPONSES_API === 'true') return true;
  if (env.OPENAI_USE_RESPONSES_API === 'false') return false;
  return /^gpt-(?:5|6)(?:[.-]|$)/i.test(model);
}

/** Bound retries even when callers supply NaN, Infinity or oversized settings. */
export function boundedModelAttempts(value: number): number {
  return Number.isFinite(value) ? Math.min(3, Math.max(1, Math.floor(value))) : 1;
}

export { isBillingModelFailure } from '../../scripts/model-failure-policy.mjs';
