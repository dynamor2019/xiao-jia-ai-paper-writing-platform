import 'dotenv/config';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULT_DATA_ROOT = join(process.env.USERPROFILE || homedir(), 'Documents', 'XiaoJiaAI Data');
const DATA_ROOT = resolve(process.env.PAPER_DATA_ROOT || DEFAULT_DATA_ROOT);
const STATE_ROOT = resolve(DATA_ROOT, process.env.PAPER_STATE_DIR || '.dsh-state');
const REPORT_DIR = join(STATE_ROOT, 'cleanup-reports');
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  dryRun: true,
  logsDays: 14,
  tempDays: 3,
  backupDays: 30,
  npmCacheDays: null,
  dedupeExact: false,
};

const PROTECTED_SEGMENTS = new Set([
  'final', 'milestones', 'real_data', 'raw', 'input', 'references',
  'protected-customizations', 'experiments', 'delivery', 'figures', 'code',
]);

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (const arg of argv) {
    if (arg === '--apply') options.dryRun = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--logs-days=')) options.logsDays = Number(arg.split('=')[1]);
    else if (arg.startsWith('--temp-days=')) options.tempDays = Number(arg.split('=')[1]);
    else if (arg.startsWith('--backup-days=')) options.backupDays = Number(arg.split('=')[1]);
    else if (arg.startsWith('--npm-cache-days=')) options.npmCacheDays = Number(arg.split('=')[1]);
    else if (arg === '--dedupe-exact') options.dedupeExact = true;
    else throw new Error(`Unknown cleanup option: ${arg}`);
  }
  return options;
}

function olderThan(pathStat, days) {
  return NOW - pathStat.mtimeMs > days * DAY_MS;
}

function hasProtectedSegment(path) {
  return path.split(/[\\/]+/).some((segment) => PROTECTED_SEGMENTS.has(segment)
    || /^archive(?:s|[_-].*)?$/i.test(segment));
}

async function isInside(root, path) {
  let actualRoot;
  let actualPath;
  try {
    [actualRoot, actualPath] = await Promise.all([realpath(root), realpath(path)]);
  } catch {
    return false;
  }
  const rel = relative(actualRoot, actualPath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function walk(root, visitor, skippedDirectories = new Set(), rootValidated = false) {
  if (!existsSync(root)) return;
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || (!rootValidated && !await isInside(DATA_ROOT, root))) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name.toLowerCase())) continue;
    const fullPath = join(root, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await walk(fullPath, visitor, skippedDirectories, true);
    } else if (info.isFile()) {
      await visitor(fullPath, entry, false);
    }
  }
}

async function addFileMatches(actions, root, predicate, reason, skippedDirectories = new Set()) {
  await walk(root, async (path, _entry, isDirectory) => {
    if (isDirectory) return;
    const pathStat = await lstat(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || !await predicate(path, pathStat)
      || !await isInside(DATA_ROOT, path)) return;
    actions.push({
      type: 'file',
      path,
      bytes: pathStat.size,
      reason,
    });
  }, skippedDirectories);
}

async function addExpiredBackupMatches(actions, root, maxAgeDays) {
  const groups = new Map();
  await walk(root, async (path, _entry, isDirectory) => {
    if (isDirectory || hasProtectedSegment(path)) return;
    const match = basename(path).match(/^(.+)\.before-[^/\\]+\.bak$/i);
    if (!match) return;
    const pathStat = await lstat(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || !await isInside(DATA_ROOT, path)) return;
    const key = `${dirname(path).toLowerCase()}\\${match[1].toLowerCase()}`;
    const files = groups.get(key) || [];
    files.push({ path, bytes: pathStat.size, modifiedAt: pathStat.mtimeMs });
    groups.set(key, files);
  });
  for (const files of groups.values()) {
    files.sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const file of files.slice(3)) {
      if (NOW - file.modifiedAt <= maxAgeDays * DAY_MS) continue;
      actions.push({
        type: 'file', path: file.path, bytes: file.bytes,
        reason: `superseded managed backup older than ${maxAgeDays} days; newest three retained`,
      });
    }
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function addExactArchiveDuplicateMatches(actions, papersRoot) {
  const groups = new Map();
  await walk(papersRoot, async (path, _entry, isDirectory) => {
    if (isDirectory) return;
    const relativePath = relative(DATA_ROOT, path).split(sep);
    const archiveIndex = relativePath.findIndex((part) => part.toLowerCase() === 'archive_work_files');
    if (archiveIndex < 0) return;
    const archiveRelative = relativePath.slice(archiveIndex + 1).join('/').toLowerCase();
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1024 * 1024 || !await isInside(DATA_ROOT, path)) return;
    const digest = await hashFile(path);
    const archiveRoot = relativePath.slice(0, archiveIndex + 1).join(sep).toLowerCase();
    const key = `${archiveRoot}|${basename(path).toLowerCase()}|${extname(path).toLowerCase()}|${info.size}|${digest}`;
    const group = groups.get(key) || [];
    group.push({ path, bytes: info.size, digest, archiveRelative });
    groups.set(key, group);
  });

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) => {
      const leftRank = left.archiveRelative.includes('/experiments/results/') || left.archiveRelative.startsWith('experiments/results/') ? 0 : 1;
      const rightRank = right.archiveRelative.includes('/experiments/results/') || right.archiveRelative.startsWith('experiments/results/') ? 0 : 1;
      return leftRank - rightRank || left.path.localeCompare(right.path);
    });
    const retained = group[0];
    for (const duplicate of group.slice(1)) actions.push({
      type: 'file', path: duplicate.path, bytes: duplicate.bytes,
      sha256: duplicate.digest, retainedPath: retained.path,
      reason: 'byte-identical archived artifact; canonical copy retained (requires --dedupe-exact --apply)',
    });
  }
}

