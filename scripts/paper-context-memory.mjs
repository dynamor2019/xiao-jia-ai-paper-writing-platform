import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Hash locally; never log message bodies or credentials. */
function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Read bounded existing state without scanning project data or creating documents. */
function readState(file) {
  try {
    if (statSync(file).size > 2 * 1024 * 1024) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Retain only source-backed navigation fields, not guessed scientific conclusions. */
export function projectMemory(agent, env = process.env) {
  const id = String(agent.id || '');
  if (!/^[\w-]{1,80}$/.test(id) || !env.PAPER_DATA_ROOT) return null;
  const stateRoot = resolve(env.PAPER_DATA_ROOT, env.PAPER_STATE_DIR || '.dsh-state');
  const runFile = join(stateRoot, 'paper-runs', `${id}.json`);
  const run = readState(runFile);
  if (!run || !isAbsolute(run.outputDir || '')) return null;
  const checkpointFile = join(run.outputDir, '.dsh-state', 'paper-pipeline-state.json');
  const checkpoint = readState(checkpointFile);
  const tasks = checkpoint?.metadata?.workflow?.tasks || {};
  return {
    project: run.outputDir, source: checkpoint ? checkpointFile : runFile,
    topic: String(checkpoint?.topic || run.topic || '').slice(0, 1000),
    stage: checkpoint?.stage || run.stage || 'unknown',
    status: run.status || 'unknown',
    tasks: Object.entries(tasks).slice(0, 30).map(([name, task]) => ({
      name, status: task?.status || 'unknown',
    })),
  };
}

/** Compare message-prefix identity, not provider cache hits or token estimates. */
export function prefixMetrics(previous = [], messages = []) {
  const hashes = messages.map(fingerprint);
  let common = 0;
  while (common < previous.length && hashes[common] === previous[common]) common++;
  return { hashes, metric: { messages: hashes.length, previousMessages: previous.length,
    sharedPrefixMessages: common, rewritten: common < previous.length } };
}

/** Token-weighted prompt-cache share for recent ordinary responses, excluding output. */
export function cacheWindowMetrics(usages, limit = 20) {
  const totals = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
  for (const usage of usages.slice(-limit)) {
    const value = key => Number.isFinite(usage[key]) && usage[key] > 0 ? usage[key] : 0;
    totals.input += value('inputTokens');
    totals.cacheRead += value('cacheReadTokens');
    totals.cacheWrite += value('cacheWriteTokens');
    totals.requests++;
  }
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  return { ...totals, prompt, hitRate: prompt ? totals.cacheRead / prompt : null };
}

/** Incrementally recover exact user corrections from the durable session log. */
function collectCorrections(session, state) {
  const events = session.snapshotEvents?.(state.seq) || [];
  for (const event of events) {
    if (event.type === 'assistant/message' && event.data?.usage) {
      const usage = event.data.usage;
      state.usage = Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
        .filter(key => Number.isFinite(usage[key])).map(key => [key, usage[key]]));
      state.usages = [...(state.usages || []), state.usage].slice(-20);
    }
    if (event.type === 'compaction/summary') state.pendingSummary = event.data.compactionId;
    if (event.type === 'compaction/end' && !event.data.error
      && event.data.compactionId === state.pendingSummary) state.summarySeq = event.seq;
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
    const text = (event.data.content || []).filter(block => block.type === 'text')
      .map(block => block.text).join('\n');
    if (!/不要|禁止|不是|纠正|改为|必须|不能|instead|do not|must not/i.test(text)) continue;
    const correction = { seq: event.seq, text: text.slice(0, 700) };
    state.corrections.push(correction);
    state.corrections = state.corrections.slice(-6);
  }
  state.seq = session.seq ?? state.seq;
}

/** Add bounded recovery context only after binding/state change or history replacement. */
export function installPaperContextMemory(ctx, options = {}) {
  const states = new WeakMap();
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || signal?.aborted || agent.session?.header?.origin === 'subagent') return decision;
    const session = agent.session;
    if (!session) return decision;
    const state = states.get(agent) || { seq: 0, corrections: [], hashes: [] };
    states.set(agent, state);
    collectCorrections(session, state);
    const messages = [...(session.deriveMessages?.() || []), ...decision.messages];
    const { hashes, metric } = prefixMetrics(state.hashes, messages);
    const generation = session.surface?.replaceGeneration ?? 0;
    const header = session.requestHeader?.();
    ctx.logger?.info?.(`Context prefix diagnostic ${JSON.stringify({ ...metric, generation,
      headerFingerprint: fingerprint(header || null), reportedUsage: state.usage || null,
      recentCache: cacheWindowMetrics(state.usages || []) })}`);
    state.hashes = hashes;
    const memory = projectMemory(agent, options.env || process.env);
    if (!memory && state.corrections.length === 0) return decision;
    const key = fingerprint(memory);
    if (state.key === key && state.summarySeq === state.memorySummarySeq) return decision;
    state.key = key;
    state.memorySummarySeq = state.summarySeq;
    const text = ['Project recovery index (state labels are not scientific evidence).',
      JSON.stringify(memory), 'Exact recent user corrections (later instructions take precedence):',
      JSON.stringify(state.corrections),
      'Read the indexed checkpoint and task-relevant original results before acting. Missing summary details do not mean missing work. Do not repeat completed work without evidence of invalidation. Never infer PASS from this index.'].join('\n');
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'paper-context-memory', form: 'notice', summary: 'Source-backed project recovery index' },
    })] };
  });
}
