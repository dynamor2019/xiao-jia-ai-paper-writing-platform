import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { approvedReviewArtifact, checkReview, formatReviewLetter, readReview, reviewHash, ReviewError, reviewPath, saveReview } from './reviewer-response-store.mjs';

const activeJobs = new Map();
const MAX_ROUND_MS = 90000;

/** Aliases and Windows path case must not create concurrent operations for one physical paper. */
function jobKey(root) { const path = realpathSync(root); return process.platform === 'win32' ? path.toLowerCase() : path; }

/** Validate a portal URL without changing DNS, proxies, model transport or browser authentication. */
export function portalUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new ReviewError('请填写完整的投稿系统网址'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password) throw new ReviewError('投稿页面须为 HTTPS，且网址不能包含账户密码');
  return url.href;
}

/** Make an exact, author-approved mapping. Nothing infers which textbox belongs to which reviewer. */
export function prepareEgoFill(root, state, body) {
  if (body.confirmed !== true || body.revision !== state.revision) throw new ReviewError('请核对当前版本后明确确认填写');
  if (!checkReview(root, state).ready) throw new ReviewError('请先完成逐条证据核对和作者确认');
  if (state.browser?.requiresRead) throw new ReviewError('上次页面操作未完整确认，请先重新读取页面');
  if (!state.browser?.source || !Array.isArray(body.mappings) || !body.mappings.length) throw new ReviewError('先读取页面，再映射回复框');
  if (new Set(body.mappings.map(m => m.key)).size !== body.mappings.length || new Set(body.mappings.map(m => m.id)).size !== body.mappings.length) throw new ReviewError('意见或回复框不能重复映射');
  if (body.mappings.some(m => m.id === 'all') && body.mappings.length > 1) throw new ReviewError('完整回复信映射不能与逐条映射同时使用');
  return body.mappings.map(mapping => {
    const item = mapping.id === 'all' ? { id: 'all', response: formatReviewLetter(state) } : state.comments.find(c => c.id === mapping.id);
    const field = state.browser.fields?.find(f => f.key === mapping.key);
    if (!item || !field) throw new ReviewError('意见或页面回复框不存在，请重新读取');
    return { id: item.id, selector: field.selector, expectedValue: field.value, expectedLabel: field.identityLabel ?? field.label, response: item.response };
  });
}

/** Start one bounded Ego round per project; callers poll the real process instead of starting duplicates. */
export function startEgoJob(options, body) {
  const { root, stateRoot, execute = executeEgo } = options;
  const existing = egoJobStatus(root);
  if (existing?.status === 'running') throw new ReviewError('Ego 当前操作仍在运行，请等待该任务完成', 409);
  const state = readReview(root);
  if (body.revision !== state.revision) throw new ReviewError('返修记录已变化，请刷新', 409);
  const operation = body.operation;
  if (!['open', 'read', 'fill', 'upload', 'handoff', 'resume', 'finish'].includes(operation)) throw new ReviewError('未知 Ego 操作');
  const input = { operation: operation === 'resume' ? 'read' : operation, resume: operation === 'resume',
    spaceName: `DSH-review-${reviewHash([root, state.round]).slice(0, 12)}`, spaceId: state.browser?.spaceId,
    page: state.browser?.page || 'p1', selector: body.selector || 'main, [role="main"], article', keepPage: body.keepPage === true };
  if (input.selector.length > 1000) throw new ReviewError('意见区域选择器过长');
  if (operation === 'open') input.url = portalUrl(body.url);
  else if (!input.spaceId) throw new ReviewError('请先打开投稿页面');
  if (operation === 'fill') { input.url = state.browser.url; input.mappings = prepareEgoFill(root, state, body); }
  if (operation === 'upload') {
    if (body.confirmed !== true) throw new ReviewError('请先确认允许上传回复文件');
    if (state.browser?.requiresRead || existing.interrupted) throw new ReviewError('上次操作中断，请先重新读取投稿页面');
    const field = state.browser?.uploads?.find(f => f.key === body.key);
    if (!field) throw new ReviewError('请先读取页面并选择明确的文件上传框');
    input.url = state.browser.url; input.selector = field.selector;
    input.file = approvedReviewArtifact(root, body.file).path;
  }
  const dir = join(stateRoot, 'reviewer-browser', reviewHash(root).slice(0, 24));
  mkdirSync(dir, { recursive: true });
  if (operation === 'fill' && existing.interrupted) throw new ReviewError('上次操作中断，请先重新读取投稿页面');
  const job = { id: randomUUID(), status: 'running', operation, ownerPid: process.pid, startedAt: new Date().toISOString() };
  persistJob(root, job);
  activeJobs.set(jobKey(root), job);
  job.completion = completeJob({ root, dir, execute }, input, job);
  return publicJob(job);
}

