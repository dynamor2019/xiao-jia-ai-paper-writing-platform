import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolResult } from '../types.js';

interface PlanTask { command: string; resultsFile: string }
interface BatchTask extends PlanTask { id: string; question: string }

export interface ExperimentPlan {
  schemaVersion: 1;
  executionMode?: 'run-experiments' | 'provided-data';
  researchQuestion: string;
  originalHypothesis: string;
  pilot?: PlanTask;
  sourceFiles?: string[];
  batches: BatchTask[];
}

export interface ExperimentValidationInput {
  resultsFile: string;
  logFile: string;
  outputDir: string;
  protocolFile: string;
}

interface RunBudget { cwd: string; timeoutMs: number; signal: AbortSignal; sharedDataRoot?: string }
interface AuthorResolution {
  taskId: string;
  action: 'retry' | 'validate' | 'stop';
  reason: string;
  logFile?: string;
}
interface TaskCheckpoint {
  status: 'pending' | 'running' | 'executed' | 'validated' | 'failed' | 'awaiting-author';
  phase: 'run' | 'validate';
  attempts: number;
  validationAttempts: number;
  resultsHash?: string;
  logFile?: string;
  logHash?: string;
  reportFile?: string;
  reportHash?: string;
  error?: string;
  halt?: 'billing' | 'interrupted' | 'author-stop';
  outputDir?: string;
  validationOutputDir?: string;
  authorResolution?: AuthorResolution;
}

export interface ExperimentPlanCheckpoint {
  schemaVersion: 1;
  planHash: string;
  protocolHash: string;
  sourceHashes?: Record<string, string>;
  tasks: Record<string, TaskCheckpoint>;
}

export interface ExperimentPlanOptions {
  projectDir: string;
  sharedDataRoot?: string;
  sharedDataScope?: string;
  phase: 'pilot' | 'formal';
  planFile?: string;
  protocolFile: string;
  run: (command: string, outputDir: string, resultsFile: string, budget: RunBudget) => Promise<string | ToolResult<string>>;
  validate: (input: ExperimentValidationInput) => Promise<ToolResult<string>>;
  save?: (checkpoint: ExperimentPlanCheckpoint) => void | Promise<void>;
  timeoutMs?: number;
  maxBatches?: number;
  expectedResearchQuestion?: string;
  // If supplied, the last formal batch must produce the pipeline's main result.
  resultsFile?: string;
  // The caller must obtain explicit author approval and resolve any live execution first.
  authorResolution?: AuthorResolution;
}

export class ExperimentPlanError extends Error {
  /** Expose a stable stop reason without coupling this module to provider APIs. */
  constructor(public readonly code: string, message: string, public readonly taskId?: string) {
    super(message);
    this.name = 'ExperimentPlanError';
  }
}

interface Task extends PlanTask { id: string }
interface Context {
  root: string;
  sharedDataRoot?: string;
  sharedDataScope?: string;
  planFile: string;
  protocolFile: string;
  stateFile: string;
  tasks: Task[];
  sourceFiles: string[];
  sourceHashes: Record<string, string>;
  state: ExperimentPlanCheckpoint;
  options: ExperimentPlanOptions;
  timeoutMs: number;
}
const AUDIT_DIR = 'experiments/experiment-plan-audit';
const STATE_FILE = '.dsh-state/experiment-plan-state.json';
const MAX_ATTEMPTS = 3;

/** Identify filesystem absence without suppressing permissions or other I/O failures. */
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Check containment using path components, including Windows drive boundaries. */
function inside(root: string, file: string): boolean {
  const part = relative(root, file);
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

/** Compare canonical absolute paths with the platform's case sensitivity. */
function same_path(left: string, right: string): boolean {
  return relative(left, right) === '';
}

/** Resolve against the project and refuse symlink/junction or hardlink output aliases. */
async function project_path(root: string, input: string, output = false): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) throw new Error('A project-relative file path is required');
  const file = resolve(root, input);
  if (!inside(root, file)) throw new Error('Path must be inside the project: ' + input);
  const parts = relative(root, file).split(sep);
  if (parts.some((part) => /[:]|[. ]$/.test(part))) throw new Error('Ambiguous project path: ' + input);
  if (output && parts.some((part) => ['.dsh-state', 'milestones'].includes(part.toLowerCase()))) {
    throw new Error('Experiment output cannot overwrite protected .dsh-state or milestones data');
  }
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symlink/junction paths are not allowed: ' + input);
      if (output && info.isFile() && info.nlink > 1) throw new Error('Hardlinked output is not allowed');
      current = await realpath(current);
      if (!inside(root, current) || (output && relative(root, current).split(sep)
        .some((name) => ['.dsh-state', 'milestones'].includes(name.toLowerCase())))) throw new Error('Canonical path escapes project or protected output boundary');
    } catch (error) { if (!missing(error)) throw error; }
  }
  return current;
}

