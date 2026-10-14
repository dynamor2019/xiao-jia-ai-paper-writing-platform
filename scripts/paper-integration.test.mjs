import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Script } from 'node:vm';

import { WORKBENCH_STAGE_LABELS, prepareProjectInput, resolveApprovalMode, resolveExperimentConfiguration, validateApprovalStage } from '../config/dsh/web/paper-command.js';
import { classifyWebTask, inject as webRouterInject, installWebModelRouter } from '../config/dsh/web/model-router.js';
import { buildMarkdown } from '../src/plugins/export/docx-exporter.ts';
import { verifyCitations } from '../src/plugins/verification/citation-verifier.ts';
import { PaperPipeline, PIPELINE_STAGES, refreshCitationContexts, renderArgumentBlueprint } from '../src/workflows/paper-pipeline.ts';
import { resolvePaperModelEnv } from './paper-model-env.mjs';
import { isRecoverablePaperFailure, resolveMaxRecoveries } from './paper-retry-policy.mjs';
import { patchModelLatency } from './patch-dsh-model-catalog.mjs';

test('Web model router declares the services read by its request handlers', () => {
  assert.deepEqual(webRouterInject, ['llm', 'agentDefaultModel']);
});

test('paper background retries are bounded to prevent repeated upstream call costs', () => {
  assert.equal(resolveMaxRecoveries(undefined), 3);
  assert.equal(resolveMaxRecoveries(''), 3);
  assert.equal(resolveMaxRecoveries('0'), 0);
  assert.equal(resolveMaxRecoveries('2'), 2);
  assert.equal(resolveMaxRecoveries('72'), 3);
  assert.equal(resolveMaxRecoveries('-1'), 3);
  assert.equal(resolveMaxRecoveries('invalid'), 3);
});

test('paper background honors pipeline decisions to stop paid retries', () => {
  assert.equal(isRecoverablePaperFailure('Connection error: ECONNRESET'), true);
  assert.equal(isRecoverablePaperFailure('HTTP 503 Service temporarily unavailable'), true);
  assert.equal(isRecoverablePaperFailure('中转站上游暂不可用；为避免重复计费，已停止自动重试。稍后手动继续即可。'), false);
});

test('core academic skills are committed with the project runtime', async () => {
  const skills = await readdir(join(process.cwd(), '.dsh', 'skills'));
  const requiredSkills = [
    'academic-paper-quality-gates',
    'claude-academic-writer',
    'literature-search',
    'peer-review',
    'reference-verifier',
  ];
  for (const skill of requiredSkills) {
    assert.ok(skills.includes(skill), `missing project skill: ${skill}`);
  }
});

test('workbench stages match the pipeline contract', () => {
  assert.deepEqual(WORKBENCH_STAGE_LABELS.map(([id]) => id), PIPELINE_STAGES);
});

test('unbound research tasks are routed from conversation context without asking the user to invoke commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-autonomy-'));
  const previousRoot = process.env.PAPER_DATA_ROOT;
  const previousProject = process.env.DSH_PAPER_PROJECT_DIR;
  try {
    process.env.PAPER_DATA_ROOT = root;
    process.env.DSH_PAPER_PROJECT_DIR = root;
    const { apply, inject } = await import(`../config/dsh/web/paper-command.js?autonomy=${Date.now()}`);
    const commands = new Map();
    const contexts = new Map();
    const tools = new Map();
    apply({
      commands: { register: (command) => commands.set(command.name, command) },
      tools: { register: (tool) => tools.set(tool.name, tool) },
      goals: { get: () => undefined },
      systemPrompt: { context: (context) => contexts.set(context.name, context) },
      effect: () => {},
    });

    const instruction = contexts.get('paper:active-project').text({ agent: { id: 'session-one' } });
    assert.match(instruction, /只有用户明确要求写论文时才调用 start_paper_workflow/);
    assert.match(instruction, /其他对话不要注入论文流程/);
    assert.match(commands.get('paper').input.hint, /--output-dir/);
    assert.ok(tools.has('start_paper_workflow'));
    assert.ok(tools.has('continue_paper_workflow'));
    assert.ok(inject.includes('tools'));
    assert.match(instruction, /start_paper_workflow/);
    const deniedApproval = await tools.get('continue_paper_workflow').execute(
      { action: 'confirm', userConfirmed: false },
      { agent: { id: 'session-one' } },
    );
    assert.match(deniedApproval, /需要用户明确确认/);

    const runDir = join(root, '.dsh-state', 'paper-runs');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'session-bound.json'), JSON.stringify({
      outputDir: join(root, 'output', 'paper-projects', 'paper-session-bound'),
      paperProjectId: 'paper-session-bound',
    }));
    const boundInstruction = contexts.get('paper:active-project').text({ agent: { id: 'session-bound' } });
    assert.match(boundInstruction, /continue_paper_workflow/);
    assert.match(boundInstruction, /不要另跑 npm run paper/);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
    if (previousProject === undefined) delete process.env.DSH_PAPER_PROJECT_DIR;
    else process.env.DSH_PAPER_PROJECT_DIR = previousProject;
    await rm(root, { recursive: true, force: true });
  }
});

