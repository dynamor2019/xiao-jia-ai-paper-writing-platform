import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExperimentPlanError, runExperimentPlan, type ExperimentPlan, type ExperimentPlanCheckpoint,
  type ExperimentPlanOptions, type ExperimentValidationInput } from './experiment-plan.js';

/** Keep all execution/evidence in disposable fixtures, with no shell, model or network calls. */
function fixture(t: TestContext, count = 2) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-experiment-plan-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const planFile = join(root, 'milestones', 'experiment-plan.json');
  const protocolFile = join(root, 'analysis-plan.md');
  const stateFile = join(root, '.dsh-state', 'experiment-plan-state.json');
  const plan: ExperimentPlan & { pilot: NonNullable<ExperimentPlan['pilot']> } = { schemaVersion: 1, executionMode: 'run-experiments', researchQuestion: 'Does method A change outcome B?',
    originalHypothesis: 'Method A increases outcome B.',
    pilot: { command: 'explicit-pilot --seed 7', resultsFile: 'experiments/results/pilot.json' },
    batches: Array.from({ length: count }, (_, index) => ({ id: 'batch-' + (index + 1),
      command: 'explicit-batch-' + (index + 1) + ' --seed 7', resultsFile: 'experiments/results/batch-' + (index + 1) + '.json',
      question: 'What happens under condition ' + (index + 1) + '?' })) };
  mkdirSync(dirname(planFile), { recursive: true });
  writeFileSync(planFile, JSON.stringify(plan));
  writeFileSync(protocolFile, '# Frozen Research Protocol\nDo not discard negative, null or unknown outcomes.\n');
  const runs: { command: string; outputDir: string; resultsFile: string }[] = [];
  const validations: ExperimentValidationInput[] = [];
  const saves: ExperimentPlanCheckpoint[] = [];
  const options: ExperimentPlanOptions = { projectDir: root, phase: 'pilot', protocolFile: 'analysis-plan.md',
    run: async (command, outputDir, resultsFile, budget) => {
      assert.equal(budget.cwd, root);
      assert.equal(budget.timeoutMs, 300_000);
      assert.equal(budget.signal.aborted, false);
      assert.equal(read_state(stateFile).tasks[command.startsWith('explicit-pilot') ? 'pilot' : command.split(' ')[0].replace('explicit-', '')].status, 'running');
      runs.push({ command, outputDir, resultsFile });
      mkdirSync(dirname(resultsFile), { recursive: true });
      writeFileSync(resultsFile, JSON.stringify({ outcome: 'negative', estimate: null, interpretation: 'unknown', supportsHypothesis: false }));
      const log = join(outputDir, 'run.log');
      writeFileSync(log, 'status=SUCCESS\ncommand=' + command);
      return { success: true, data: relative(root, log) };
    },
    validate: async (input) => {
      assert.equal(input.protocolFile, protocolFile);
      assert.equal(existsSync(input.logFile), true);
      assert.equal(existsSync(input.resultsFile), true);
      validations.push(input);
      const report = join(input.outputDir, 'integrity.json');
      writeFileSync(report, JSON.stringify({ integrity: true, feasible: true, supportsHypothesis: false }));
      return { success: true, data: relative(root, report) };
    },
    save: (state) => { assert.deepEqual(read_state(stateFile), state); saves.push(state); } };
  return { root, planFile, protocolFile, stateFile, plan, options, runs, validations, saves };
}