/** Allow result files only below the project result directory, before and after realpath checks. */
async function result_path(root: string, input: string): Promise<string> {
  const directory = resolve(root, 'experiments/results');
  if (!inside(directory, resolve(root, input))) throw new Error('Results must be strictly inside project experiments/results');
  const file = await project_path(root, input, true);
  if (!inside(directory, file)) throw new Error('Resolved results must be strictly inside project experiments/results');
  return file;
}

/** Resolve explicit shared references while rejecting traversal and linked paths. */
async function shared_path(sharedRoot: string | undefined, input: string, allowed: string[], output = false): Promise<string> {
  if (!sharedRoot || !input.startsWith('@shared/')) throw new Error('Shared data path requires PAPER_SHARED_DATA_ROOT and an @shared/ reference');
  const parts = input.slice('@shared/'.length).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || /[:]|[. ]$/.test(part))) {
    throw new Error('Invalid shared data path: ' + input);
  }
  if (!allowed.includes(parts[0])) throw new Error('Shared data path must use an approved namespace: ' + input);
  await mkdir(resolve(sharedRoot), { recursive: true });
  const base = await realpath(resolve(sharedRoot));
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Shared data symlink/junction paths are not allowed: ' + input);
      if (output && info.isFile() && info.nlink > 1) throw new Error('Hardlinked shared output is not allowed: ' + input);
      current = await realpath(current);
      if (!inside(base, current)) throw new Error('Shared data path escapes its configured root: ' + input);
    } catch (error) { if (!missing(error)) throw error; }
  }
  return current;
}

async function input_path(root: string, input: string, sharedRoot?: string): Promise<string> {
  if (!input.startsWith('@shared/')) return project_path(root, input);
  if (input.startsWith('@shared/datasets/') && input.slice('@shared/datasets/'.length).split('/').length < 3) {
    throw new Error('Shared datasets must include a dataset ID and version');
  }
  return shared_path(sharedRoot, input, ['datasets', 'processed']);
}

async function result_path_scoped(root: string, input: string, sharedRoot?: string, scope?: string): Promise<string> {
  if (isAbsolute(input) && sharedRoot && scope) {
    const sharedRelative = relative(await realpath(resolve(sharedRoot)), await realpath(resolve(input)).catch(() => resolve(input)));
    if (sharedRelative && !sharedRelative.startsWith('..' + sep) && !isAbsolute(sharedRelative)) {
      input = '@shared/' + sharedRelative.split(sep).join('/');
    }
  }
  if (!input.startsWith('@shared/')) return result_path(root, input);
  if (!scope || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(scope)) throw new Error('Shared results require a valid paper data scope');
  const parts = input.slice('@shared/'.length).split('/');
  if (parts[0] !== 'processed' || parts[1] !== scope || parts.length < 4) {
    throw new Error('Shared experiment results must be namespaced under processed/<paper-scope>/<run-id>');
  }
  return shared_path(sharedRoot, input, ['processed'], true);
}