test('paper pipeline rejects an explicit project directory outside the output root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-output-boundary-'));
  const outside = await mkdtemp(join(tmpdir(), 'xiaojia-paper-outside-'));
  const previousRoot = process.env.PAPER_DATA_ROOT;
  const previousProject = process.env.DSH_PAPER_PROJECT_DIR;
  try {
    process.env.PAPER_DATA_ROOT = root;
    process.env.DSH_PAPER_PROJECT_DIR = root;
    const { apply } = await import(`../config/dsh/web/paper-command.js?output-boundary=${Date.now()}`);
    const commands = new Map();
    apply({
      commands: { register: (command) => commands.set(command.name, command) },
      tools: { register: () => {} },
      goals: { get: () => undefined },
      systemPrompt: { context: () => {} },
      effect: () => {},
    });

    const result = await commands.get('paper').handler({
      rawInput: `Research topic --output-dir "${outside}"`,
      agent: { id: 'session-boundary' },
    });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /必须位于论文输出根目录内/);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
    if (previousProject === undefined) delete process.env.DSH_PAPER_PROJECT_DIR;
    else process.env.DSH_PAPER_PROJECT_DIR = previousProject;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('paper pipeline binds an explicit project directory and leaves existing files intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-explicit-output-'));
  const previousRoot = process.env.PAPER_DATA_ROOT;
  const previousProject = process.env.DSH_PAPER_PROJECT_DIR;
  const outputDir = join(root, 'output', 'papers', 'existing-project');
  const existingFile = join(outputDir, 'existing-notes.md');
  try {
    process.env.PAPER_DATA_ROOT = root;
    process.env.DSH_PAPER_PROJECT_DIR = root;
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(root, 'scripts', 'paper-background-runner.mjs'), 'process.exit(0);\n');
    await writeFile(existingFile, '# Existing research notes\n');
    const { apply } = await import(`../config/dsh/web/paper-command.js?explicit-output=${Date.now()}`);
    const commands = new Map();
    const tools = new Map();
    apply({
      commands: { register: (command) => commands.set(command.name, command) },
      tools: { register: (tool) => tools.set(tool.name, tool) },
      goals: { get: () => undefined },
      systemPrompt: { context: () => {} },
      effect: () => {},
    });

    const result = await tools.get('start_paper_workflow').execute({ topic: 'Research topic', outputDir }, { agent: { id: 'session-explicit-output' } });
    const statePath = join(root, '.dsh-state', 'paper-runs', 'session-explicit-output.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.match(result, /论文研究生命周期已启动/);
    assert.equal(state.outputDir, outputDir);
    assert.match(result, new RegExp(outputDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await readFile(existingFile, 'utf8'), '# Existing research notes\n');
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const check = () => {
        try {
          process.kill(state.pid, 0);
          if (Date.now() >= deadline) reject(new Error('paper runner did not exit'));
          else setTimeout(check, 25);
        } catch {
          resolve();
        }
      };
      check();
    });
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
    if (previousProject === undefined) delete process.env.DSH_PAPER_PROJECT_DIR;
    else process.env.DSH_PAPER_PROJECT_DIR = previousProject;
    await rm(root, { recursive: true, force: true });
  }
});

