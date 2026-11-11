import { setTimeout as delay } from 'node:timers/promises';
import { isAuthenticationModelFailure, isBillingModelFailure, isRetryableModelFailure } from './model-failure-policy.mjs';
import { installPaperContextMemory } from './paper-context-memory.mjs';
import { observeModelTransport } from './model-transport-diagnostics.mjs';

const MAX_REQUEST_ATTEMPTS = 2;
const MAX_TRANSPORT_ATTEMPTS = 3;
const LEGACY_RELAY_OUTPUT_BUDGET = 32768;
const RELAY_PROVIDERS = new Set(['rayinai', 'rayinai-claude', 'sub2api-grok']);

/** Allow a reset connection to settle; cancellation must never start another request. */
async function transportCooldown(milliseconds, signal) {
  try {
    await delay(milliseconds, undefined, { signal });
    return !signal?.aborted;
  } catch (error) {
    if (error.name === 'AbortError') return false;
    throw error;
  }
}

/** Recognize transient gateway unavailability without changing the selected route. */
function isGatewayUnavailable(error) {
  const seen = new Set();
  for (let depth = 0; error != null && depth < 8 && !seen.has(error); depth++) {
    seen.add(error);
    const status = Number(error.status ?? error.statusCode);
    const message = typeof error.message === 'string' ? error.message : '';
    if (status === 502 || /API error\s*\(502\)|\bHTTP\s+502\b|upstream service temporarily unavailable/i.test(message)) {
      return true;
    }
    error = typeof error === 'object' ? error.cause : undefined;
  }
  return false;
}

/** Recover once through native compaction; never resend an unchanged oversized request. */
async function recoverContextOverflow(ctx, event) {
  const { agent, signal } = event;
  const surface = agent.session?.surface;
  const generation = surface?.replaceGeneration;
  const compaction = agent.ctx?.get?.('compaction') ?? ctx.get?.('compaction');
  if (signal?.aborted || !Number.isInteger(generation) || !compaction?.compactIfNeeded) return undefined;
  try {
    await compaction.compactIfNeeded(agent, 'context-overflow', signal);
  } catch (error) {
    ctx.logger?.warn?.(`Context compaction recovery: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!signal?.aborted && surface.replaceGeneration > generation) return { kind: 'retry' };
  return undefined;
}

/** Count persisted failed attempts once and then read only newly appended events. */
function attemptState(states, { agent, turn, step }) {
  const previous = states.get(agent);
  const state = previous?.turn === turn && previous.step === step ? previous
    : { turn, step, count: 0, failures: 0, maxAttempts: MAX_REQUEST_ATTEMPTS, seq: previous?.seq || 0 };
  const events = agent.session?.snapshotEvents?.(state.seq) || [];
  state.failures += events.filter((event) => event.type === 'assistant/attempt'
    && event.data?.turn === turn && event.data?.step === step).length;
  state.count = Math.max(state.count, state.failures);
  state.seq = agent.session?.seq || state.seq;
  states.set(agent, state);
  return state;
}

/** Bound the whole recovery chain without changing providers' configured policies. */
export function installModelRequestBudget(ctx, options = {}) {
  installPaperContextMemory(ctx);
  ctx.effect(() => observeModelTransport(), 'model-transport-diagnostics');
  const states = new WeakMap();
  const wait = options.wait ?? transportCooldown;
  ctx.on('agent/request', async (event, next) => {
    const state = attemptState(states, event);
    if (state.count >= state.maxAttempts) {
      const error = new Error('Model request budget exhausted for this turn/step; no further automatic retries');
      error.code = 'MODEL_RETRY_BUDGET';
      throw error;
    }
    state.count++;
    const config = await next();
    state.route ||= { provider: config.provider, model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) };
    const { reasoningEffort: _previousEffort, ...base } = config;
    const request = { ...base, ...state.route };
    // Preserve the pre-upgrade default without changing model capacity or explicit caps.
    if (request.maxTokens === undefined && RELAY_PROVIDERS.has(request.provider)) {
      return { ...request, maxTokens: LEGACY_RELAY_OUTPUT_BUDGET };
    }
    return request;
  }, { prepend: true });
  ctx.on('agent/request-error', async (event, next) => {
    const state = attemptState(states, event);
    if (event.failure?.code === 'CONTEXT_WINDOW_EXCEEDED') {
      if (state.count >= MAX_REQUEST_ATTEMPTS || isBillingModelFailure(event.failure)
        || isAuthenticationModelFailure(event.failure)) return undefined;
      return recoverContextOverflow(ctx, event);
    }
    const transient = isRetryableModelFailure(event.failure);
    const transport = transient && (event.failure?.code === 'TRANSPORT' || isGatewayUnavailable(event.failure));
    if (transport) state.maxAttempts = MAX_TRANSPORT_ATTEMPTS;
    if (event.signal?.aborted || !transient || state.count >= state.maxAttempts) {
      ctx.logger?.warn?.('Model recovery stopped: non-transient failure or retry budget exhausted');
      // Veto the downstream waterfall, including native "always" retry policies.
      return undefined;
    }
    const cooldown = state.count === 1 ? 10000 : 30000;
    if (transport && !await wait(cooldown, event.signal)) return undefined;
    return next();
  }, { prepend: true });
}
