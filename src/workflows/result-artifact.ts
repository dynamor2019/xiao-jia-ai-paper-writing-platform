import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MANAGED_BY = 'dsh-paper-pipeline';
interface SharedResultLocation { sharedDataRoot: string; sharedDataScope: string }

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Replace a redundant generated result copy with a small hash-bound source manifest. */
export async function reconcileReproducibilityResult(
  projectDir: string,
  resultFile: string,
  shared?: SharedResultLocation,
): Promise<'duplicate-removed' | 'different-copy-archived' | 'different-copy-retained' | 'no-copy'> {
  const root = await realpath(projectDir);
  const sourcePath = resolve(root, resultFile);
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('Experiment result must be a regular project file');
  const sourceRealPath = await realpath(sourcePath);
  const localSource = isWithin(root, sourceRealPath);
  let manifestSourcePath = relative(root, sourceRealPath).split(sep).join('/');
  if (!localSource) {
    if (!shared) throw new Error('Experiment result resolves outside the paper project');
    const sharedRoot = await realpath(resolve(shared.sharedDataRoot));
    const relativeSource = relative(sharedRoot, sourceRealPath);
    const sharedParts = relativeSource.split(sep);
    if (!isWithin(sharedRoot, sourceRealPath) || sharedParts[0] !== 'processed'
      || sharedParts[1] !== shared.sharedDataScope || sharedParts.length < 4) {
      throw new Error('Shared experiment result is outside the paper-scoped processed-data directory');
    }
    manifestSourcePath = `@shared/${sharedParts.join('/')}`;
  }

  const resultsDir = join(root, 'milestones', 'reproducibility', 'results');
  await mkdir(resultsDir, { recursive: true });
  const resultsRealPath = await realpath(resultsDir);
  if (!isWithin(root, resultsRealPath) || (await lstat(resultsDir)).isSymbolicLink()) {
    throw new Error('Reproducibility results directory resolves outside the paper project');
  }
  const sourceHash = await sha256(sourceRealPath);
  const sourceAfterHash = await lstat(sourceRealPath);
  if (sourceAfterHash.size !== sourceStat.size || sourceAfterHash.mtimeMs !== sourceStat.mtimeMs) {
    throw new Error('Experiment result changed while its reproducibility hash was computed');
  }
  const fileName = basename(sourcePath).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 120).replace(/[. ]+$/, '') || 'paper';
  const duplicatePath = join(resultsDir, fileName);
  let duplicateToRemove: string | undefined;
  let differentCopy: { path: string; sha256: string; bytes: number } | undefined;
  let outcome: 'duplicate-removed' | 'different-copy-archived' | 'different-copy-retained' | 'no-copy' = 'no-copy';
  const manifestPath = join(resultsDir, 'source-manifest.json');
  if (resolve(duplicatePath) !== resolve(sourcePath) && resolve(duplicatePath) !== resolve(manifestPath)) {
    const duplicateStat = await lstat(duplicatePath).catch(() => undefined);
    if (duplicateStat?.isSymbolicLink()) throw new Error('Refusing to inspect a linked reproducibility result copy');
    if (duplicateStat?.isFile()) {
      if (await sha256(duplicatePath) === sourceHash) {
        const duplicateAfterHash = await lstat(duplicatePath);
        if (duplicateAfterHash.size !== duplicateStat.size || duplicateAfterHash.mtimeMs !== duplicateStat.mtimeMs) {
          throw new Error('Reproducibility result copy changed while its hash was computed');
        }
        duplicateToRemove = duplicatePath;
        outcome = 'duplicate-removed';
      } else {
        const afterHash = await lstat(duplicatePath);
        if (afterHash.size !== duplicateStat.size || afterHash.mtimeMs !== duplicateStat.mtimeMs) {
          throw new Error('Reproducibility result copy changed while its hash was computed');
        }
        differentCopy = { path: duplicatePath, sha256: await sha256(duplicatePath), bytes: afterHash.size };
        outcome = 'different-copy-retained';
      }
    }
  }

  const existing = await lstat(manifestPath).catch(() => undefined);
  if (existing?.isSymbolicLink() || existing && !existing.isFile()) throw new Error('Reproducibility result manifest path is not a regular file');
  if (existing?.isFile()) {
    const prior = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (prior.managedBy !== MANAGED_BY) throw new Error('Refusing to overwrite a non-pipeline reproducibility manifest');
  }
  let supersededCopies: Array<{ path: string; sha256: string; bytes: number }> = [];
  if (existing?.isFile()) {
    const prior = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (Array.isArray(prior.supersededCopies)) supersededCopies = prior.supersededCopies;
  }
  if (differentCopy) {
    try {
      const historyDir = join(resultsDir, 'superseded');
      await mkdir(historyDir, { recursive: true });
      if ((await lstat(historyDir)).isSymbolicLink() || !isWithin(root, await realpath(historyDir))) {
        throw new Error('Superseded result directory resolves outside the paper project');
      }
      const historyPath = join(historyDir, `${fileName}.${differentCopy.sha256}.superseded`);
      const priorHistory = await lstat(historyPath).catch(() => undefined);
      if (priorHistory?.isSymbolicLink()) throw new Error('Refusing to overwrite a linked superseded result');
      if (priorHistory?.isFile()) {
        if (await sha256(historyPath) !== differentCopy.sha256) throw new Error('Superseded result hash path contains different bytes');
        await unlink(differentCopy.path);
        outcome = 'duplicate-removed';
      } else {
        await rename(differentCopy.path, historyPath);
        supersededCopies.push({ ...differentCopy, path: relative(root, historyPath).split(sep).join('/') });
        outcome = 'different-copy-archived';
      }
    } catch {
      outcome = 'different-copy-retained';
    }
  }
  const manifest = {
    schemaVersion: 1,
    managedBy: MANAGED_BY,
    sourcePath: manifestSourcePath,
    sha256: sourceHash,
    bytes: sourceAfterHash.size,
    supersededCopies,
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${manifestPath}.${randomUUID()}.pipeline.tmp`;
  if ((await lstat(temporaryPath).catch(() => undefined))?.isSymbolicLink()) throw new Error('Refusing to overwrite a linked temporary manifest');
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, manifestPath);
  if (duplicateToRemove) await unlink(duplicateToRemove);
  return outcome;
}