/** Bind checkpoints to exact bytes, accepting only nonempty regular files. */
async function fingerprint(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('Missing nonempty evidence file: ' + file);
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** Require explicit commands/questions; never generate experiments from generic prose. */
function parse_plan(bytes: Buffer, max_batches: number): ExperimentPlan {
  const plan = JSON.parse(bytes.toString('utf8')) as ExperimentPlan;
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const mode = plan?.executionMode ?? 'run-experiments';
  if (!plan || plan.schemaVersion !== 1 || !text(plan.researchQuestion) || !text(plan.originalHypothesis)
    || !['run-experiments', 'provided-data'].includes(mode)
    || !Array.isArray(plan.batches) || plan.batches.length < 1 || plan.batches.length > max_batches) {
    throw new Error('Invalid experiment plan: schemaVersion 1, executionMode, question/hypothesis and 1..31 analysis batches required');
  }
  if (mode === 'run-experiments' && !plan.pilot) throw new Error('run-experiments mode requires a feasibility pilot');
  if (mode === 'provided-data' && (!Array.isArray(plan.sourceFiles) || plan.sourceFiles.length === 0
    || plan.sourceFiles.some((file) => !text(file)))) throw new Error('provided-data mode requires project-relative or @shared/datasets sourceFiles');
  const ids = new Set<string>(plan.pilot ? ['pilot'] : []);
  for (const task of [...(plan.pilot ? [plan.pilot] : []), ...plan.batches]) {
    if (!task || !text(task.command) || !text(task.resultsFile)) throw new Error('Every task requires an explicit command and resultsFile');
  }
  for (const task of plan.batches) {
    if (!text(task.id) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(task.id)
      || ids.has(task.id.toLowerCase()) || !text(task.question)) throw new Error('Batch IDs must be unique; every batch needs a question');
    ids.add(task.id.toLowerCase());
  }
  return plan;
}

/** Reject output/input collisions and shared result files before creating state. */
async function resolve_tasks(root: string, plan: ExperimentPlan, inputs: string[], sharedRoot?: string, scope?: string): Promise<Task[]> {
  const tasks: Task[] = [];
  const planned = [...(plan.executionMode === 'provided-data' || !plan.pilot ? [] : [{ ...plan.pilot, id: 'pilot' }]), ...plan.batches];
  for (const task of planned) {
    const resultsFile = await result_path_scoped(root, task.resultsFile, sharedRoot, scope);
    const reserved = resolve(root, AUDIT_DIR);
    if (inputs.some((file) => same_path(file, resultsFile) || inside(resultsFile, file)) || same_path(resultsFile, reserved) || inside(reserved, resultsFile)
      || tasks.some((previous) => same_path(previous.resultsFile, resultsFile)
        || inside(previous.resultsFile, resultsFile) || inside(resultsFile, previous.resultsFile))) {
      throw new Error('Pilot/formal results must be distinct and cannot overwrite plan, protocol or audit artifacts');
    }
    tasks.push({ id: task.id, command: task.command, resultsFile });
  }
  return tasks;
}

/** Bind existing datasets to the plan without treating them as newly executed experiments. */
async function resolve_sources(root: string, plan: ExperimentPlan, planFile: string, protocolFile: string, sharedRoot?: string): Promise<{ files: string[]; hashes: Record<string, string> }> {
  const files = await Promise.all((plan.sourceFiles || []).map((file) => input_path(root, file, sharedRoot)));
  if (new Set(files).size !== files.length || files.some((file) => same_path(file, planFile) || same_path(file, protocolFile))) {
    throw new Error('Provided source files must be unique and cannot alias the plan or protocol');
  }
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = await fingerprint(file);
  return { files, hashes };
}

/** Fail closed on malformed or foreign checkpoints instead of restarting experiments. */
async function load_state(ctx: Context): Promise<void> {
  let saved: ExperimentPlanCheckpoint;
  try { saved = JSON.parse(await readFile(ctx.stateFile, 'utf8')); }
  catch (error) { if (missing(error)) return; throw error; }
  if (!saved || saved.schemaVersion !== 1 || saved.planHash !== ctx.state.planHash
    || saved.protocolHash !== ctx.state.protocolHash
    || JSON.stringify(saved.sourceHashes || {}) !== JSON.stringify(ctx.sourceHashes)) {
    throw new ExperimentPlanError('binding-changed', 'Plan, protocol or provided source fingerprints changed; explicit amendment required');
  }
  if (!saved.tasks || Object.keys(saved.tasks).length !== ctx.tasks.length) throw new Error('Invalid task checkpoints');
  for (const task of ctx.tasks) {
    const record = saved.tasks[task.id];
    if (!Object.hasOwn(saved.tasks, task.id) || !record || !['pending', 'running', 'executed', 'validated', 'failed', 'awaiting-author'].includes(record.status)
      || !['run', 'validate'].includes(record.phase) || !Number.isInteger(record.attempts)
      || record.attempts < 0 || record.attempts > MAX_ATTEMPTS || !Number.isInteger(record.validationAttempts)
      || record.validationAttempts < 0 || record.validationAttempts > MAX_ATTEMPTS
      || (record.status === 'pending' && (record.attempts !== 0 || record.validationAttempts !== 0))
      || (record.status !== 'pending' && record.attempts < 1)) throw new Error('Invalid task checkpoint: ' + task.id);
  }
  ctx.state = saved;
}

/** Atomically persist independently of the workflow saver; notify only after rename. */
async function persist(ctx: Context): Promise<void> {
  await project_path(ctx.root, ctx.stateFile);
  const temporary = ctx.stateFile + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(ctx.state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, ctx.stateFile);
  } finally { await unlink(temporary).catch((error) => { if (!missing(error)) throw error; }); }
  await ctx.options.save?.(structuredClone(ctx.state));
}

