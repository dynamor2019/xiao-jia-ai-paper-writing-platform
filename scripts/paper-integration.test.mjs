import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WORKBENCH_STAGE_LABELS, prepareProjectInput } from '../config/dsh/web/paper-command.js';
import { classifyWebTask, installWebModelRouter } from '../config/dsh/web/model-router.js';
import { PaperPipeline, PIPELINE_STAGES } from '../src/workflows/paper-pipeline.ts';
import { resolvePaperModelEnv } from './paper-model-env.mjs';

test('workbench stages match the pipeline contract', () => {
  assert.deepEqual(WORKBENCH_STAGE_LABELS.map(([id]) => id), PIPELINE_STAGES);
});

test('Web requests use task routes while explicit model selection stays in control', async () => {
  const handlers = new Map();
  const events = [];
  const session = {
    header: {},
    get seq() { return events.length; },
    snapshotEvents(from) { return events.slice(from); },
  };
  const agent = { session };
  const ctx = {
    on: (event, handler) => handlers.set(event, handler),
    get: (service) => service === 'llm' ? { listProviders: () => [{ id: 'rayinai' }, { id: 'rayinai-claude' }] } : undefined,
    logger: { info: () => {} },
  };
  const routes = {
    summary: [{ provider: 'openai', model: 'gpt-5.6-luna' }],
    protocol: [{ provider: 'claude', model: 'claude-opus-5' }, { provider: 'openai', model: 'gpt-5.6-sol' }],
  };
  installWebModelRouter(ctx, async (task) => routes[task] || []);
  const enter = async (text, turn) => handlers.get('agent/pre-step')({ agent, turn }, async () => ({
    kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  }));
  const request = async (turn, config = { provider: 'rayinai', model: 'gpt-5.6-terra' }) =>
    handlers.get('agent/request')({ agent, turn, step: 1 }, async () => config);

  assert.equal(classifyWebTask('请总结这篇文献'), 'summary');
  await enter('请总结这篇文献', 1);
  assert.deepEqual(await request(1), { provider: 'rayinai', model: 'gpt-5.6-luna' });
  handlers.get('agent/inbox/claimed')({
    agent, turn: 2,
    message: { source: { kind: 'user' }, content: [{ type: 'text', text: '请设计研究方案' }] },
  });
  const prompt = await handlers.get('system-prompt/assemble')({}, { agent }, async () => ({ variables: { model: 'gpt-5.6-terra' } }));
  assert.equal(prompt.variables.model, 'claude-opus-5');
  await enter('请设计研究方案', 2);
  assert.deepEqual(await request(2), { provider: 'rayinai-claude', model: 'claude-opus-5' });
  const retry = await handlers.get('agent/request-error')({ agent, turn: 2, step: 1, failure: { code: 'SERVER' } }, async () => undefined);
  assert.deepEqual(retry, { kind: 'retry' });
  assert.deepEqual(await handlers.get('agent/request')({ agent, turn: 2, step: 1 }, async () => ({
    provider: 'rayinai-claude', model: 'claude-opus-5',
  })), { provider: 'rayinai', model: 'gpt-5.6-sol' });
  const noSecondRetry = await handlers.get('agent/request-error')({ agent, turn: 2, step: 1, failure: { code: 'SERVER' } }, async () => undefined);
  assert.equal(noSecondRetry, undefined);
  events.push({ type: 'model/selection' });
  assert.deepEqual(await request(2, { provider: 'rayinai', model: 'gpt-5.6-sol' }), {
    provider: 'rayinai', model: 'gpt-5.6-sol',
  });
});

test('Web routing uses the configured fallback when a provider is unavailable', async () => {
  const handlers = new Map();
  const session = { header: {}, seq: 0, snapshotEvents: () => [] };
  const agent = { session };
  installWebModelRouter({
    on: (event, handler) => handlers.set(event, handler),
    get: () => ({ listProviders: () => [{ id: 'rayinai' }] }),
    logger: { info: () => {} },
  }, async () => [
    { provider: 'claude', model: 'claude-opus-5' },
    { provider: 'openai', model: 'gpt-5.6-sol' },
  ]);
  await handlers.get('agent/pre-step')({ agent, turn: 1 }, async () => ({
    kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '设计研究方案' }] }],
  }));
  const route = await handlers.get('agent/request')({ agent, turn: 1 }, async () => ({ provider: 'rayinai', model: 'gpt-5.6-terra' }));
  assert.deepEqual(route, { provider: 'rayinai', model: 'gpt-5.6-sol' });
});

