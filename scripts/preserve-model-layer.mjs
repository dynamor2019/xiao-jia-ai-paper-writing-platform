import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertModelDependencies, captureModelDependencies, packageDirectory, packageFingerprint } from './model-dependency-lock.mjs';

/** Validate every copy/delete target against the specified installation's dependency tree. */
function modelPackagePath(root, path) {
  const directory = resolve(root, path);
  const within = relative(resolve(root, 'node_modules'), directory);
  if (!path.startsWith('node_modules/') || !within || isAbsolute(within)
    || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Unsafe protected package path: ${path}`);
  }
  for (let current = directory; current !== resolve(root); current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Linked protected package path is unsupported: ${path}`);
    }
  }
  return directory;
}

/** Restore reviewed package payloads while leaving nested packages to their own lock entries. */
function restorePackage(source, target) {
  if (existsSync(target)) {
    for (const entry of readdirSync(target)) {
      if (entry !== 'node_modules') rmSync(join(target, entry), { recursive: true, force: true });
    }
  }
  cpSync(source, target, { recursive: true, verbatimSymlinks: true,
    filter: (path) => path === source || basename(path) !== 'node_modules' });
}

/** Remove only identical new copies that resolve to an approved, equivalent ancestor. */
function pruneEquivalentCopies(staging, baseline, actual) {
  const extras = Object.keys(actual.packages).filter((path) => !baseline.packages[path])
    .sort((a, b) => b.length - a.length);
  for (const path of extras) {
    const entry = actual.packages[path];
    const directory = modelPackagePath(staging, path);
    if (!existsSync(join(directory, 'package.json'))) continue;
    const fallback = packageDirectory(entry.name, directory, staging, directory);
    if (!fallback) continue;
    const key = relative(staging, fallback).replaceAll('\\', '/');
    const approved = baseline.packages[key];
    if (!approved || entry.name !== approved.name || entry.version !== approved.version
      || entry.sha256 !== approved.sha256
      || JSON.stringify(entry.dependencies) !== JSON.stringify(approved.dependencies)) continue;
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Authorize only unchanged containers whose dependency closure is already frozen. */
function frozenShadowOwner(projectRoot, staging, directory, baseline) {
  let modules = dirname(directory);
  while (basename(modules) !== 'node_modules' && dirname(modules) !== modules) modules = dirname(modules);
  const ownerPath = relative(staging, dirname(modules)).replaceAll('\\', '/');
  if (!ownerPath.startsWith('node_modules/')) return false;
  const source = modelPackagePath(projectRoot, ownerPath);
  const target = modelPackagePath(staging, ownerPath);
  if (!existsSync(join(source, 'package.json')) || !existsSync(join(target, 'package.json'))
    || packageFingerprint(source) !== packageFingerprint(target)) return false;
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  return Object.keys(dependencies).every((name) => {
    const resolved = packageDirectory(name, source, projectRoot);
    if (!resolved) return Boolean(manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional);
    return Boolean(baseline.packages[relative(projectRoot, resolved).replaceAll('\\', '/')]);
  });
}

/** Restore original resolution only when npm introduced a shadow into a frozen owner. */
function pruneResolutionShadows(projectRoot, staging, baseline) {
  for (const [path, entry] of Object.entries(baseline.packages)) {
    const consumer = modelPackagePath(staging, path);
    for (const [name, expectedPath] of Object.entries(entry.dependencies)) {
      const expected = modelPackagePath(staging, expectedPath);
      const actual = packageDirectory(name, consumer, staging);
      if (!actual || actual === expected) continue;
      const actualPath = relative(staging, actual).replaceAll('\\', '/');
      if (baseline.packages[actualPath] || existsSync(join(modelPackagePath(projectRoot, actualPath), 'package.json'))) continue;
      const candidate = modelPackagePath(staging, actualPath);
      if (packageDirectory(name, consumer, staging, candidate) !== expected
        || !frozenShadowOwner(projectRoot, staging, candidate, baseline)) continue;
      rmSync(candidate, { recursive: true, force: true });
    }
  }
}

/** Keep the verified model engine intact in an isolated upgrade, never reset its baseline. */
export function preserveLockedModelLayer(projectRoot, staging, baseline) {
  if (resolve(projectRoot) === resolve(staging)) throw new Error('Model preservation requires an isolated target');
  assertModelDependencies(baseline, captureModelDependencies(projectRoot, baseline.roots));
  for (const path of Object.keys(baseline.packages)) {
    restorePackage(modelPackagePath(projectRoot, path), modelPackagePath(staging, path));
  }
  pruneResolutionShadows(projectRoot, staging, baseline);
  const actual = captureModelDependencies(staging, baseline.roots);
  pruneEquivalentCopies(staging, baseline, actual);
  return captureModelDependencies(staging, baseline.roots);
}