/** Detect input edits made during execution before permitting validation or reuse. */
async function verify_binding(ctx: Context): Promise<void> {
  await project_path(ctx.root, ctx.planFile);
  await project_path(ctx.root, ctx.protocolFile);
  if (await fingerprint(ctx.planFile) !== ctx.state.planHash || await fingerprint(ctx.protocolFile) !== ctx.state.protocolHash) {
    throw new ExperimentPlanError('binding-changed', 'Plan/protocol fingerprints changed; explicit amendment required');
  }
  for (const file of ctx.sourceFiles) {
    if (await fingerprint(file) !== ctx.sourceHashes[file]) throw new ExperimentPlanError('binding-changed', 'Provided source data changed; explicit amendment and revalidation required');
  }
}

/** Keep logs/reports separate from results and previously claimed audit evidence. */
async function evidence_path(ctx: Context, file: string, task_id: string): Promise<string> {
  const full = await project_path(ctx.root, file, true);
  if ([ctx.planFile, ctx.protocolFile, ...ctx.tasks.map((task) => task.resultsFile)].some((path) => same_path(path, full))) throw new Error('Evidence path collides with research inputs/results');
  for (const [id, record] of Object.entries(ctx.state.tasks)) {
    if (id !== task_id && [record.logFile, record.reportFile].some((path) => path && same_path(path, full))) throw new Error('Tasks cannot share audit evidence');
  }
  return full;
}

/** Recheck result, log and report bytes; an integrity failure never reruns execution. */
async function verify_evidence(ctx: Context, task: Task): Promise<void> {
  const record = ctx.state.tasks[task.id];
  try {
    await result_path_scoped(ctx.root, task.resultsFile, ctx.sharedDataRoot, ctx.sharedDataScope);
    if (!record.resultsHash || !record.logFile || !record.logHash
      || await fingerprint(task.resultsFile) !== record.resultsHash
      || await fingerprint(await evidence_path(ctx, record.logFile, task.id)) !== record.logHash) throw new Error('Results/log changed');
    if (record.status === 'validated' && (!record.reportFile || !record.reportHash || same_path(record.reportFile, record.logFile)
      || await fingerprint(await evidence_path(ctx, record.reportFile, task.id)) !== record.reportHash)) throw new Error('Validation report changed');
  } catch (error) { throw new ExperimentPlanError('evidence-changed', String(error), task.id); }
}

/** Apply the same bounded deadline to injected execution and integrity validation. */
async function bounded<T>(callback: (budget: RunBudget) => Promise<T>, ctx: Context): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ExperimentPlanError('interrupted', 'Timeout: resolve the potentially live callback before retrying');
      controller.abort(error);
      reject(error);
    }, ctx.timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => callback({ cwd: ctx.root, timeoutMs: ctx.timeoutMs,
    signal: controller.signal, sharedDataRoot: ctx.sharedDataRoot })), deadline]); }
  finally { clearTimeout(timer); }
}