/** Read only the fixture's separate checkpoint. */
function read_state(file: string): ExperimentPlanCheckpoint {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Match stable blocking codes rather than fragile provider error wording. */
function has_code(code: string) {
  return (error: unknown) => { assert.ok(error instanceof ExperimentPlanError); assert.equal(error.code, code); return true; };
}

test('missing optional default plan performs no execution or state creation', async (t) => {
  const f = fixture(t);
  rmSync(f.planFile);
  assert.deepEqual(await runExperimentPlan(f.options), []);
  assert.equal(f.runs.length, 0);
  assert.equal(existsSync(f.stateFile), false);
  await assert.rejects(runExperimentPlan({ ...f.options, planFile: 'milestones/missing.json' }), /ENOENT/);
});

test('pilot is deterministic and validated alone; formal returns ordered paths, then reuses exact evidence', async (t) => {
  const f = fixture(t);
  const plan_bytes = readFileSync(f.planFile);
  assert.deepEqual(await runExperimentPlan(f.options), []);
  assert.deepEqual(f.runs.map((run) => run.command), [f.plan.pilot.command]);
  assert.equal(f.validations.length, 1);
  assert.equal(read_state(f.stateFile).tasks['batch-1'].status, 'pending');
  const paths = f.plan.batches.map((batch) => join(f.root, batch.resultsFile));
  assert.deepEqual(await runExperimentPlan({ ...f.options, phase: 'formal', resultsFile: f.plan.batches.at(-1)!.resultsFile }), paths);
  assert.deepEqual(f.runs.map((run) => run.command), [f.plan.pilot.command, ...f.plan.batches.map((batch) => batch.command)]);
  assert.equal(new Set(f.runs.map((run) => run.outputDir)).size, 3);
  assert.equal(new Set(f.validations.map((input) => input.outputDir)).size, 3);
  assert.equal(new Set(f.validations.map((input) => input.logFile)).size, 3);
  assert.equal(f.saves.filter((state) => state.tasks.pilot.status === 'validated').length > 0, true);
  for (const path of [join(f.root, f.plan.pilot.resultsFile), ...paths]) {
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { outcome: 'negative', estimate: null, interpretation: 'unknown', supportsHypothesis: false });
  }
  assert.deepEqual(readFileSync(f.planFile), plan_bytes);
  assert.deepEqual(await runExperimentPlan({ ...f.options, phase: 'formal' }), paths);
  assert.deepEqual(await runExperimentPlan(f.options), []);
  assert.equal(f.runs.length, 3);
  assert.equal(f.validations.length, 3);
  assert.equal(existsSync(f.stateFile + '.lock'), false);
});

test('formal never dispatches a missing or unvalidated pilot', async (t) => {
  const f = fixture(t);
  await assert.rejects(runExperimentPlan({ ...f.options, phase: 'formal' }), has_code('pilot-required'));
  assert.equal(f.runs.length, 0);
  await assert.rejects(runExperimentPlan({ ...f.options, validate: async () => ({ success: false, error: 'Invalid pilot data' }) }), has_code('validate-failed'));
  await assert.rejects(runExperimentPlan({ ...f.options, phase: 'formal' }), has_code('pilot-required'));
  assert.equal(f.runs.length, 1);
});

test('provided datasets skip pilot, run the reproducible analysis batch, and stay hash-bound', async (t) => {
  const f = fixture(t);
  const source = join(f.root, 'raw', 'provided.csv');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, 'id,value\n1,2\n2,4\n3,3\n');
  const plan = { ...f.plan, executionMode: 'provided-data' as const, sourceFiles: ['raw/provided.csv'], pilot: undefined };
  delete (plan as Partial<typeof plan>).pilot;
  writeFileSync(f.planFile, JSON.stringify(plan));
  const paths = plan.batches.map((batch) => join(f.root, batch.resultsFile));

  assert.deepEqual(await runExperimentPlan({ ...f.options, phase: 'pilot' }), []);
  assert.equal(f.runs.length, 0);
  assert.deepEqual(read_state(f.stateFile).sourceHashes, { [source]: createHashHex(source) });
  assert.deepEqual(await runExperimentPlan({ ...f.options, phase: 'formal', resultsFile: plan.batches.at(-1)!.resultsFile }), paths);
  assert.deepEqual(f.runs.map((run) => run.command), plan.batches.map((batch) => batch.command));

  writeFileSync(source, 'id,value\n1,2\n2,4\n3,5\n');
  await assert.rejects(runExperimentPlan({ ...f.options, phase: 'formal' }), has_code('binding-changed'));
  assert.equal(f.runs.length, plan.batches.length);
});