test('paper artifact listing excludes archived and superseded files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-artifact-archive-'));
  const outputDir = join(root, 'output', 'paper-projects', 'paper-session-artifact-archive');
  const runDir = join(root, '.dsh-state', 'paper-runs');
  const previousRoot = process.env.PAPER_DATA_ROOT;
  const previousProject = process.env.DSH_PAPER_PROJECT_DIR;
  try {
    process.env.PAPER_DATA_ROOT = root;
    process.env.DSH_PAPER_PROJECT_DIR = root;
    await mkdir(join(outputDir, 'ARCHIVE_WORK_FILES'), { recursive: true });
    await mkdir(join(outputDir, 'milestones', 'reproducibility', 'results', 'superseded'), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(outputDir, 'manuscript.md'), 'current manuscript');
    await writeFile(join(outputDir, 'ARCHIVE_WORK_FILES', 'old-manuscript.md'), 'archived manuscript');
    await writeFile(join(outputDir, 'milestones', 'reproducibility', 'results', 'superseded', 'old-result.json'), '{}');
    await writeFile(join(runDir, 'session-artifact-archive.json'), JSON.stringify({ outputDir }));

    const { apply } = await import(`../config/dsh/web/paper-command.js?artifact-archive=${Date.now()}`);
    const commands = new Map();
    apply({
      commands: { register: (command) => commands.set(command.name, command) },
      tools: { register: () => {} },
      goals: { get: () => undefined },
      systemPrompt: { context: () => {} },
      effect: () => {},
    });

    const result = await commands.get('paper-artifacts').handler({ agent: { id: 'session-artifact-archive' } });
    assert.match(result.text, /manuscript\.md/);
    assert.doesNotMatch(result.text, /old-manuscript|old-result/);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
    if (previousProject === undefined) delete process.env.DSH_PAPER_PROJECT_DIR;
    else process.env.DSH_PAPER_PROJECT_DIR = previousProject;
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow continuation reconciles stale Web state and resumes the same failed checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-reconcile-'));
  const outputDir = join(root, 'output', 'paper-projects', 'paper-session-recovery');
  const runDir = join(root, '.dsh-state', 'paper-runs');
  const previousRoot = process.env.PAPER_DATA_ROOT;
  const previousProject = process.env.DSH_PAPER_PROJECT_DIR;
  try {
    process.env.PAPER_DATA_ROOT = root;
    process.env.DSH_PAPER_PROJECT_DIR = root;
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(outputDir, '.dsh-state'), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(root, 'scripts', 'paper-background-runner.mjs'), 'process.exit(0);\n');
    await writeFile(join(outputDir, '.dsh-state', 'paper-pipeline-state.json'), JSON.stringify({ topic: 'Recovery topic', stage: 'protocol-design', metadata: {} }));
    await writeFile(join(runDir, 'session-recovery.json'), JSON.stringify({
      topic: 'Recovery topic',
      outputDir,
      paperProjectId: 'paper-session-recovery',
      status: 'awaiting-confirmation',
      stage: 'topic-confirmation',
      approvalMode: 'topic',
      researchDirection: {},
    }));
    const { apply } = await import(`../config/dsh/web/paper-command.js?reconcile=${Date.now()}`);
    const tools = new Map();
    const commands = new Map();
    apply({
      commands: { register: (command) => commands.set(command.name, command) },
      tools: { register: (tool) => tools.set(tool.name, tool) },
      goals: { get: () => undefined },
      systemPrompt: { context: () => {} },
      effect: () => {},
    });

    const workbench = await commands.get('paper-workbench').handler({ agent: { id: 'session-recovery' } });
    assert.match(workbench.text, /当前阶段: protocol-design/);
    assert.match(workbench.text, /后台流水线: 已失败/);
    const staleStatus = await commands.get('paper-status').handler({ agent: { id: 'session-recovery' } });
    assert.match(staleStatus.text, /后台流水线: 已失败/);
    assert.match(staleStatus.text, /当前阶段: protocol-design/);

    const result = await tools.get('continue_paper_workflow').execute({ action: 'resume' }, { agent: { id: 'session-recovery' } });
    const state = JSON.parse(await readFile(join(runDir, 'session-recovery.json'), 'utf8'));
    assert.match(result, /protocol-design 检查点恢复/);
    assert.equal(state.status, 'running');
    assert.equal(state.stage, 'starting');
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const check = () => {
        try {
          process.kill(state.pid, 0);
          if (Date.now() >= deadline) reject(new Error('paper runner did not exit'));
          else setTimeout(check, 25);
        } catch {
          resolve();
        }
      };
      check();
    });
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
    if (previousProject === undefined) delete process.env.DSH_PAPER_PROJECT_DIR;
    else process.env.DSH_PAPER_PROJECT_DIR = previousProject;
    await rm(root, { recursive: true, force: true });
  }
});

