import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Resolve a bound evidence artifact without admitting external or symlink paths. */
function boundFile(root: string, path: string, sha256: string): Buffer {
  const absolute = realpathSync(resolve(root, path));
  const local = relative(realpathSync(root), absolute);
  if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) {
    throw new Error('Delivery review evidence escapes the project');
  }
  const bytes = readFileSync(absolute);
  if (!/^[0-9a-f]{64}$/.test(sha256) || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('Delivery review evidence hash changed');
  }
  return bytes;
}

/** Supply existing hash-bound test and archive evidence, not invented approvals. */
export function deliveryReviewEvidence(outputDir: string): string {
  const path = join(outputDir, 'delivery', 'review-evidence-binding.json');
  if (!existsSync(path)) return '';
  const binding = JSON.parse(readFileSync(path, 'utf8')) as {
    archive: { path: string; sha256: string };
    manifest: { path: string; sha256: string };
    tests: { path: string; sha256: string };
    verifiedArchiveFiles: number;
  };
  boundFile(outputDir, binding.archive.path, binding.archive.sha256);
  const manifest = JSON.parse(boundFile(outputDir, binding.manifest.path, binding.manifest.sha256).toString('utf8'));
  const tests = boundFile(outputDir, binding.tests.path, binding.tests.sha256).toString('utf8');
  if (manifest.files.length !== binding.verifiedArchiveFiles) throw new Error('Delivery manifest count changed');
  return `Current hash-bound delivery evidence (local archive, not public deposition or scientific certification):\n`
    + `Archive: ${binding.archive.path}\nArchive SHA256: ${binding.archive.sha256}\n`
    + `Manifest SHA256: ${binding.manifest.sha256}\nArchive entries verified against manifest: ${binding.verifiedArchiveFiles}\n`
    + `Original result SHA256: ${manifest.result_sha256}\nReplay result SHA256: ${manifest.replay_result_sha256}\n`
    + `Historical software-test log (${binding.tests.path}; SHA256 ${binding.tests.sha256}):\n${tests}\n`
    + 'Only numerical/software checks are established. Author permission, field validation and submission approval remain unresolved.';
}