function createHashHex(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

test('selected question and configured main result must match exactly before dispatch', async (t) => {
  const f = fixture(t);
  await assert.rejects(runExperimentPlan({ ...f.options, expectedResearchQuestion: 'A different question' }), /selected researchQuestion/);
  await assert.rejects(runExperimentPlan({ ...f.options, resultsFile: 'experiments/results/different.json' }), /configured main resultsFile/);
  assert.equal(existsSync(f.stateFile), false);
  await runExperimentPlan({ ...f.options, expectedResearchQuestion: f.plan.researchQuestion, resultsFile: f.plan.batches.at(-1)!.resultsFile });
  assert.equal(f.runs.length, 1);
});

test('schema rejects missing explicit fields, duplicate IDs, empty or oversized batches', async (t) => {
  const f = fixture(t);
  const invalid = [
    { ...f.plan, schemaVersion: 2 }, { ...f.plan, researchQuestion: '' }, { ...f.plan, originalHypothesis: null },
    { ...f.plan, pilot: { ...f.plan.pilot, command: '' } }, { ...f.plan, pilot: null },
    { ...f.plan, batches: [] }, { ...f.plan, batches: Array.from({ length: 32 }, (_, index) => ({ ...f.plan.batches[0], id: 'batch-' + index })) },
    { ...f.plan, batches: [{ ...f.plan.batches[0], question: '' }] },
    { ...f.plan, batches: [{ ...f.plan.batches[0], id: 'pilot' }] },
    { ...f.plan, batches: [{ ...f.plan.batches[0], id: '../escape' }] },
    { ...f.plan, batches: [f.plan.batches[0], { ...f.plan.batches[1], id: 'BATCH-1' }] },
  ];
  for (const plan of invalid) {
    writeFileSync(f.planFile, JSON.stringify(plan));
    await assert.rejects(runExperimentPlan(f.options));
  }
  assert.equal(f.runs.length, 0);
  assert.equal(existsSync(f.stateFile), false);
});

test('budgets enforce 32 total tasks and timeout in (0, 1 hour]', async (t) => {
  const f = fixture(t, 31);
  for (const timeoutMs of [0, -1, 3_600_001, NaN, 1.5]) await assert.rejects(runExperimentPlan({ ...f.options, timeoutMs }), /budget/);
  for (const maxBatches of [0, 32, 1.5]) await assert.rejects(runExperimentPlan({ ...f.options, maxBatches }), /budget/);
  await assert.rejects(runExperimentPlan({ ...f.options, maxBatches: 30 }), /1\.\.31/);
  await runExperimentPlan(f.options);
  assert.equal(f.runs.length, 1);
  assert.equal(Object.keys(read_state(f.stateFile).tasks).length, 32);
});

test('results cannot escape the project, overwrite protected data or alias another task/input', async (t) => {
  const f = fixture(t);
  for (const result of ['../outside.json', join(dirname(f.root), 'outside.json'), '.dsh-state/secret.json',
    'milestones/data.json', 'nested/milestones/data.json', 'experiments/results/pilot.json', 'experiments/results/pilot.json/child.json',
    'analysis-plan.md', 'experiments/experiment-plan-audit/hidden.json']) {
    writeFileSync(f.planFile, JSON.stringify({ ...f.plan, batches: [{ ...f.plan.batches[0], resultsFile: result }] }));
    await assert.rejects(runExperimentPlan(f.options));
  }
  if (process.platform === 'win32') {
    writeFileSync(f.planFile, JSON.stringify({ ...f.plan, batches: [{ ...f.plan.batches[0], resultsFile: 'EXPERIMENTS/RESULTS/PILOT.JSON' }] }));
    await assert.rejects(runExperimentPlan(f.options), /distinct/);
  }
  assert.equal(f.runs.length, 0);
  assert.equal(existsSync(f.stateFile), false);
});

test('pilot and formal results reject raw/input/archive outputs without overwriting existing data', async (t) => {
  const f = fixture(t);
  for (const directory of ['raw', 'input', 'archive', 'archives', 'experiments/raw', 'experiments/input',
    'experiments/archive', 'experiments/results-archive']) {
    const resultsFile = directory + '/source.json';
    const source = join(f.root, resultsFile);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'Original source data');
    for (const pilot of [true, false]) {
      const plan = pilot ? { ...f.plan, pilot: { ...f.plan.pilot, resultsFile } }
        : { ...f.plan, batches: [{ ...f.plan.batches[0], resultsFile }] };
      writeFileSync(f.planFile, JSON.stringify(plan));
      await assert.rejects(runExperimentPlan(f.options), /strictly inside project experiments\/results/);
      assert.equal(readFileSync(source, 'utf8'), 'Original source data');
    }
  }
  for (const resultsFile of ['experiments/results', 'experiments/results/../../raw/source.json']) {
    writeFileSync(f.planFile, JSON.stringify({ ...f.plan, pilot: { ...f.plan.pilot, resultsFile } }));
    await assert.rejects(runExperimentPlan(f.options), /strictly inside project experiments\/results/);
  }
  assert.equal(f.runs.length, 0);
  assert.equal(existsSync(f.stateFile), false);
});