test('selected DID method requires empirical evidence and blocks changed evidence before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-empirical-gate-'));
  try {
    const stateDir = join(root, '.dsh-state');
    const milestoneDir = join(root, 'milestones');
    const reproducibilityDir = join(milestoneDir, 'reproducibility');
    await mkdir(stateDir, { recursive: true });
    await mkdir(reproducibilityDir, { recursive: true });
    await writeFile(join(stateDir, 'topic-discovery.json'), JSON.stringify({ selected: { method: 'staggered DID' } }));
    const results = join(root, 'results.csv');
    const resultContent = 'run_id,score\n1,0.5\n2,0.7\n3,0.9\n';
    await writeFile(results, resultContent);
    const resultSha256 = createHash('sha256').update(resultContent).digest('hex');
    const evidenceRef = async (name, content) => {
      await writeFile(join(reproducibilityDir, name), content);
      return { file: name, sha256: createHash('sha256').update(content).digest('hex') };
    };
    const strategy = await evidenceRef('strategy.md', '# Identification strategy\n');
    const pap = await evidenceRef('pap.json', '{"design":"did"}\n');
    const table = await evidenceRef('table2.csv', 'model,estimate\nm1,0.5\n');
    const figure = await evidenceRef('figure2.txt', 'event-study evidence');
    const manifest = join(reproducibilityDir, 'empirical-manifest.json');
    const manifestContent = JSON.stringify({
      design: 'did', resultSha256,
      evidence: { strategy, pap },
      tables: { table2_main: table },
      figures: { fig2_event_study: figure },
    });
    await writeFile(manifest, manifestContent);
    await writeFile(join(milestoneDir, 'data-validation.json'), JSON.stringify({
      status: 'PASS', sha256: resultSha256,
      empiricalManifestSha256: createHash('sha256').update(manifestContent).digest('hex'),
    }));
    await writeFile(join(reproducibilityDir, 'result-provenance.tsv'), 'claim\tstatus\nC1\tVERIFIED\n');
    const pipeline = new PaperPipeline('Housing prices', undefined, { outputDir: root, resultsFile: results });
    assert.equal(pipeline.isEmpiricalProject(), true);
    assert.match(await pipeline.loadValidatedResultEvidence(), /run_id,score/);
    await writeFile(join(reproducibilityDir, 'strategy.md'), '# Changed strategy\n');
    await assert.rejects(pipeline.loadValidatedResultEvidence(), /empirical-strategy/);
    await writeFile(join(reproducibilityDir, 'strategy.md'), '# Identification strategy\n');
    await writeFile(manifest, `${manifestContent}\n`);
    await assert.rejects(pipeline.loadValidatedResultEvidence(), /实证清单在数据验收后发生变化/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('paper inputs stay in their own project directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-input-'));
  try {
    const source = join(root, 'reference.pdf');
    await writeFile(source, 'sample A');
    const first = await prepareProjectInput(join(root, 'paper-a'), source);
    await writeFile(source, 'sample B');
    const second = await prepareProjectInput(join(root, 'paper-b'), source);
    assert.equal(await readFile(join(first, 'reference.pdf'), 'utf8'), 'sample A');
    assert.equal(await readFile(join(second, 'reference.pdf'), 'utf8'), 'sample B');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('paper model settings use Web credentials when env keys are absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-model-env-'));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    rayinai:\n      apiKeyEnv: WEB_OPENAI_KEY\n      baseURL: https://proxy.example/v1\n      api: openai-responses\n    rayinai-claude:\n      apiKeyEnv: WEB_CLAUDE_KEY\n      baseURL: https://proxy.example/v1\n      api: openai-completions\n');
    await writeFile(join(root, '.credentials.yaml'), 'refs:\n  WEB_OPENAI_KEY: web-openai-secret\n  WEB_CLAUDE_KEY: web-claude-secret\n');
    const fromWeb = resolvePaperModelEnv({}, root);
    assert.equal(fromWeb.OPENAI_API_KEY, 'web-openai-secret');
    assert.equal(fromWeb.ANTHROPIC_API_KEY, 'web-claude-secret');
    assert.equal(fromWeb.ANTHROPIC_API_MODE, 'openai-completions');
    const fromEnv = resolvePaperModelEnv({ OPENAI_API_KEY: 'env-secret', OPENAI_BASE_URL: 'https://official.example/v1' }, root);
    assert.equal(fromEnv.OPENAI_API_KEY, 'env-secret');
    assert.equal(fromEnv.OPENAI_BASE_URL, 'https://official.example/v1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a CLI project can be attached to a Web session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-attach-'));
  const previousRoot = process.env.PAPER_DATA_ROOT;
  const previousProject = process.env.DSH_PAPER_PROJECT_DIR;
  try {
    process.env.PAPER_DATA_ROOT = root;
    process.env.DSH_PAPER_PROJECT_DIR = root;
    const projectDir = join(root, 'output', 'paper-projects', 'paper-cli-1');
    await mkdir(join(projectDir, '.dsh-state'), { recursive: true });
    await writeFile(join(projectDir, '.dsh-state', 'paper-pipeline-state.json'), JSON.stringify({
      topic: 'Sample topic', stage: 'literature-search', metadata: { paperProjectId: 'paper-cli-1' },
    }));
    const { apply } = await import(`../config/dsh/web/paper-command.js?attach=${Date.now()}`);
    const commands = new Map();
    apply({
      commands: { register: (command) => commands.set(command.name, command) },
      goals: { get: () => undefined },
      systemPrompt: { context: () => {} },
      effect: () => {},
    });
    const result = await commands.get('paper-attach').handler({ rawInput: 'paper-cli-1', agent: { id: 'session-one' } });
    assert.equal(result.kind, 'success');
    const state = JSON.parse(await readFile(join(root, '.dsh-state', 'paper-runs', 'session-one.json'), 'utf8'));
    assert.equal(state.paperProjectId, 'paper-cli-1');
    assert.equal(state.outputDir, projectDir);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
    if (previousProject === undefined) delete process.env.DSH_PAPER_PROJECT_DIR;
    else process.env.DSH_PAPER_PROJECT_DIR = previousProject;
    await rm(root, { recursive: true, force: true });
  }
});