/** Unwrap lifecycle ToolResult failures without importing any execution/model code. */
function successful_path(reply: string | ToolResult<string>): string {
  if (typeof reply === 'string') return reply;
  if (!reply?.success) throw new Error(reply?.error || 'Injected callback failed');
  if (typeof reply.data !== 'string' || !reply.data.trim()) throw new Error('Callback must return an evidence path');
  return reply.data;
}

/** Persist billing pauses and uncertain interruptions without automatic retry. */
async function record_failure(ctx: Context, task: Task, error: unknown): Promise<never> {
  const record = ctx.state.tasks[task.id];
  const detail = error instanceof Error ? error.message : String(error);
  const fields = error as { code?: string; status?: number; statusCode?: number; name?: string } | null;
  const billing = fields?.status === 402 || fields?.statusCode === 402
    || /billing|insufficient[_\s-]*(quota|balance|credit|funds)|payment[_\s-]*required|\b402\b|\u4f59\u989d\u4e0d\u8db3/.test((detail + ' ' + fields?.code).toLowerCase());
  const interrupted = fields?.name === 'AbortError' || fields?.code === 'ABORT_ERR'
    || /interrupt|abort|cancelled|canceled|timeout|timed[_\s-]*out|SIGINT|SIGTERM/i.test(detail + ' ' + fields?.code)
    || (error instanceof ExperimentPlanError && error.code === 'interrupted');
  record.status = billing ? 'awaiting-author' : interrupted ? 'running' : 'failed';
  if (billing || interrupted) record.halt = billing ? 'billing' : 'interrupted';
  record.error = detail;
  await persist(ctx);
  throw new ExperimentPlanError(billing ? 'awaiting-author' : interrupted ? 'interrupted' : record.phase + '-failed', detail, task.id);
}

/** Give each invocation its own audit directory without using protected data paths. */
async function audit_directory(ctx: Context, task: Task, attempt: string): Promise<string> {
  const output = await project_path(ctx.root, join(AUDIT_DIR, task.id, attempt), true);
  if (ctx.tasks.some((item) => same_path(item.resultsFile, output) || inside(item.resultsFile, output))
    || [ctx.planFile, ctx.protocolFile].some((file) => same_path(file, output) || inside(output, file))) throw new Error('Audit directory collides with research input');
  await mkdir(output, { recursive: true });
  return output;
}

/** Record running before dispatch; a lost response therefore cannot duplicate a run. */
async function execute_task(ctx: Context, task: Task): Promise<void> {
  const record = ctx.state.tasks[task.id];
  if (record.attempts >= MAX_ATTEMPTS) throw new ExperimentPlanError('attempts-exhausted', 'Execution attempts exhausted', task.id);
  if (record.attempts === 0) {
    const existingResult = await lstat(task.resultsFile).catch((error) => { if (missing(error)) return undefined; throw error; });
    if (existingResult) throw new ExperimentPlanError('output-collision', 'Refusing to overwrite an existing experiment result; choose a new run-id', task.id);
  }
  const output = await audit_directory(ctx, task, 'run-' + (record.attempts + 1));
  await result_path_scoped(ctx.root, task.resultsFile, ctx.sharedDataRoot, ctx.sharedDataScope);
  await mkdir(dirname(task.resultsFile), { recursive: true });
  record.status = 'running';
  record.phase = 'run';
  record.attempts += 1;
  record.outputDir = output;
  await persist(ctx);
  let reply: string | ToolResult<string>;
  try {
    reply = await bounded((budget) => ctx.options.run(task.command, output, task.resultsFile, budget), ctx);
    if (typeof reply !== 'string' && !reply?.success) successful_path(reply);
  } catch (error) { return record_failure(ctx, task, error); }
  await verify_binding(ctx);
  record.logFile = await evidence_path(ctx, successful_path(reply), task.id);
  record.logHash = await fingerprint(record.logFile);
  await result_path_scoped(ctx.root, task.resultsFile, ctx.sharedDataRoot, ctx.sharedDataScope);
  record.resultsHash = await fingerprint(task.resultsFile);
  record.status = 'executed';
  record.phase = 'validate';
  delete record.error;
  await persist(ctx);
}