test('symlink/junction escapes and hardlinked outputs are rejected without changing targets', async (t) => {
  const f = fixture(t);
  const external = mkdtempSync(join(tmpdir(), 'dsh-experiment-outside-'));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  mkdirSync(join(f.root, 'experiments'));
  symlinkSync(external, join(f.root, 'experiments', 'results'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runExperimentPlan(f.options), /Symlink\/junction/);
  rmSync(join(f.root, 'experiments', 'results'));
  mkdirSync(join(f.root, 'experiments', 'results'));
  linkSync(f.protocolFile, join(f.root, 'experiments', 'results', 'pilot.json'));
  await assert.rejects(runExperimentPlan(f.options), /Hardlinked/);
  assert.match(readFileSync(f.protocolFile, 'utf8'), /^# Frozen Research Protocol/);
  assert.equal(f.runs.length, 0);
});

test('checkpoint fingerprints bind both plan and protocol, not just task IDs', async (t) => {
  const f = fixture(t);
  await runExperimentPlan(f.options);
  const protocol = readFileSync(f.protocolFile);
  writeFileSync(f.protocolFile, '# Frozen Research Protocol\nAmended.\n');
  await assert.rejects(runExperimentPlan({ ...f.options, phase: 'formal' }), has_code('binding-changed'));
  writeFileSync(f.protocolFile, protocol);
  writeFileSync(f.planFile, JSON.stringify({ ...f.plan, originalHypothesis: 'A revised hypothesis' }));
  await assert.rejects(runExperimentPlan(f.options), has_code('binding-changed'));
  assert.equal(f.runs.length, 1);
});

test('changed result/log/report hashes block reuse and all later execution', async (t) => {
  for (const artifact of ['resultsFile', 'logFile', 'reportFile'] as const) {
    const f = fixture(t);
    await runExperimentPlan(f.options);
    const record = read_state(f.stateFile).tasks.pilot;
    const path = artifact === 'resultsFile' ? join(f.root, f.plan.pilot.resultsFile) : record[artifact]!;
    writeFileSync(path, 'Changed evidence');
    await assert.rejects(runExperimentPlan({ ...f.options, phase: 'formal' }), has_code('evidence-changed'));
    assert.equal(f.runs.length, 1);
  }
});

test('validation detects result mutation and never reruns execution', async (t) => {
  const f = fixture(t);
  const validate = f.options.validate;
  await assert.rejects(runExperimentPlan({ ...f.options, validate: async (input) => {
    const reply = await validate(input);
    writeFileSync(input.resultsFile, 'Mutated during integrity check');
    return reply;
  } }), has_code('validate-failed'));
  await assert.rejects(runExperimentPlan(f.options), has_code('evidence-changed'));
  assert.equal(f.runs.length, 1);
});

test('final formal callback cannot silently invalidate the validated pilot', async (t) => {
  const f = fixture(t);
  await runExperimentPlan(f.options);
  const validate = f.options.validate;
  await assert.rejects(runExperimentPlan({ ...f.options, phase: 'formal', validate: async (input) => {
    const reply = await validate(input);
    if (input.resultsFile === join(f.root, f.plan.batches.at(-1)!.resultsFile)) {
      writeFileSync(join(f.root, f.plan.pilot.resultsFile), 'Changed pilot evidence');
    }
    return reply;
  } }), has_code('evidence-changed'));
  await assert.rejects(runExperimentPlan({ ...f.options, phase: 'formal' }), has_code('evidence-changed'));
  assert.equal(f.runs.length, 3);
});

test('failed formal execution has at most three attempts across resumes and retains completed tasks', async (t) => {
  const f = fixture(t);
  await runExperimentPlan(f.options);
  const run = f.options.run;
  let failures = 0;
  const options: ExperimentPlanOptions = { ...f.options, phase: 'formal', run: async (...args) => {
    if (args[0] === f.plan.batches[1].command) { failures += 1; return { success: false, error: 'Deterministic execution failure' }; }
    return run(...args);
  } };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(runExperimentPlan(options), has_code('run-failed'));
    assert.equal(read_state(f.stateFile).tasks['batch-2'].attempts, attempt);
  }
  await assert.rejects(runExperimentPlan(options), has_code('attempts-exhausted'));
  assert.equal(failures, 3);
  assert.equal(f.runs.length, 2);
  assert.equal(read_state(f.stateFile).tasks['batch-1'].status, 'validated');
});

test('validation retries are bounded independently and never dispatch the experiment again', async (t) => {
  const f = fixture(t);
  let failures = 0;
  const options: ExperimentPlanOptions = { ...f.options, validate: async () => {
    failures += 1;
    return { success: false, error: 'Basic integrity not yet acceptable' };
  } };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(runExperimentPlan(options), has_code('validate-failed'));
    assert.equal(read_state(f.stateFile).tasks.pilot.validationAttempts, attempt);
  }
  await assert.rejects(runExperimentPlan(options), has_code('attempts-exhausted'));
  assert.equal(failures, 3);
  assert.equal(f.runs.length, 1);
});

