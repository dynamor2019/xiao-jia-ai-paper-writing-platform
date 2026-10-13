import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** Test real Web handlers using isolated records, without starting a writer or model. */
async function fixture(t, run, checkpoint) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phase-web-'));
  const saved = { data: process.env.PAPER_DATA_ROOT, project: process.env.DSH_PAPER_PROJECT_DIR };
  process.env.PAPER_DATA_ROOT = root;
  process.env.DSH_PAPER_PROJECT_DIR = root;
  t.after(async () => {
    for (const [key, value] of [['PAPER_DATA_ROOT', saved.data], ['DSH_PAPER_PROJECT_DIR', saved.project]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const outputDir = join(root, 'output', 'paper-projects', 'paper-phase-test');
  const runs = join(root, '.dsh-state', 'paper-runs');
  await mkdir(join(outputDir, '.dsh-state'), { recursive: true });
  await mkdir(runs, { recursive: true });
  await writeFile(join(outputDir, '.dsh-state', 'paper-pipeline-state.json'), JSON.stringify({ topic: 'Question', ...checkpoint }));
  const runFile = join(runs, 'session-phase-test.json');
  await writeFile(runFile, JSON.stringify({ topic: 'Question', outputDir, researchDirection: {}, ...run }));
  const { apply } = await import(`../config/dsh/web/paper-command.js?phase=${root}`);
  const tools = new Map(), commands = new Map();
  apply({ commands: { register: (command) => commands.set(command.name, command) },
    tools: { register: (tool) => tools.set(tool.name, tool) }, goals: { get: () => undefined },
    systemPrompt: { context: () => {} }, effect: () => {} });
  return { tools, commands, runFile, agent: { id: 'session-phase-test' } };
}

test('a live supervisor waiting to recover cannot be replaced by a second writer', async (t) => {
  const f = await fixture(t, { status: 'running', stage: 'auto-recovery-wait', pid: process.pid }, { stage: 'quality-validation', metadata: {} });
  const result = await f.tools.get('continue_paper_workflow').execute({ action: 'resume' }, { agent: f.agent });
  assert.match(result, /无需重复启动/);
  assert.equal(JSON.parse(await readFile(f.runFile, 'utf8')).pid, process.pid);
});

test('recorded degraded gates never become READY because a later stage was reached', async (t) => {
  const f = await fixture(t, { status: 'failed', stage: 'submission-readiness' }, { stage: 'submission-readiness',
    metadata: { workflow: { version: 1, tasks: { 'quality-validation': { status: 'degraded', error: 'Review unavailable' }, export: { status: 'complete' } } } } });
  const result = await f.commands.get('paper-workbench').handler({ agent: f.agent });
  assert.match(result.text, /交叉审查与修订: 草稿继续，待核验/);
  assert.doesNotMatch(result.text, /交叉审查与修订: READY/);
});

test('unconfirmed billing and gate-repair requests cannot start paid tasks', async (t) => {
  const f = await fixture(t, { status: 'failed' }, { stage: 'quality-validation',
    metadata: { workflow: { version: 1, tasks: { 'quality-validation': { status: 'failed', error: 'insufficient balance' } } } } });
  const tool = f.tools.get('continue_paper_workflow');
  assert.match(await tool.execute({ action: 'resume' }, { agent: f.agent }), /明确确认充值恢复/);
  assert.match(await tool.execute({ action: 'repair-gate', gateStage: 'quality-validation' }, { agent: f.agent }), /作者明确确认/);
  assert.equal(JSON.parse(await readFile(f.runFile, 'utf8')).status, 'failed');
});