test('Web requests use task routes while explicit model selection stays in control', async () => {
  const saved = saveEnv(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
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

  try {
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
  } finally {
    restoreSavedEnv(saved);
  }
});

test('Web routing uses the configured fallback when a provider is unavailable', async () => {
  const saved = saveEnv(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  const handlers = new Map();
  const session = { header: {}, seq: 0, snapshotEvents: () => [] };
  const agent = { session };
  try {
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
  } finally {
    restoreSavedEnv(saved);
  }
});

test('Web routing does not force RayinAI when its credential is absent', async () => {
  const saved = saveEnv(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const handlers = new Map();
  const agent = { session: { header: {}, seq: 0, snapshotEvents: () => [] } };
  try {
    installWebModelRouter({
      on: (event, handler) => handlers.set(event, handler),
      get: () => ({ listProviders: () => [{ id: 'rayinai' }, { id: 'rayinai-claude' }] }),
      logger: { info: () => {} },
    }, async () => [{ provider: 'openai', model: 'gpt-5.6-sol' }]);
    await handlers.get('agent/pre-step')({ agent, turn: 1 }, async () => ({
      kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '写论文摘要' }] }],
    }));
    const config = { provider: 'deepseek', model: 'deepseek-v4-flash' };
    assert.deepEqual(await handlers.get('agent/request')({ agent, turn: 1 }, async () => config), config);
  } finally {
    restoreSavedEnv(saved);
  }
});

test('Web routing keeps a selected provider when the key is not in process.env', async () => {
  const saved = saveEnv(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const handlers = new Map();
  const agent = {
    session: { header: {}, seq: 1, snapshotEvents: () => [{ type: 'model/selection' }] },
  };
  try {
    installWebModelRouter({
      on: (event, handler) => handlers.set(event, handler),
      get: () => ({ listProviders: () => [{ id: 'rayinai' }, { id: 'rayinai-claude' }] }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) },
      logger: { warn: () => {} },
    }, async () => []);
    const route = await handlers.get('agent/request')({ agent, turn: 1 }, async () => ({
      provider: 'rayinai-claude', model: 'claude-sonnet-5-5', reasoningEffort: 'high',
    }));
    assert.deepEqual(route, { provider: 'rayinai-claude', model: 'claude-sonnet-5', reasoningEffort: 'high' });
  } finally {
    restoreSavedEnv(saved);
  }
});

test('Web routing preserves an explicit model when no configured fallback exists', async () => {
  const saved = saveEnv(['OPENAI_API_KEY']);
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const handlers = new Map();
  const agent = {
    session: { header: {}, seq: 1, snapshotEvents: () => [{ type: 'model/selection' }] },
  };
  try {
    installWebModelRouter({
      on: (event, handler) => handlers.set(event, handler),
      get: () => ({ listProviders: () => [{ id: 'rayinai' }] }),
      logger: { warn: () => {} },
    }, async () => []);
    const request = () => handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => ({
      provider: 'rayinai', model: 'gpt-5.6-terra', reasoningEffort: 'high',
    }));
    assert.equal((await request()).model, 'gpt-5.6-terra');
    const retry = await handlers.get('agent/request-error')({
      agent, turn: 1, step: 1,
      failure: { code: 'PI_AI_ERROR', message: 'Model "gpt-5.6-terra" is not supported by any configured account in this group' },
    }, async () => undefined);
    assert.equal(retry, undefined);
    assert.deepEqual(await request(), { provider: 'rayinai', model: 'gpt-5.6-terra', reasoningEffort: 'high' });
  } finally {
    restoreSavedEnv(saved);
  }
});