test('a running CLI project stays running when attached to Web', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-active-'));
  const previousRoot = process.env.PAPER_DATA_ROOT;
  const previousProject = process.env.DSH_PAPER_PROJECT_DIR;
  try {
    process.env.PAPER_DATA_ROOT = root;
    process.env.DSH_PAPER_PROJECT_DIR = root;
    const projectDir = join(root, 'output', 'paper-projects', 'paper-cli-active');
    await mkdir(join(projectDir, '.dsh-state'), { recursive: true });
    await writeFile(join(projectDir, '.dsh-state', 'paper-pipeline-state.json'), JSON.stringify({
      topic: 'Active topic', stage: 'literature-search', metadata: { paperProjectId: 'paper-cli-active' },
    }));
    await writeFile(join(projectDir, '.dsh-state', 'paper-pipeline.lock.json'), JSON.stringify({ pid: process.pid }));
    const { apply } = await import(`../config/dsh/web/paper-command.js?active=${Date.now()}`);
    const commands = new Map();
    const contexts = new Map();
    apply({
      commands: { register: (command) => commands.set(command.name, command) },
      goals: { get: () => undefined },
      systemPrompt: { context: (context) => contexts.set(context.name, context) },
      effect: () => {},
    });
    const agent = { id: 'session-active' };
    const result = await commands.get('paper-attach').handler({ rawInput: 'paper-cli-active', agent });
    assert.equal(result.kind, 'success');
    const state = JSON.parse(await readFile(join(root, '.dsh-state', 'paper-runs', 'session-active.json'), 'utf8'));
    assert.equal(state.status, 'running');
    assert.equal(state.pid, process.pid);
    assert.match(contexts.get('paper:active-project').text({ agent }), /paper-cli-active/);
    const resume = await commands.get('paper-resume').handler({ agent });
    assert.match(resume.text, /正在进程/);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
    if (previousProject === undefined) delete process.env.DSH_PAPER_PROJECT_DIR;
    else process.env.DSH_PAPER_PROJECT_DIR = previousProject;
    await rm(root, { recursive: true, force: true });
  }
});

test('a paper project rejects a second writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-lock-'));
  try {
    const stateDir = join(root, '.dsh-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'paper-pipeline.lock.json'), JSON.stringify({ pid: process.pid }));
    const pipeline = new PaperPipeline('Lock test', undefined, { outputDir: root });
    await assert.rejects(pipeline.run(), /正由进程/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale paper project lock can be reclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-stale-lock-'));
  try {
    const stateDir = join(root, '.dsh-state');
    const lockPath = join(stateDir, 'paper-pipeline.lock.json');
    await mkdir(stateDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647 }));
    const pipeline = new PaperPipeline('Stale lock test', undefined, { outputDir: root });
    const release = pipeline.acquireProjectLock();
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
    release();
    await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
