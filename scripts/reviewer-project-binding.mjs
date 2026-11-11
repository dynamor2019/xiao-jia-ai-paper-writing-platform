import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ReviewError } from './reviewer-response-store.mjs';

/** Validate the native session ID before it may be used as a storage filename. */
export function reviewSessionId(value) {
  if (typeof value !== 'string' || !/^session-[\w-]{1,100}$/.test(value)) throw new ReviewError('缺少有效会话编号');
  return value;
}

/** Read a review-only binding without modifying paper-run records or starting a pipeline. */
export function reviewerProject(options, id) {
  reviewSessionId(id);
  const current = options.resolveProject(id);
  const file = join(options.stateRoot, 'reviewer-projects', `${id}.json`);
  if (!existsSync(file)) return current;
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  if (saved.version !== 1 || saved.sessionId !== id) throw new ReviewError('返修目录绑定损坏，请保留并恢复备份');
  if (current && projectKey(current) !== projectKey(saved.project)) throw new ReviewError('本会话的论文流水线目录与返修目录不一致，请核对绑定，不能混写项目', 409);
  return saved.project;
}

/** Canonicalize physical folders so Windows case or directory aliases do not become different papers. */
function projectKey(root) { const path = realpathSync(root); return process.platform === 'win32' ? path.toLowerCase() : path; }

/** Only an explicit authenticated author action can select an existing local paper folder. */
export function bindReviewerProject(options, body) {
  const id = reviewSessionId(body.sessionId);
  if (body.confirmed !== true) throw new ReviewError('请明确确认接入现有稿件目录');
  if (typeof body.project !== 'string' || !isAbsolute(body.project) || /[\0]/.test(body.project)) throw new ReviewError('请填写现有论文目录的绝对路径');
  const project = realpathSync(body.project);
  if (!statSync(project).isDirectory()) throw new ReviewError('选择的不是论文目录');
  const current = options.resolveProject(id);
  if (current && projectKey(current) !== projectKey(project)) throw new ReviewError('当前会话已绑定另一篇论文，请新建会话后接入', 409);
  const dir = join(options.stateRoot, 'reviewer-projects'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`), pending = join(dir, `${id}.pending.json`);
  writeFileSync(pending, JSON.stringify({ version: 1, sessionId: id, project, confirmedAt: new Date().toISOString() }), 'utf8');
  renameSync(pending, file);
  return project;
}