/** Expose a compact job receipt without task payloads, credentials or executable source. */
function publicJob(job) { const { completion, ...view } = job; return view; }

/** Poll a single process-backed job; an observation timeout never starts a replacement. */
export function egoJobStatus(root) {
  const job = activeJobs.get(jobKey(root));
  if (job) return publicJob(job);
  const path = reviewPath(root, 'reviews/browser-operation.json', true);
  if (!existsSync(path)) return { status: 'idle' };
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  if (saved.status !== 'running' || isLive(saved.cliPid) || isLive(saved.ownerPid)) return saved;
  return { ...saved, status: 'failed', interrupted: true, error: '上次 Ego 进程已退出；页面可能有部分变化，请重新读取后核对' };
}

/** Verify a recorded process handle instead of treating a stale lock or elapsed time as live work. */
function isLive(pid) { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

/** One bounded receipt survives host restarts, without keeping task scripts or page dumps. */
function persistJob(root, job) {
  const path = reviewPath(root, 'reviews/browser-operation.json', true);
  mkdirSync(dirname(path), { recursive: true });
  const pending = reviewPath(root, 'reviews/browser-operation.pending.json', true);
  writeFileSync(pending, JSON.stringify(publicJob(job)), 'utf8'); renameSync(pending, path);
}

/** Join the running process for tests or orderly host shutdown. */
export async function waitEgoJob(root) { await activeJobs.get(jobKey(root))?.completion; return egoJobStatus(root); }

/** Persist browser receipts against the latest revision, preserving simultaneous agent edits. */
async function completeJob(options, input, job) {
  const { root, dir, execute } = options;
  try {
    const result = await execute(dir, input, job.id, pid => { job.cliPid = pid; persistJob(root, job); });
    const state = readReview(root);
    state.browser = input.operation === 'finish' && result.closed ? undefined : { ...state.browser, ...result };
    if (state.browser) {
      state.browser.requiresRead = Boolean(result.error);
      if (!result.error) delete state.browser.error;
    }
    if (input.operation === 'fill') state.browser.fields = undefined;
    if (input.operation === 'upload') state.browser.uploads = undefined;
    state.lastBrowserJob = { ...publicJob(job), status: result.error ? 'failed' : 'completed', endedAt: new Date().toISOString(),
      error: result.error, filled: result.filled, uploaded: result.uploaded, submitted: false };
    saveReview(root, state.revision, state);
    Object.assign(job, state.lastBrowserJob);
  } catch (e) {
    Object.assign(job, { status: 'failed', error: e.message, interrupted: true, endedAt: new Date().toISOString() });
  }
  persistJob(root, job);
}

/** Run the installed CLI directly, no shell and no interpolation of untrusted review text. */
async function executeEgo(dir, input, id, onSpawn) {
  const payloadPath = join(dir, `${id}.json`), scriptPath = join(dir, `${id}.mjs`), resultPath = join(dir, `${id}.result.json`);
  const moduleUrl = new URL('./reviewer-ego-round.mjs', import.meta.url).href;
  writeFileSync(payloadPath, JSON.stringify({ ...input, resultPath }), 'utf8');
  writeFileSync(scriptPath, `const { runEgoRound } = await import(${JSON.stringify(moduleUrl)}); await runEgoRound(${JSON.stringify(payloadPath)});`, 'utf8');
  try {
    await runCli(['nodejs', '-e', `await import(${JSON.stringify(pathToFileURL(scriptPath).href)})`], onSpawn);
    if (!existsSync(resultPath)) throw new ReviewError('Ego 未返回结果；请检查浏览器控制权，勿重复填写');
    return JSON.parse(readFileSync(resultPath, 'utf8'));
  } finally {
    for (const file of [payloadPath, scriptPath, resultPath]) if (existsSync(file)) unlinkSync(file);
  }
}

/** A fixed timeout stops only our CLI child, never the browser or unrelated scientific work. */
function runCli(args, onSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn('ego-browser', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], shell: false });
    child.once('spawn', () => { try { onSpawn?.(child.pid); } catch (e) { child.kill(); clearTimeout(timer); reject(e); } });
    const timer = setTimeout(() => { child.kill(); reject(new ReviewError('Ego 操作超时；页面可能已有部分变化，请重新读取后核对，不自动重试')); }, MAX_ROUND_MS);
    child.once('error', error => { clearTimeout(timer); reject(new ReviewError(error.code === 'ENOENT' ? '未安装 ego-browser：请按 Ego 官方安装指南安装并登录浏览器' : error.message)); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new ReviewError('Ego 操作停止；请检查浏览器控制权或登录状态后再继续')); });
  });
}
