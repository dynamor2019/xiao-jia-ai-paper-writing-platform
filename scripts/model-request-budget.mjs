import { isBillingModelFailure } from './model-failure-policy.mjs';

const MAX_REQUEST_ATTEMPTS = 3;

/** Count persisted failed attempts once and then read only newly appended events. */
function attemptState(states, { agent, turn, step }) {
  const previous = states.get(agent);
  const state = previous?.turn === turn && previous.step === step ? previous
    : { turn, step, count: 0, failures: 0, seq: previous?.seq || 0 };
  const events = agent.session?.snapshotEvents?.(state.seq) || [];
  state.failures += events.filter((event) => event.type === 'assistant/attempt'
    && event.data?.turn === turn && event.data?.step === step).length;
  state.count = Math.max(state.count, state.failures);
  state.seq = agent.session?.seq || state.seq;
  states.set(agent, state);
  return state;
}

/** Bound the whole recovery chain without changing providers' configured policies. */
export function installModelRequestBudget(ctx) {
  const states = new WeakMap();
  ctx.on('agent/request', async (event, next) => {
    const state = attemptState(states, event);
    if (state.count >= MAX_REQUEST_ATTEMPTS) {
      const error = new Error('Model request budget exhausted for this turn/step; no further automatic retries');
      error.code = 'MODEL_RETRY_BUDGET';
      throw error;
    }
    state.count++;
    return next();
  }, { prepend: true });
  ctx.on('agent/request-error', async (event, next) => {
    const state = attemptState(states, event);
    if (isBillingModelFailure(event.failure)
      || ['AUTH', 'MISSING_CREDENTIAL'].includes(event.failure?.code)
      || state.count >= MAX_REQUEST_ATTEMPTS) {
      ctx.logger?.warn?.('Model recovery stopped: credentials, account funding or shared attempt budget requires attention');
      // Veto the downstream waterfall, including native "always" retry policies.
      return undefined;
    }
    return next();
  }, { prepend: true });
}