test('Web routing skips a rejected task model when the old session selected it', async () => {
  const saved = saveEnv(['OPENAI_API_KEY']);
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const handlers = new Map();
  const agent = {
    session: { header: {}, seq: 1, snapshotEvents: () => [{ type: 'model/selection' }] },
  };
  try {
    installWebModelRouter({
      on: (event, handler) => handlers.set(event, handler),
      get: () => ({ listProviders: () => [{ id: 'rayinai' }] }),
      logger: { warn: () => {} },
    }, async () => [
      { provider: 'openai', model: 'gpt-5.6-terra' },
      { provider: 'openai', model: 'gpt-5.6-sol' },
    ]);
    handlers.get('agent/inbox/claimed')({
      agent, turn: 1,
      message: { source: { kind: 'user' }, content: [{ type: 'text', text: '写论文' }] },
    });
    const request = () => handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => ({
      provider: 'rayinai', model: 'gpt-5.6-terra',
    }));
    await request();
    const retry = await handlers.get('agent/request-error')({
      agent, turn: 1, step: 1,
      failure: { code: 'PI_AI_ERROR', message: 'Model "gpt-5.6-terra" is not supported' },
    }, async () => undefined);
    assert.deepEqual(retry, { kind: 'retry' });
    assert.deepEqual(await request(), { provider: 'rayinai', model: 'gpt-5.6-sol' });
  } finally {
    restoreSavedEnv(saved);
  }
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

test('citation verification fails closed and preserves every citation', async () => {
  const originalFetch = globalThis.fetch;
  const saved = saveEnv([
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MODEL_MIN_INTERVAL_MS', 'MODEL_STRICT_OUTPUT',
    'ROUTE_CITATION_PROVIDER', 'ROUTE_CITATION_MODEL',
  ]);
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = 'https://proxy.invalid/v1';
  process.env.MODEL_MIN_INTERVAL_MS = '0';
  process.env.MODEL_STRICT_OUTPUT = 'false';
  process.env.ROUTE_CITATION_PROVIDER = 'openai';
  process.env.ROUTE_CITATION_MODEL = 'gpt-5-test';
  globalThis.fetch = async () => Response.json({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });

  try {
    const result = await verifyCitations([{
      id: 's1',
      nodeId: 'n1',
      title: 'Findings',
      content: 'Supported claim [1]. Unsupported claim [2].',
      citations: [
        { paperId: 'p1', marker: '[1]', verified: false, rawText: 'Supported claim [1].' },
        { paperId: 'missing', marker: '[2]', verified: false, rawText: 'Unsupported claim [2].' },
      ],
      wordCount: 4,
      status: 'completed',
    }], [{
      id: 'p1',
      title: 'Known paper',
      authors: [],
      year: new Date().getFullYear(),
      abstract: 'The known paper discusses only the supported claim.',
      source: 'manual',
    }], new Map());
    assert.equal(result.success, true);
    assert.equal(result.data.length, 2);
    assert.equal(result.data[0].status, 'needs-review');
    assert.equal(result.data[1].status, 'not-found');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSavedEnv(saved);
  }
});

test('final citation binding rejects untracked markers and refreshes citation sentences', () => {
  const refreshed = refreshCitationContexts([{
    id: 's1',
    nodeId: '1',
    title: 'Evidence',
    content: '旧句子被改掉。新的终稿主张由文献支持 [3]。',
    citations: [{ paperId: 'p3', marker: '[3]', verified: true, rawText: '旧句子 [3]。' }],
    wordCount: 12,
    status: 'completed',
  }]);
  assert.equal(refreshed[0].citations[0].verified, false);
  assert.equal(refreshed[0].citations[0].rawText, '新的终稿主张由文献支持 [3]。');
  assert.throws(() => refreshCitationContexts([{
    ...refreshed[0],
    content: '新的终稿主张由文献支持 [3]。额外引用 [9]。',
  }]), /未绑定文献库/);
});

test('docx markdown export renumbers body citations to match the bibliography', () => {
  const papers = [
    { id: 'p1', title: 'Unused', authors: ['A'], year: 2020, abstract: '', source: 'manual' },
    { id: 'p2', title: 'Used Second', authors: ['B'], year: 2021, abstract: '', source: 'manual' },
    { id: 'p3', title: 'Used Third', authors: ['C'], year: 2022, abstract: '', source: 'manual' },
  ];
  const markdown = buildMarkdown([{
    id: 's1',
    nodeId: '1',
    title: 'Evidence',
    content: 'First claim [3]. Second claim [2].',
    citations: [
      { paperId: 'p3', marker: '[3]', verified: true, rawText: 'First claim [3].' },
      { paperId: 'p2', marker: '[2]', verified: true, rawText: 'Second claim [2].' },
    ],
    wordCount: 6,
    status: 'completed',
  }], papers, { title: 'T' });
  assert.match(markdown, /First claim \[2\]\. Second claim \[1\]\./);
  assert.match(markdown, /\[1\] B\. Used Second\[J\]\. 2021\./);
  assert.match(markdown, /\[2\] C\. Used Third\[J\]\. 2022\./);
});

test('approval validator accepts generated review artifacts only when present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-approval-gate-'));
  try {
    await mkdir(join(root, 'milestones'), { recursive: true });
    assert.match(validateApprovalStage(root, { topic: 'T' }, 'protocol-design'), /缺少冻结研究方案/);
    await writeFile(join(root, 'milestones', 'analysis-plan.md'), '# Plan\n');
    assert.equal(validateApprovalStage(root, { topic: 'T' }, 'protocol-design'), '');
    assert.match(validateApprovalStage(root, { topic: 'T' }, 'outline-generation'), /缺少论文大纲/);
    const outline = { nodes: [{ id: '1', title: 'Claim', argument: 'A bounded claim', supportingPapers: ['p1'], estimatedWords: 100 }] };
    const pipeline = { topic: 'T', outline };
    assert.match(validateApprovalStage(root, pipeline, 'outline-generation'), /缺少论证蓝图/);
    const blueprint = renderArgumentBlueprint('T', outline);
    assert.match(blueprint, /A bounded claim/);
    assert.match(blueprint, /p1/);
    await writeFile(join(root, 'milestones', 'argument-blueprint.md'), blueprint);
    assert.match(validateApprovalStage(root, pipeline, 'outline-generation'), /中心回答（作者确认）/);
    assert.equal(validateApprovalStage(root, pipeline, 'outline-generation', 'topic'), '');
    const approvedBlueprint = blueprint
      .replace('[待作者填写：用一至两句直接回答研究问题，明确结论范围。]', '在本研究范围内，政策暴露与结果改善相关。')
      .replace('[待作者填写：主要替代解释、结论边界与不确定性；如不适用，请说明原因。]', '可能的替代解释是同期冲击；结论不外推到未观察地区。');
    await writeFile(join(root, 'milestones', 'argument-blueprint.md'), approvedBlueprint);
    assert.equal(validateApprovalStage(root, pipeline, 'outline-generation'), '');
    await writeFile(join(root, 'milestones', 'submission-manifest.md'), 'Status: READY FOR AUTHOR CONFIRMATION\n');
    assert.equal(validateApprovalStage(root, { topic: 'T' }, 'submission-readiness'), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow resume preserves the selected approval mode and defaults to topic approval', () => {
  assert.equal(resolveApprovalMode('topic'), 'topic');
  assert.equal(resolveApprovalMode('auto'), 'auto');
  assert.equal(resolveApprovalMode('all'), 'all');
  assert.equal(resolveApprovalMode(undefined), 'topic');
});

