import 'dotenv/config';

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const DATA_ROOT = resolve(process.env.PAPER_DATA_ROOT || 'F:\\DSH data');
const STATE_ROOT = resolve(DATA_ROOT, process.env.PAPER_STATE_DIR || '.dsh-state');
const REPORT_DIR = join(STATE_ROOT, 'cleanup-reports');
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  dryRun: true,
  logsDays: 14,
  tempDays: 3,
  figureScriptDays: 1,
  failedDays: 21,
  npmCacheDays: 30,
  emptyDirs: true,
};

const PROTECTED_SEGMENTS = new Set([
  'final',
  'milestones',
  'real_data',
  'raw',
  'input',
  'references',
  'protected-customizations',
]);

const FIGURE_VARIANT_RE = /^(?:_?fix\d*|fix_.+|batch_fix_.+|generate_all_fixed|generate_final_figures(?:_fixed)?|generate_top_tier_.+|generate_ultra_.+|adjust_commodity_.+|generate_(?:aic_)?figure\d+_.+|make_figures)\.py$/i;
const CANONICAL_VARIANT_RE = /(?:^|[_-])(?:new|fixed|fix|final|v\d+|revised|polished|clean|complete|latest|best)(?:[_-]|\.)/i;

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (const arg of argv) {
    if (arg === '--apply') options.dryRun = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-empty-dirs') options.emptyDirs = false;
    else if (arg.startsWith('--logs-days=')) options.logsDays = Number(arg.split('=')[1]);
    else if (arg.startsWith('--temp-days=')) options.tempDays = Number(arg.split('=')[1]);
    else if (arg.startsWith('--figure-script-days=')) options.figureScriptDays = Number(arg.split('=')[1]);
    else if (arg.startsWith('--failed-days=')) options.failedDays = Number(arg.split('=')[1]);
    else if (arg.startsWith('--npm-cache-days=')) options.npmCacheDays = Number(arg.split('=')[1]);
    else throw new Error(`Unknown cleanup option: ${arg}`);
  }
  return options;
}

function olderThan(pathStat, days) {
  return NOW - pathStat.mtimeMs > days * DAY_MS;
}

function hasProtectedSegment(path) {
  return path.split(/[\\/]+/).some((segment) => PROTECTED_SEGMENTS.has(segment));
}

async function walk(root, visitor) {
  if (!existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, visitor);
      await visitor(fullPath, entry, true);
    } else if (entry.isFile()) {
      await visitor(fullPath, entry, false);
    }
  }
}

async function addFileMatches(actions, root, predicate, reason) {
  await walk(root, async (path, _entry, isDirectory) => {
    if (isDirectory) return;
    const pathStat = await stat(path);
    if (!await predicate(path, pathStat)) return;
    actions.push({
      type: 'file',
      path,
      bytes: pathStat.size,
      reason,
    });
  });
}

async function addDirectoryMatches(actions, root, predicate, reason) {
  await walk(root, async (path, _entry, isDirectory) => {
    if (!isDirectory) return;
    const pathStat = await stat(path);
    if (!await predicate(path, pathStat)) return;
    actions.push({
      type: 'directory',
      path,
      bytes: 0,
      reason,
    });
  });
}

async function isEmptyDirectory(path) {
  try {
    const entries = await readdir(path);
    return entries.length === 0;
  } catch {
    return false;
  }
}

async function buildPlan(options) {
  const actions = [];
  await addFileMatches(
    actions,
    STATE_ROOT,
    (path, pathStat) => /\.(log|tmp|temp)$/i.test(path) && olderThan(pathStat, options.logsDays),
    `state log/tmp older than ${options.logsDays} days`,
  );
  await addFileMatches(
    actions,
    join(STATE_ROOT, 'tmp'),
    (_path, pathStat) => olderThan(pathStat, options.tempDays),
    `state tmp older than ${options.tempDays} days`,
  );
  await addFileMatches(
    actions,
    join(STATE_ROOT, 'npm-cache'),
    (_path, pathStat) => olderThan(pathStat, options.npmCacheDays),
    `npm cache older than ${options.npmCacheDays} days`,
  );
  await addDirectoryMatches(
    actions,
    join(DATA_ROOT, 'output', 'papers', '_failed-attempts'),
    (_path, pathStat) => olderThan(pathStat, options.failedDays),
    `failed attempts older than ${options.failedDays} days`,
  );

  const papersRoot = join(DATA_ROOT, 'output', 'papers');
  await addFileMatches(
    actions,
    papersRoot,
    (path, pathStat) => {
      if (hasProtectedSegment(path)) return false;
      if (!olderThan(pathStat, options.figureScriptDays)) return false;
      return /\.(tmp|temp|bak|old|part|crdownload|pyc)$/i.test(path)
        || /[\\/](_temp|tmp|temp|logs?)[\\/]/i.test(path)
        || /[\\.]dsh-state[\\/].+\.(log|tmp|temp)$/i.test(path);
    },
    `paper transient file older than ${options.tempDays} days`,
  );
  await addFileMatches(
    actions,
    join(DATA_ROOT, 'output'),
    (path, pathStat) => {
      if (!olderThan(pathStat, options.figureScriptDays)) return false;
      if (hasProtectedSegment(path)) return false;
      const relativePath = relative(join(DATA_ROOT, 'output'), path);
      const isRootPython = !relativePath.includes('\\') && !relativePath.includes('/') && path.toLowerCase().endsWith('.py');
      return isRootPython || FIGURE_VARIANT_RE.test(basename(path));
    },
    `non-canonical figure/root python script older than ${options.figureScriptDays} days`,
  );
  await addFileMatches(
    actions,
    papersRoot,
    (path, pathStat) => {
      if (!olderThan(pathStat, options.figureScriptDays)) return false;
      if (hasProtectedSegment(path)) return false;
      if (!CANONICAL_VARIANT_RE.test(basename(path))) return false;
      return /\.(md|docx|tex|bib|csv|tsv|json|py|png|pdf)$/i.test(path);
    },
    `non-canonical variant file older than ${options.figureScriptDays} days`,
  );
  await addDirectoryMatches(
    actions,
    papersRoot,
    (path, pathStat) => {
      if (hasProtectedSegment(path)) return false;
      if (!olderThan(pathStat, options.tempDays)) return false;
      return /[\\/](_temp|tmp|temp|logs?)[\\/]?$/i.test(path);
    },
    `paper transient directory older than ${options.tempDays} days`,
  );

  if (options.emptyDirs) {
    await addDirectoryMatches(
      actions,
      papersRoot,
      async (path) => !hasProtectedSegment(path) && await isEmptyDirectory(path),
      'empty paper directory',
    );
  }

  const seen = new Set();
  return actions
    .filter((action) => {
      const key = `${action.type}:${action.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return resolve(action.path).startsWith(DATA_ROOT);
    })
    .sort((left, right) => right.path.length - left.path.length);
}

async function applyPlan(actions, dryRun) {
  let removedBytes = 0;
  let removedItems = 0;
  for (const action of actions) {
    if (dryRun) continue;
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
      path: relative(DATA_ROOT, action.path),
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