test('successful validation recovery resumes only validation, including lifecycle-shaped callbacks', async (t) => {
  const f = fixture(t);
  await assert.rejects(runExperimentPlan({ ...f.options, validate: async () => ({ success: false, error: 'Repair audit only' }) }));
  await runExperimentPlan(f.options);
  assert.equal(f.runs.length, 1);
  assert.equal(read_state(f.stateFile).tasks.pilot.validationAttempts, 2);
  assert.notEqual(read_state(f.stateFile).tasks.pilot.outputDir, read_state(f.stateFile).tasks.pilot.validationOutputDir);
});

test('billing blocks repeated resumes until explicit author recovery, without resetting attempts', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const options: ExperimentPlanOptions = { ...f.options, run: async () => {
    calls += 1;
    throw Object.assign(new Error('Account unavailable'), { status: 402 });
  } };
  await assert.rejects(runExperimentPlan(options), has_code('awaiting-author'));
  await assert.rejects(runExperimentPlan(options), has_code('awaiting-author'));
  assert.equal(calls, 1);
  await runExperimentPlan({ ...f.options, authorResolution: { taskId: 'pilot', action: 'retry', reason: 'Author confirmed billing recovery; failed command never started' } });
  assert.equal(read_state(f.stateFile).tasks.pilot.attempts, 2);
});

test('validation billing recovery accepts existing execution, not another run', async (t) => {
  const f = fixture(t);
  await assert.rejects(runExperimentPlan({ ...f.options, validate: async () => ({ success: false, error: 'insufficient_quota' }) }), has_code('awaiting-author'));
  await assert.rejects(runExperimentPlan(f.options), has_code('awaiting-author'));
  await assert.rejects(runExperimentPlan({ ...f.options, authorResolution: { taskId: 'pilot', action: 'retry', reason: 'Billing restored' } }), /cannot rerun/);
  await runExperimentPlan({ ...f.options, authorResolution: { taskId: 'pilot', action: 'validate', reason: 'Author approved integrity validation after billing recovery' } });
  assert.equal(f.runs.length, 1);
  assert.equal(read_state(f.stateFile).tasks.pilot.validationAttempts, 2);
});

test('lost response persists running and explicit stop never re-executes the experiment', async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(runExperimentPlan({ ...f.options, run: async () => {
    calls += 1;
    throw new Error('Interrupted by shutdown');
  } }), has_code('interrupted'));
  assert.equal(read_state(f.stateFile).tasks.pilot.status, 'running');
  await assert.rejects(runExperimentPlan(f.options), has_code('awaiting-author'));
  await assert.rejects(runExperimentPlan({ ...f.options, authorResolution: { taskId: 'pilot', action: 'retry', reason: 'Try again' } }), /cannot rerun/);
  await assert.rejects(runExperimentPlan({ ...f.options, authorResolution: { taskId: 'pilot', action: 'stop', reason: 'Author stopped uncertain execution' } }), has_code('awaiting-author'));
  await assert.rejects(runExperimentPlan(f.options), has_code('awaiting-author'));
  assert.equal(calls, 1);
  assert.equal(f.runs.length, 0);
});