/** Accept basic integrity/feasibility only; final scientific/reproduction gates remain external. */
async function validate_task(ctx: Context, task: Task): Promise<void> {
  const record = ctx.state.tasks[task.id];
  await verify_evidence(ctx, task);
  if (record.validationAttempts >= MAX_ATTEMPTS) throw new ExperimentPlanError('attempts-exhausted', 'Validation attempts exhausted', task.id);
  const outputDir = await audit_directory(ctx, task, 'validate-' + (record.validationAttempts + 1));
  record.status = 'running';
  record.phase = 'validate';
  record.validationAttempts += 1;
  record.validationOutputDir = outputDir;
  await persist(ctx);
  try {
    const reply = await bounded(() => ctx.options.validate({ resultsFile: task.resultsFile, logFile: record.logFile!, outputDir, protocolFile: ctx.protocolFile }), ctx);
    const report = await evidence_path(ctx, successful_path(reply), task.id);
    if (same_path(report, record.logFile!)) throw new Error('Validation report must be distinct from execution log');
    await verify_binding(ctx);
    await verify_evidence(ctx, task);
    record.reportHash = await fingerprint(report);
    record.reportFile = report;
  } catch (error) { return record_failure(ctx, task, error); }
  record.status = 'validated';
  delete record.error;
  await persist(ctx);
}

/** Resolve one stopped task only after explicit author instruction, preserving counters. */
async function resolve_author(ctx: Context): Promise<void> {
  const request = ctx.options.authorResolution;
  if (!request) return;
  const task = ctx.tasks.find((item) => item.id === request.taskId);
  if (!task || !request.reason?.trim() || !['retry', 'validate', 'stop'].includes(request.action)) throw new Error('Invalid explicit author resolution');
  const record = ctx.state.tasks[task.id];
  if (!['running', 'awaiting-author'].includes(record.status)) throw new Error('Author resolution requires an interrupted/billing checkpoint');
  if (request.action === 'retry' && (record.phase !== 'run' || record.halt !== 'billing')) {
    throw new Error('Only explicit billing recovery may retry execution; interrupted experiments cannot rerun');
  }
  if (request.action === 'validate' && record.phase === 'run') {
    record.logFile = await evidence_path(ctx, request.logFile || '', task.id);
    record.logHash = await fingerprint(record.logFile);
    await result_path_scoped(ctx.root, task.resultsFile, ctx.sharedDataRoot, ctx.sharedDataScope);
    record.resultsHash = await fingerprint(task.resultsFile);
  }
  record.authorResolution = { ...request };
  record.status = request.action === 'stop' ? 'awaiting-author' : request.action === 'retry' ? 'failed' : 'executed';
  if (request.action === 'stop') record.halt = 'author-stop';
  if (request.action === 'validate') record.phase = 'validate';
  await persist(ctx);
}

/** Serialize processes; stale locks can be cleared only with an explicit author resolution. */
async function acquire_lock(ctx: Context, recovered = false): Promise<() => Promise<void>> {
  const path = await project_path(ctx.root, ctx.stateFile + '.lock');
  try {
    const handle = await open(path, 'wx');
    try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await readFile(path, 'utf8'));
    let alive = true;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
    }
    if (alive || recovered || !ctx.options.authorResolution) throw new ExperimentPlanError('busy', 'Experiment plan is locked; a stale owner requires explicit author resolution');
    await unlink(path);
    return acquire_lock(ctx, true);
  }
  return () => unlink(path);
}