test('experiment configuration binds only project-local scripts and results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-experiment-'));
  try {
    await mkdir(join(root, 'code'), { recursive: true });
    await mkdir(join(root, 'experiments', 'results'), { recursive: true });
    await writeFile(join(root, 'code', 'run.mjs'), 'process.exit(0);');
    const configured = resolveExperimentConfiguration(root, 'code/run.mjs', 'experiments/results/output.csv');
    assert.match(configured.command, /--results-file/);
    assert.equal(configured.resultsFile, join(root, 'experiments', 'results', 'output.csv'));
    assert.throws(() => resolveExperimentConfiguration(root, '../outside.mjs', 'experiments/results/output.csv'));
    assert.throws(() => resolveExperimentConfiguration(root, 'code/run.mjs', '../outside.csv'));
    assert.throws(() => resolveExperimentConfiguration(root, 'code/run.txt', 'experiments/results/output.csv'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('argument blueprint preserves author confirmations while refreshing the outline map', () => {
  const first = renderArgumentBlueprint('Question A', { nodes: [{ id: '1', title: 'Claim A', argument: 'First claim', supportingPapers: ['p1'] }] });
  const completed = first
    .replace('[待作者填写：用一至两句直接回答研究问题，明确结论范围。]', 'A bounded answer.')
    .replace('[待作者填写：主要替代解释、结论边界与不确定性；如不适用，请说明原因。]', 'Alternative B remains plausible.');
  const refreshed = renderArgumentBlueprint('Question A', { nodes: [{ id: '1', title: 'Claim B', argument: 'Updated claim', supportingPapers: ['p2'] }] }, completed);
  assert.match(refreshed, /A bounded answer\./);
  assert.match(refreshed, /Alternative B remains plausible\./);
  assert.match(refreshed, /Updated claim/);
  assert.doesNotMatch(refreshed, /First claim/);
});

test('submission templates are generated as preserved milestone artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-submission-templates-'));
  try {
    const pipeline = new PaperPipeline('Template topic', undefined, { outputDir: root, resultsFile: join(root, 'results.csv') });
    await pipeline.ensureSubmissionDocuments();
    const integrity = await readFile(join(root, 'milestones', 'research-integrity.md'), 'utf8');
    const cover = await readFile(join(root, 'milestones', 'cover-letter.md'), 'utf8');
    assert.match(integrity, /Author Confirmation Required/);
    assert.match(cover, /Cover Letter Draft/);
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

test('runtime sync preserves a default model and settings when its credential is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-dsh-home-'));
  const previousHome = process.env.DSH_HOME;
  const saved = saveEnv(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.DSH_HOME = root;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'settings.yaml'), 'agent-default-model:\n  provider: rayinai\n  model: gpt-5.6-terra\n');
    await writeFile(join(root, '.credentials.yaml'), 'refs:\n  DEEPSEEK_API_KEY: deepseek-secret\n');
    const { syncDshRuntime } = await import(`./sync-dsh-runtime.mjs?repair=${Date.now()}`);
    const result = await syncDshRuntime();
    const settings = await readFile(join(root, 'settings.yaml'), 'utf8');
    assert.match(await readFile(join(root, 'profiles', 'web', 'paper-feedback.js'), 'utf8'), /readFeedback/);
    assert.equal(result.repairedDefaultModel, false);
    assert.equal(settings, 'agent-default-model:\n  provider: rayinai\n  model: gpt-5.6-terra\n');
    await syncDshRuntime();
    assert.equal(await readFile(join(root, 'settings.yaml'), 'utf8'), settings);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    restoreSavedEnv(saved);
    await rm(root, { recursive: true, force: true });
  }
});

