import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const name = 'paper-web-model-router';
const inject = ['llm', 'agentDefaultModel', 'credentials'];
const PROJECT_DIR = resolve(process.env.DSH_PAPER_PROJECT_DIR || String.raw`__DSH_PAPER_PROJECT_DIR__`);
const PROVIDERS = { openai: 'rayinai', claude: 'rayinai-claude', grok: 'sub2api-grok', deepseek: 'deepseek-official' };
const PROVIDER_KEYS = { rayinai: 'OPENAI_API_KEY', 'rayinai-claude': 'ANTHROPIC_API_KEY',
  'sub2api-grok': 'SUB2API_API_KEY', 'deepseek-official': 'DEEPSEEK_API_KEY' };
const TASK_PATTERNS = [
  ['citation', /引用核验|核对引用|参考文献|citation|\bdoi\b/i],
  ['quality', /审稿|论文质量|科学审查|质量门禁|peer.review|review.*paper/i],
  ['protocol', /研究方案|实验设计|识别策略|因果推断|预分析计划|research protocol|study design/i],
  ['discovery', /选题|研究方向|创新点|research topic|research direction/i],
  ['outline', /大纲|章节结构|论文结构|outline/i],
  ['coherence', /连贯性|逻辑衔接|coherence/i],
  ['polish', /润色|降重|改写|polish|paraphrase/i],
  ['summary', /文献精读|文献摘要|(?:总结|归纳).{0,12}文献|文献.{0,12}(?:总结|归纳)|summari[sz]e|literature summary/i],
  ['writing', /写论文|写段落|撰写|草稿|论文摘要|学术写作|write.*paper|draft.*section/i],
];

export function classifyWebTask(text) {
  return TASK_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}