test('author can adopt completed interrupted output using its log without duplicate execution', async (t) => {
  const f = fixture(t);
  const run = f.options.run;
  await assert.rejects(runExperimentPlan({ ...f.options, run: async (...args) => {
    await run(...args);
    throw Object.assign(new Error('Lost final response'), { name: 'AbortError' });
  } }), has_code('interrupted'));
  const log = join(read_state(f.stateFile).tasks.pilot.outputDir!, 'run.log');
  await runExperimentPlan({ ...f.options, authorResolution: { taskId: 'pilot', action: 'validate', logFile: relative(f.root, log),
    reason: 'Author resolved stopped runner and verified completed log/output' } });
  assert.equal(f.runs.length, 1);
  assert.equal(read_state(f.stateFile).tasks.pilot.status, 'validated');
});

test('timeout signals cancellation, persists running and prohibits implicit retry', async (t) => {
  const f = fixture(t);
  let signal: AbortSignal | undefined;
  await assert.rejects(runExperimentPlan({ ...f.options, timeoutMs: 10, run: async (_command, _output, _results, budget) => {
    assert.equal(budget.timeoutMs, 10);
    signal = budget.signal;
    return new Promise<string>(() => {});
  } }), has_code('interrupted'));
  assert.equal(signal?.aborted, true);
  assert.equal(read_state(f.stateFile).tasks.pilot.status, 'running');
  await assert.rejects(runExperimentPlan(f.options), has_code('awaiting-author'));
});

test('save observes atomic durable running state before dispatch and cannot mutate it', async (t) => {
  const f = fixture(t);
  await assert.rejects(runExperimentPlan({ ...f.options, save: (state) => {
    assert.equal(read_state(f.stateFile).tasks.pilot.status, 'running');
    state.tasks.pilot.status = 'validated';
    throw new Error('Application interrupted after durable save');
  } }), /Application interrupted/);
  assert.equal(read_state(f.stateFile).tasks.pilot.status, 'running');
  assert.equal(f.runs.length, 0);
  await assert.rejects(runExperimentPlan(f.options), has_code('awaiting-author'));
  assert.equal(existsSync(f.stateFile + '.lock'), false);
});

test('protected log/report paths cannot be accepted as execution evidence', async (t) => {
  const f = fixture(t);
  await assert.rejects(runExperimentPlan({ ...f.options, run: async () => 'milestones/experiment-plan.json' }), /protected/);
  assert.equal(read_state(f.stateFile).tasks.pilot.status, 'running');
  assert.equal(f.validations.length, 0);
  const other = fixture(t);
  await assert.rejects(runExperimentPlan({ ...other.options, validate: async () => ({ success: true, data: 'analysis-plan.md' }) }), has_code('validate-failed'));
});

test('malformed checkpoints fail closed and do not restart execution', async (t) => {
  const f = fixture(t);
  await runExperimentPlan(f.options);
  const state = read_state(f.stateFile);
  state.tasks.pilot.attempts = 4;
  writeFileSync(f.stateFile, JSON.stringify(state));
  await assert.rejects(runExperimentPlan(f.options), /Invalid task checkpoint/);
  writeFileSync(f.stateFile, '{ malformed');
  await assert.rejects(runExperimentPlan(f.options), SyntaxError);
  assert.equal(f.runs.length, 1);
});

test('simultaneous invocations cannot dispatch duplicate pilots', async (t) => {
  const f = fixture(t);
  const run = f.options.run;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const first = runExperimentPlan({ ...f.options, run: async (...args) => { entered(); await wait; return run(...args); } });
  await started;
  try { await assert.rejects(runExperimentPlan(f.options), has_code('busy')); }
  finally { release(); }
  await first;
  assert.equal(f.runs.length, 1);
});
