import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const tools = new Map(), commands = new Map(), routes = new Map();
  apply({ commands: { register: (command) => commands.set(command.name, command) },
    tools: { register: (tool) => tools.set(tool.name, tool) }, goals: { get: () => undefined },
    systemPrompt: { context: () => {} }, webServer: { register: (route) => routes.set(route.path, route) }, effect: (effect) => effect() });
  return { tools, commands, routes, runFile, outputDir, agent: { id: 'session-phase-test' } };
}

test('packaged manuscripts keep their paired Word and relocated declarations without requiring publication records', async (t) => {
  const f = await fixture(t, { status: 'failed', stage: 'literature-search' }, { stage: 'submission-readiness',
    metadata: { workflow: { version: 1, tasks: { 'manuscript-completion': { status: 'complete' }, export: { status: 'complete' }, 'submission-readiness': { status: 'degraded' } } } } });
  const packageDir = join(f.outputDir, 'SUBMISSION_PACKAGE');
  await mkdir(join(packageDir, 'submission'), { recursive: true });
  for (const [file, content] of Object.entries({
    'manuscript.md': '# Manuscript\nActual research prose',
    'manuscript.docx': 'word fixture',
    'manuscript.quality-report.md': 'Status: PASS',
    'cover_letter.docx': 'newer letter fixture',
    'cover_letter.md': '# Cover letter',
    'citation-verification-report.md': 'Not verified',
    'submission/integrity-declarations.md': '# Author declarations',
    'submission/submission-manifest.md': 'Citation review: BLOCKED\nJournal upload: NOT SENT',
    'submission/README_supplementary.md': '# Newer supporting notes',
  })) await writeFile(join(packageDir, file), content);
  const result = await f.commands.get('paper-submission').handler({ agent: f.agent });
  assert.match(result.text, /PASS 论文 Markdown 源稿/);
  assert.match(result.text, /PASS 正式 Word 文件.*manuscript\.docx/);
  assert.match(result.text, /PASS 作者与研究声明/);
  assert.match(result.text, /PASS 投稿清单/);
  assert.doesNotMatch(result.text, /BLOCKED.*(?:修订追踪|发表记录)/);
  assert.match(result.text, /SUBMISSION BLOCKED/);
  assert.match(result.text, /Citation review: BLOCKED/);
  await f.commands.get('paper-workbench').handler({ agent: f.agent });
  const reconciled = JSON.parse(await readFile(f.runFile, 'utf8'));
  assert.equal(reconciled.stage, 'submission-readiness');
  let snapshot;
  await f.routes.get('/dsh-paper-workbench').handler({ method: 'GET', url: '/dsh-paper-workbench?sessionId=session-phase-test' },
    { writeHead: () => {}, end: (body) => { snapshot = JSON.parse(body); } });
  assert.equal(snapshot.manuscriptPrepared, true);
  assert.equal(snapshot.latestWord, join(packageDir, 'manuscript.docx'));
  assert.equal(snapshot.phases.find((phase) => phase.id === 'delivery').passed, false);
});

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

test('delivered manuscripts distinguish unrun historical checks from actual scientific failures', async (t) => {
  const tasks = {
    'manuscript-completion': { status: 'complete' }, export: { status: 'complete' },
    'literature-search': { status: 'failed', error: '2026-10-08 pipeline search failed and was not rerun.' },
    'citation-verification': { status: 'failed', error: 'All current references were not re-verified on 2026-10-19.' },
  };
  const f = await fixture(t, { status: 'failed', stage: 'submission-readiness' },
    { stage: 'submission-readiness', metadata: { workflow: { version: 1, tasks } } });
  await writeFile(join(f.outputDir, 'manuscript.md'), '# Article');
  await writeFile(join(f.outputDir, 'manuscript.docx'), 'Word fixture');
  const snapshot = async () => {
    let value;
    await f.routes.get('/dsh-paper-workbench').handler({ method: 'GET', url: '/dsh-paper-workbench?sessionId=session-phase-test' },
      { writeHead: () => {}, end: (body) => { value = JSON.parse(body); } });
    return value;
  };
  const pending = await snapshot();
  assert.equal(pending.phases.find((phase) => phase.id === 'writing').status, 'degraded');
  assert.equal(pending.phases.find((phase) => phase.id === 'gates').status, 'degraded');
  assert.equal(pending.recordedStages.find((stage) => stage.id === 'citation-verification').status, 'error');
  assert.ok(pending.phases.every((phase) => !phase.passed));
  tasks['quality-validation'] = { status: 'failed', error: 'Scientific integrity: fabricated measurements' };
  await writeFile(join(f.outputDir, '.dsh-state', 'paper-pipeline-state.json'),
    JSON.stringify({ topic: 'Question', stage: 'submission-readiness', metadata: { workflow: { version: 1, tasks } } }));
  const blocked = await snapshot();
  assert.equal(blocked.phases.find((phase) => phase.id === 'gates').status, 'error');
});

test('only a matching manuscript hash can surface a current two-route review', async (t) => {
  const f = await fixture(t, { status: 'failed', stage: 'submission-readiness' }, { stage: 'submission-readiness',
    metadata: { workflow: { version: 1, tasks: { 'manuscript-completion': { status: 'complete' }, export: { status: 'complete' } } } } });
  const source = '# Article\nCurrent content';
  await writeFile(join(f.outputDir, 'manuscript.md'), source);
  await writeFile(join(f.outputDir, 'manuscript.docx'), 'Word fixture');
  await writeFile(join(f.outputDir, 'manuscript.quality-report.md'),
    `Manuscript SHA256: ${createHash('sha256').update(source).digest('hex')}\n# Reference Metadata Audit\nStatus: PASS\nReview route: quality\nManuscript gate: CLEAR\nReview route: qualityCrossReview\nManuscript gate: CLEAR\n`);
  const snapshot = async () => {
    let value;
    await f.routes.get('/dsh-paper-workbench').handler({ method: 'GET', url: '/dsh-paper-workbench?sessionId=session-phase-test' },
      { writeHead: () => {}, end: body => { value = JSON.parse(body); } });
    return value;
  };
  const reviewed = await snapshot();
  assert.equal(reviewed.currentReview.status, 'clear');
  assert.equal(reviewed.phases.find(phase => phase.id === 'writing').passed, true);
  assert.equal(reviewed.phases.find(phase => phase.id === 'gates').passed, false);
  await mkdir(join(f.outputDir, '.dsh-state', 'citation-support'), { recursive: true });
  await writeFile(join(f.outputDir, '.dsh-state', 'citation-support', 'current.json'), JSON.stringify({
    sha256: createHash('sha256').update(source).digest('hex'), total: 1, results: [{ status: 'verified' }],
  }));
  const citationReviewed = await snapshot();
  assert.equal(citationReviewed.currentReview.citationSupportClear, true);
  assert.equal(citationReviewed.phases.find(phase => phase.id === 'gates').passed, true);
  await writeFile(join(f.outputDir, 'manuscript.md'), source + '\nChanged claim');
  const changed = await snapshot();
  assert.equal(changed.currentReview.status, 'stale');
  assert.equal(changed.phases.find(phase => phase.id === 'gates').passed, false);
});