function admittedUserText(messages) {
  return messages
    .filter((message) => message.source?.kind === 'user')
    .slice(-1)
    .flatMap((message) => message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function hasManualSelection(session, scanned) {
  if (!session?.snapshotEvents) return false;
  const previous = scanned.get(session) || { seq: 0, manual: false };
  if (previous.manual) return true;
  const events = session.snapshotEvents(previous.seq);
  const manual = events.some((event) => event.type === 'model/selection');
  scanned.set(session, { seq: session.seq, manual });
  return manual;
}

async function firstAvailableRoute(ctx, candidates, credentialRefFor) {
  const registered = ctx.get?.('llm')?.listProviders?.();
  for (const candidate of candidates) {
    const provider = PROVIDERS[candidate.provider];
    if (provider && candidate.model && await providerHasCredential(ctx, provider, credentialRefFor) && (!registered || registered.some((item) => item.id === provider))) {
      return { provider, model: candidate.model };
    }
  }
  return undefined;
}

async function providerHasCredential(ctx, provider, credentialRefFor) {
  const envName = await credentialRefFor(provider);
  if (!envName) return true;
  const credentials = ctx.get?.('credentials');
  if (credentials) return Boolean((await credentials.resolve(envName))?.value?.trim());
  return Boolean(process.env[envName]?.trim());
}

function canFailOver(failure) {
  return ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'].includes(failure?.code)
    || modelIsUnavailable(failure);
}

function modelIsUnavailable(failure) {
  return failure?.code === 'model_not_found'
    || /model.*(?:not\s+supported|not found|unsupported|unavailable)/i.test(failure?.message || '');
}

export function installWebModelRouter(ctx, routeCandidates, credentialRefFor = (provider) => PROVIDER_KEYS[provider]) {
  const activeTasks = new WeakMap();
  const scanned = new WeakMap();
  const attempted = new WeakMap();
  const recovery = new WeakMap();

  async function selectedRoute(agent, turn, step) {
    if (!agent || agent.session?.header?.origin === 'subagent' || hasManualSelection(agent.session, scanned)) return undefined;
    const task = activeTasks.get(agent)?.turn === turn ? activeTasks.get(agent).task : undefined;
    const candidates = task ? await routeCandidates(task) : [];
    const pending = recovery.get(agent);
    const route = pending?.turn === turn && pending.step === step
      ? pending.route
      : await firstAvailableRoute(ctx, candidates, credentialRefFor);
    if (!route) return undefined;
    return { task, route };
  }

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const text = admittedUserText([message]);
    if (text) activeTasks.set(agent, { turn, task: classifyWebTask(text) });
    else if (activeTasks.get(agent)?.turn !== turn) activeTasks.set(agent, { turn, task: activeTasks.get(agent)?.task });
  });

  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const text = admittedUserText(decision.messages);
    if (text) activeTasks.set(agent, { turn, task: classifyWebTask(text) });
    else if (activeTasks.get(agent)?.turn !== turn) activeTasks.set(agent, { turn, task: activeTasks.get(agent)?.task });
    return decision;
  });

  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const config = await next();
    const pending = recovery.get(agent);
    if (pending?.turn === turn && pending.step === step) {
      attempted.set(agent, { turn, step, route: pending.route });
      const { reasoningEffort: _previousEffort, ...rest } = config;
      return { ...rest, ...pending.route };
    }
    const selected = await selectedRoute(agent, turn, step);
    if (!selected) {
      const route = config;
      attempted.set(agent, { turn, step, route });
      return route;
    }
    const { task, route } = selected;
    attempted.set(agent, { turn, step, route });
    if (config.provider === route.provider && config.model === route.model) return config;
    const { reasoningEffort: _previousEffort, ...rest } = config;
    ctx.logger?.info?.(`Web 模型路由: ${task || 'default'} -> ${route.provider}/${route.model}`);
    return { ...rest, ...route };
  });

  ctx.on('agent/request-error', async ({ agent, turn, step, failure }, next) => {
    const last = attempted.get(agent);
    const task = activeTasks.get(agent)?.turn === turn ? activeTasks.get(agent).task : undefined;
    if (last?.turn !== turn || last.step !== step || !canFailOver(failure)
      || hasManualSelection(agent.session, scanned)) return next();
    const previous = recovery.get(agent);
    const visited = previous?.turn === turn && previous.step === step ? previous.visited : new Set();
    visited.add(`${last.route.provider}/${last.route.model}`);
    if (visited.size >= 3) return next();
    const candidates = task ? await routeCandidates(task) : [];
    const used = candidates.findIndex((item) => PROVIDERS[item.provider] === last.route.provider && item.model === last.route.model);
    const remaining = used < 0
      ? candidates.filter((item) => PROVIDERS[item.provider] !== last.route.provider || item.model !== last.route.model)
      : candidates.slice(used + 1);
    const fallback = await firstAvailableRoute(ctx, remaining.filter((item) =>
      !visited.has(`${PROVIDERS[item.provider]}/${item.model}`)), credentialRefFor);
    if (!fallback || (fallback.provider === last.route.provider && fallback.model === last.route.model)) return next();
    recovery.set(agent, { turn, step, route: fallback, visited });
    ctx.logger?.warn?.(`Web 模型回退: ${last.route.provider}/${last.route.model} -> ${fallback.provider}/${fallback.model}`);
    return { kind: 'retry' };
  });

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    const agent = context.agent;
    const selected = await selectedRoute(agent, activeTasks.get(agent)?.turn);
    if (!selected) return assembled;
    return { ...assembled, variables: { ...assembled.variables, ...selected.route } };
  });
}

async function apply(ctx) {
  const routeFile = join(PROJECT_DIR, 'dist', 'config', 'model-routing.js');
  if (!existsSync(routeFile)) {
    ctx.logger?.warn?.(`Web 模型路由未启用：缺少 ${routeFile}，请先运行 npm run build`);
    return;
  }
  const routing = import(pathToFileURL(routeFile).href);
  const settings = import(pathToFileURL(join(PROJECT_DIR, 'scripts', 'model-credentials.mjs')).href);
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  installWebModelRouter(ctx, async (task) => (await routing).getRouteCandidates(task), async (provider) => {
    if (provider === 'deepseek-official') return (await settings).readDeepSeekProvider(home, PROJECT_DIR).apiKeyEnv;
    const profile = (await settings).readModelProviders(home, PROJECT_DIR)[provider];
    return profile ? profile.apiKeyEnv : PROVIDER_KEYS[provider];
  });
  const budget = await import(pathToFileURL(join(PROJECT_DIR, 'scripts', 'model-request-budget.mjs')).href);
  budget.installModelRequestBudget(ctx);
}

export { name, inject, apply };