test('model signal patch is valid and idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-model-signal-'));
  const target = join(root, 'client.js');
  try {
    const original = await readFile(join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-client-ui-model-selection', 'lib', 'client.js'));
    await writeFile(target, original);
    const expectedFirstPatch = original.includes('xiaojia-model-latency-v1') ? false : true;
    assert.equal(patchModelLatency(target), expectedFirstPatch);
    assert.equal(patchModelLatency(target), false);
    const patched = await readFile(target, 'utf8');
    assert.match(patched, /xiaojia-model-latency-v1/);
    assert.match(patched, /eventSource\.subscribe/);
    new Script(patched);
    const signalSource = patched.slice(patched.indexOf('function signalLevel(ms)'), patched.indexOf('function latencyOf(provider, model)'));
    const { signalLevel, signalGlyph } = new Script(`${signalSource}\n({ signalLevel, signalGlyph })`).runInNewContext();
    assert.equal(signalLevel(undefined), 0);
    assert.equal(signalLevel(500), 4);
    assert.equal(signalLevel(1200), 3);
    assert.equal(signalLevel(2200), 2);
    assert.equal(signalLevel(5000), 1);
    assert.equal(signalGlyph(500), '▂▄▆█');
    assert.equal(signalGlyph(undefined), '····');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime sync preserves settings encoding and comments without injecting providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-grok-settings-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = root;
    await writeFile(join(root, 'settings.yaml'), Buffer.from('\ufeff# user setting\r\nagent-default-model:\r\n  provider: deepseek-official\r\n  model: deepseek-v4-flash\r\n', 'utf8'));
    const { syncDshRuntime } = await import(`./sync-dsh-runtime.mjs?format=${Date.now()}`);
    await syncDshRuntime();
    const bytes = await readFile(join(root, 'settings.yaml'));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const content = bytes.toString('utf8');
    assert.match(content, /# user setting\r\n/);
    assert.equal(content, '\ufeff# user setting\r\nagent-default-model:\r\n  provider: deepseek-official\r\n  model: deepseek-v4-flash\r\n');
    assert.doesNotMatch(content, /(?<!\r)\n/);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime sync keeps existing provider catalogs and uses the shipped profile for defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-grok-upgrade-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = root;
    await writeFile(join(root, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    sub2api-grok:',
      '      models:',
      '        - id: grok-4.5',
      '          name: Grok 4.5',
      '    rayinai-claude:',
      '      displayName: RayinAI Claude',
      '      apiKeyEnv: ANTHROPIC_API_KEY',
      '      api: openai-completions',
      '      baseURL: https://code.rayinai.com',
      '      models:',
      '        - id: claude-opus-5',
      '          name: claude-opus-5',
      '',
    ].join('\n'));
    const { syncDshRuntime } = await import(`./sync-dsh-runtime.mjs?upgrade=${Date.now()}`);
    const before = await readFile(join(root, 'settings.yaml'));
    await syncDshRuntime();
    const settings = await readFile(join(root, 'settings.yaml'), 'utf8');
    assert.deepEqual(await readFile(join(root, 'settings.yaml')), before);
    assert.match(settings, /id: grok-4\.5/);
    assert.match(settings, /baseURL: https:\/\/code\.rayinai\.com/);
    const profile = await readFile(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    assert.match(profile, /sub2api-grok:/);
    assert.match(profile, /grok-4\.7/);
    assert.match(profile, /rayinai-claude:/);
    await syncDshRuntime();
    assert.deepEqual(await readFile(join(root, 'settings.yaml')), before);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
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
      tools: { register: () => {} },
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

test('Web confirmation rejects an unreviewed topic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-topic-confirm-'));
  const previousRoot = process.env.PAPER_DATA_ROOT;
  try {
    process.env.PAPER_DATA_ROOT = root;
    const projectDir = join(root, 'output', 'paper-projects', 'paper-review-test');
    const stateDir = join(projectDir, '.dsh-state');
    const runDir = join(root, '.dsh-state', 'paper-runs');
    await mkdir(stateDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(stateDir, 'paper-pipeline-state.json'), JSON.stringify({ topic: 'Proposed topic', stage: 'topic-confirmation' }));
    await writeFile(join(runDir, 'review-session.json'), JSON.stringify({ outputDir: projectDir, topic: 'Broad topic', status: 'awaiting-confirmation', stage: 'topic-confirmation' }));
    const { apply } = await import(`../config/dsh/web/paper-command.js?review=${Date.now()}`);
    const commands = new Map();
    apply({ commands: { register: (command) => commands.set(command.name, command) }, tools: { register: () => {} }, goals: { get: () => undefined }, systemPrompt: { context: () => {} }, effect: () => {} });
    const result = await commands.get('paper-confirm').handler({ agent: { id: 'review-session' } });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /复核记录/);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
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
      tools: { register: () => {} },
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

test('research feedback stays in the project and blocks submission until resolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-feedback-'));
  const previousRoot = process.env.PAPER_DATA_ROOT;
  try {
    process.env.PAPER_DATA_ROOT = root;
    const projectDir = join(root, 'output', 'paper-projects', 'paper-feedback-test');
    const milestones = join(projectDir, 'milestones');
    const runDir = join(root, '.dsh-state', 'paper-runs');
    await mkdir(milestones, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(milestones, 'claim-evidence-matrix.md'), '# Matrix\n| ID | Claim | Source |\n|---|---|---|\n| C1.1 | Claim A | paper-1 |\n');
    await writeFile(join(runDir, 'feedback-session.json'), JSON.stringify({ outputDir: projectDir, stage: 'results-writing', status: 'completed' }));
    const { apply } = await import(`../config/dsh/web/paper-command.js?feedback=${Date.now()}`);
    const commands = new Map();
    apply({ commands: { register: (command) => commands.set(command.name, command) }, tools: { register: () => {} }, goals: { get: () => undefined }, systemPrompt: { context: () => {} }, effect: () => {} });
    const agent = { id: 'feedback-session' };
    const evidence = await commands.get('paper-evidence').handler({ agent, rawInput: 'C1.1' });
    assert.match(evidence.text, /paper-1/);
    const added = await commands.get('paper-feedback').handler({ agent, rawInput: 'add C1.1 | 样本量不符 | Table 2' });
    assert.equal(added.kind, 'success');
    const list = await commands.get('paper-feedback').handler({ agent, rawInput: 'list' });
    assert.match(list.text, /待处理.*C1\.1/);
    const blocked = await commands.get('paper-submission').handler({ agent });
    assert.match(blocked.text, /BLOCKED 研究者异议已处理/);
    const pipeline = new PaperPipeline('Feedback test', undefined, { outputDir: projectDir });
    await assert.rejects(pipeline.stageSubmissionReadiness());
    const manifest = await readFile(join(milestones, 'submission-manifest.md'), 'utf8');
    assert.match(manifest, /\[ \] 研究者异议已处理（待处理 1 项）/);
    assert.match(manifest, /Status: BLOCKED/);
    const id = list.text.match(/待处理 ([a-f0-9-]+)/)?.[1];
    assert.ok(id);
    const resolved = await commands.get('paper-feedback').handler({ agent, rawInput: `resolve ${id} | 已更正样本量 | Table 2 与质量报告` });
    assert.equal(resolved.kind, 'success');
    const after = await commands.get('paper-feedback').handler({ agent, rawInput: 'list' });
    assert.match(after.text, /已处理.*C1\.1/);
    assert.match(after.text, /复核: Table 2 与质量报告/);
    const submission = await commands.get('paper-submission').handler({ agent });
    assert.match(submission.text, /PASS 研究者异议已处理/);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

function saveEnv(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreSavedEnv(saved) {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