async function buildPlan(options) {
  const actions = [];
  await addFileMatches(
    actions,
    STATE_ROOT,
    (path, pathStat) => /\.(log|tmp|temp)$/i.test(path) && olderThan(pathStat, options.logsDays),
    `state log/tmp older than ${options.logsDays} days`,
    new Set(['npm-cache', 'pip-cache', 'tmp', 'cleanup-reports']),
  );
  await addFileMatches(
    actions,
    join(STATE_ROOT, 'tmp'),
    (_path, pathStat) => olderThan(pathStat, options.tempDays),
    `state tmp older than ${options.tempDays} days`,
  );
  if (options.npmCacheDays !== null) {
    await addFileMatches(
      actions,
      join(STATE_ROOT, 'npm-cache'),
      (_path, pathStat) => olderThan(pathStat, options.npmCacheDays),
      `npm cache older than ${options.npmCacheDays} days`,
    );
  }
  const papersRoot = join(DATA_ROOT, 'output', 'papers');
  await addFileMatches(
    actions,
    papersRoot,
    (path, pathStat) => (/[\\/]\.dsh-state[\\/].+\.pipeline\.tmp$/i.test(path)
      || /[\\/]milestones[\\/]reproducibility[\\/]results[\\/].+\.pipeline\.tmp$/i.test(path))
      && olderThan(pathStat, options.tempDays),
    `pipeline staging file older than ${options.tempDays} days`,
  );
  await addExpiredBackupMatches(actions, papersRoot, options.backupDays);
  if (options.dedupeExact) await addExactArchiveDuplicateMatches(actions, papersRoot);

  const seen = new Set();
  const safeActions = [];
  for (const action of actions) {
    const key = `${action.type}:${action.path}`;
    if (seen.has(key) || !await isInside(DATA_ROOT, action.path)) continue;
    seen.add(key);
    safeActions.push(action);
  }
  return safeActions.sort((left, right) => right.path.length - left.path.length);
}

async function applyPlan(actions, dryRun) {
  let removedBytes = 0;
  let removedItems = 0;
  for (const action of actions) {
    if (dryRun) continue;
    const current = await lstat(action.path);
    if (!current.isFile() || current.isSymbolicLink() || !await isInside(DATA_ROOT, action.path)) continue;
    if (action.retainedPath && action.sha256) {
      const retained = await lstat(action.retainedPath).catch(() => undefined);
      if (!retained?.isFile() || retained.isSymbolicLink() || !await isInside(DATA_ROOT, action.retainedPath)) continue;
      if (await hashFile(action.path) !== action.sha256 || await hashFile(action.retainedPath) !== action.sha256) continue;
    }
    await rm(action.path, { recursive: action.type === 'directory', force: true });
    removedItems += 1;
    removedBytes += action.bytes;
  }
  return { removedItems, removedBytes };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function writeReport(options, actions, result) {
  await mkdir(REPORT_DIR, { recursive: true });
  if (!await isInside(DATA_ROOT, REPORT_DIR)) throw new Error('Cleanup report directory resolves outside the data root');
  const totalBytes = actions.reduce((sum, action) => sum + action.bytes, 0);
  const payload = {
    createdAt: new Date().toISOString(),
    mode: options.dryRun ? 'dry-run' : 'apply',
    dataRoot: DATA_ROOT,
    candidateItems: actions.length,
    candidateBytes: totalBytes,
    removedItems: result.removedItems,
    removedBytes: result.removedBytes,
    actions: actions.map((action) => ({
      ...action,
      path: relative(DATA_ROOT, action.path).split(sep).join('/'),
      ...(action.retainedPath ? { retainedPath: relative(DATA_ROOT, action.retainedPath).split(sep).join('/') } : {}),
    })),
  };
  const reportPath = join(REPORT_DIR, `cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { reportPath, totalBytes };
}

const options = parseArgs(process.argv.slice(2));
const plan = await buildPlan(options);
const result = await applyPlan(plan, options.dryRun);
const { reportPath, totalBytes } = await writeReport(options, plan, result);

console.log(`DSH cleanup mode: ${options.dryRun ? 'dry-run' : 'apply'}`);
console.log(`Candidates: ${plan.length}, reclaimable: ${formatBytes(totalBytes)}`);
console.log(`Removed: ${result.removedItems}, reclaimed: ${formatBytes(result.removedBytes)}`);
console.log(`Report: ${reportPath}`);
if (options.dryRun) console.log('Run npm run cleanup:apply to delete these low-risk files.');
if (options.dryRun && options.dedupeExact) console.log('Exact archive duplicates require: node scripts/cleanup-dsh-data.mjs --dedupe-exact --apply');