/** Resolve and bind an optional plan before any execution or checkpoint mutation. */
async function prepare(options: ExperimentPlanOptions): Promise<Context | undefined> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const max_batches = options.maxBatches ?? 31;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000
    || !Number.isInteger(max_batches) || max_batches < 1 || max_batches > 31
    || !['pilot', 'formal'].includes(options.phase)
    || typeof options.run !== 'function' || typeof options.validate !== 'function') throw new Error('Invalid experiment budget/callbacks/phase');
  const root = await realpath(resolve(options.projectDir));
  const planFile = await project_path(root, options.planFile ?? 'milestones/experiment-plan.json');
  let bytes: Buffer;
  try { bytes = await readFile(planFile); } catch (error) { if (!options.planFile && missing(error)) return; throw error; }
  const plan = parse_plan(bytes, max_batches);
  if (options.expectedResearchQuestion !== undefined && plan.researchQuestion !== options.expectedResearchQuestion) {
    throw new Error('Plan researchQuestion must equal the selected researchQuestion');
  }
  const protocolFile = await project_path(root, options.protocolFile);
  const stateFile = await project_path(root, STATE_FILE);
  const sharedDataRoot = options.sharedDataRoot ? resolve(options.sharedDataRoot) : undefined;
  const sources = await resolve_sources(root, plan, planFile, protocolFile, sharedDataRoot);
  const tasks = await resolve_tasks(root, plan, [planFile, protocolFile, ...sources.files], sharedDataRoot, options.sharedDataScope);
  if ([planFile, protocolFile].some((file) => same_path(file, stateFile) || same_path(file, stateFile + '.lock')
    || inside(resolve(root, AUDIT_DIR), file))) throw new Error('Plan/protocol cannot occupy managed checkpoint/audit paths');
  if (options.resultsFile && !same_path(tasks.at(-1)!.resultsFile,
    await result_path_scoped(root, options.resultsFile, sharedDataRoot, options.sharedDataScope))) {
    throw new Error('Last formal batch must equal the configured main resultsFile');
  }
  const state: ExperimentPlanCheckpoint = { schemaVersion: 1, planHash: createHash('sha256').update(bytes).digest('hex'),
    protocolHash: await fingerprint(protocolFile), sourceHashes: sources.hashes, tasks: Object.fromEntries(tasks.map((task) => [task.id,
      { status: 'pending', phase: 'run', attempts: 0, validationAttempts: 0 }])) };
  return { root, sharedDataRoot, sharedDataScope: options.sharedDataScope, planFile, protocolFile, stateFile,
    tasks, sourceFiles: sources.files, sourceHashes: sources.hashes, state, options, timeoutMs };
}

/** Run the pilot or already-gated formal tasks; pilot returns [], formal returns ordered result paths. */
export async function runExperimentPlan(options: ExperimentPlanOptions): Promise<string[]> {
  const ctx = await prepare(options);
  if (!ctx) return [];
  const tasks = ctx.tasks;
  await mkdir(dirname(ctx.stateFile), { recursive: true });
  const release = await acquire_lock(ctx);
  try {
    await load_state(ctx);
    await verify_binding(ctx);
    for (const task of tasks) if (ctx.state.tasks[task.id].resultsHash) await verify_evidence(ctx, task);
    const plan = JSON.parse(await readFile(ctx.planFile, 'utf8')) as ExperimentPlan;
    const pilot = ctx.tasks.find((task) => task.id === 'pilot');
    if (options.phase === 'formal' && plan.executionMode !== 'provided-data' && ctx.state.tasks.pilot.status !== 'validated') {
      throw new ExperimentPlanError('pilot-required', 'Formal execution requires the same completed validated pilot', 'pilot');
    }
    await resolve_author(ctx);
    if (options.phase === 'pilot' && !pilot) await persist(ctx);
    const selected = options.phase === 'pilot' ? (pilot ? [pilot] : []) : tasks.filter((task) => task.id !== 'pilot');
    for (const task of selected) {
      const record = ctx.state.tasks[task.id];
      if (record.status === 'running' || record.status === 'awaiting-author') throw new ExperimentPlanError('awaiting-author', 'Explicit author resolution required before resuming ' + task.id, task.id);
      await verify_binding(ctx);
      if (task.id !== 'pilot' && pilot) await verify_evidence(ctx, pilot);
      if (record.status === 'validated') { await verify_evidence(ctx, task); continue; }
      if (record.phase === 'run') await execute_task(ctx, task);
      await validate_task(ctx, task);
    }
    await verify_binding(ctx);
    for (const task of tasks) if (ctx.state.tasks[task.id].status === 'validated') await verify_evidence(ctx, task);
    return options.phase === 'pilot' ? [] : tasks.filter((task) => task.id !== 'pilot').map((task) => task.resultsFile);
  } finally { await release(); }
}
