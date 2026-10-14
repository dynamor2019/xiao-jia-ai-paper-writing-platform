import { lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

interface Artifact { path: string; bytes: number; modifiedAt: string; role: string; action: string }
const TEMP_PREFIX = '.dsh-state/runtime/tmp/';
const TEMP_AGE_MS = 24 * 60 * 60 * 1000;
const MANIFEST = '.dsh-state/pipeline-artifacts.json';
const PIPELINE_STATE_PREFIX = '.dsh-state/';
const RESULT_STAGING_PREFIX = 'milestones/reproducibility/results/';

/** Classify conservatively; unknown files and historical evidence are retained. */
function artifactRole(path: string): string {
  if (path.startsWith(TEMP_PREFIX) || isPipelineStagingFile(path)) return 'temporary';
  if (/archive|ARCHIVE/.test(path)) return 'archive';
  if (/^(experiments|raw|input|data|code)\//.test(path) || /analysis-plan|research-brief|experiment-plan/.test(path)) return 'evidence';
  if (/^(final|delivery|review-draft)\//.test(path)) return 'manuscript';
  if (/^(milestones|\.dsh-state)\//.test(path)) return 'audit';
  return 'unknown';
}

function isPipelineStagingFile(path: string): boolean {
  return path.endsWith('.pipeline.tmp')
    && (path.startsWith(PIPELINE_STATE_PREFIX) || path.startsWith(RESULT_STAGING_PREFIX));
}

/** Refuse links and paths outside the real project root before considering deletion. */
async function insideRoot(root: string, path: string): Promise<boolean> {
  const actual = await realpath(path);
  const rel = relative(root, actual);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Inventory files without following links or removing scientific evidence. */
async function inventory(root: string, directory = root, validated = false): Promise<Artifact[]> {
  const rows: Artifact[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!await insideRoot(root, path)) continue;
      rows.push(...await inventory(root, path, true));
    }
    else if (stat.isFile()) {
      if (!validated && !await insideRoot(root, path)) continue;
      const name = relative(root, path).split(sep).join('/');
      if (name === MANIFEST || name === `${MANIFEST}.tmp`) continue;
      rows.push({ path: name, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), role: artifactRole(name), action: 'retain' });
    }
  }
  return rows;
}

/** Prune only expired files created in dedicated pipeline staging locations. */
async function pruneTemps(root: string, rows: Artifact[]): Promise<string[]> {
  const removed: string[] = [];
  const candidates = rows.filter((row) => {
    const age = Date.now() - Date.parse(row.modifiedAt);
    const runtimeTemp = row.path.startsWith(TEMP_PREFIX) && row.path.endsWith('.tmp');
    const stagedWrite = isPipelineStagingFile(row.path);
    return (runtimeTemp || stagedWrite) && age > TEMP_AGE_MS;
  }).slice(0, 200);
  for (const row of candidates) {
    const path = resolve(root, row.path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !await insideRoot(root, path)) continue;
    if (Date.now() - stat.mtimeMs <= TEMP_AGE_MS) continue;
    await unlink(path);
    removed.push(row.path);
  }
  return removed;
}

/** Save retention decisions atomically; never clean the entire runtime or archives. */
export async function maintainPipelineArtifacts(projectDir: string): Promise<{ files: number; removed: string[]; warnings: string[] }> {
  const root = await realpath(projectDir);
  const stateDir = join(root, '.dsh-state');
  await mkdir(stateDir, { recursive: true });
  if (!await insideRoot(root, stateDir) || (await lstat(stateDir)).isSymbolicLink()) throw new Error('Artifact manifest directory is linked outside the project');
  const rows = await inventory(root);
  const removed = await pruneTemps(root, rows);
  const removedSet = new Set(removed);
  const retained = rows.filter((row) => !removedSet.has(row.path));
  const tempBytes = retained.filter((row) => row.role === 'temporary').reduce((sum, row) => sum + row.bytes, 0);
  const warnings = tempBytes > 64 * 1024 * 1024 ? ['Temporary storage exceeds 64 MiB; fresh or unclassified files were retained.'] : [];
  const path = join(root, MANIFEST);
  if ((await lstat(path).catch(() => undefined))?.isSymbolicLink()
    || (await lstat(`${path}.tmp`).catch(() => undefined))?.isSymbolicLink()) throw new Error('Artifact manifest cannot overwrite a link');
  await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), artifacts: retained, removed, warnings }, null, 2));
  await rename(`${path}.tmp`, path);
  return { files: retained.length, removed, warnings };
}
