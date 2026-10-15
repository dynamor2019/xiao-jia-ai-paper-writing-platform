import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODEL_ROOTS = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-llm-deepseek-api-key', '@deepseek-ai/dsh-llm-deepseek-account',
  '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-launch-environment'];

export const MODEL_CALLER_ROOTS = ['@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-session-title-llm', '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-web-search-deepseek'];

/** Index every installed copy, including packages nested under unrelated callers. */
function installedPackageCopies(projectRoot) {
  const copies = new Map();
  const visitPackage = (directory) => {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const paths = copies.get(manifest.name) || [];
      paths.push(directory);
      copies.set(manifest.name, paths);
    }
    visitModules(join(directory, 'node_modules'));
  };
  const visitModules = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw new Error(`Linked model installation is unsupported: ${directory}/${entry.name}`);
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(path, { withFileTypes: true })) {
          if (scoped.isSymbolicLink()) throw new Error(`Linked model installation is unsupported: ${path}/${scoped.name}`);
          if (scoped.isDirectory()) visitPackage(join(path, scoped.name));
        }
      } else visitPackage(path);
    }
  };
  visitModules(join(projectRoot, 'node_modules'));
  return copies;
}

/** Resolve installed dependencies using Node's ancestor node_modules lookup. */
export function packageDirectory(name, from, projectRoot, excluded) {
  let directory = resolve(from);
  const root = resolve(projectRoot);
  while (true) {
    const candidate = join(directory, 'node_modules', name);
    if (candidate !== excluded && existsSync(join(candidate, 'package.json'))) return candidate;
    if (directory === root) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Hash executable code, package metadata and binary runtime resources. */
export function packageFingerprint(directory) {
  const hash = createHash('sha256');
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:[cm]?js|json|wasm|node|pem)$/.test(entry.name)) {
        hash.update(relative(directory, path).replaceAll('\\', '/'));
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  visit(directory);
  return hash.digest('hex');
}

/** Capture actual installed adapters and their required dependency/peer closure. */
export function captureModelDependencies(projectRoot, roots = [...MODEL_ROOTS, ...MODEL_CALLER_ROOTS]) {
  const packages = {};
  const copies = installedPackageCopies(projectRoot);
  const pending = roots.map((name) => {
    const path = packageDirectory(name, projectRoot, projectRoot);
    if (!path) throw new Error(`Missing protected model dependency: ${name}`);
    return path;
  });
  while (pending.length) {
    const directory = pending.pop();
    const path = relative(projectRoot, directory).replaceAll('\\', '/');
    if (packages[path]) continue;
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    pending.push(...(copies.get(manifest.name) || []));
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    const edges = {};
    packages[path] = { name: manifest.name, version: manifest.version,
      sha256: packageFingerprint(directory), dependencies: edges };
    for (const name of Object.keys(dependencies).sort()) {
      const target = packageDirectory(name, directory, projectRoot);
      if (!target && (manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional)) continue;
      if (!target) throw new Error(`Missing dependency ${name} required by ${manifest.name}`);
      edges[name] = relative(projectRoot, target).replaceAll('\\', '/');
      pending.push(target);
    }
  }
  return { version: 1, roots: [...roots], packages: Object.fromEntries(Object.entries(packages).sort()) };
}

/** Refuse changed code, versions, resolution paths or dependency edges. */
export function assertModelDependencies(baseline, actual) {
  if (baseline.version !== 1) throw new Error('Unsupported model dependency lock version');
  if (JSON.stringify(baseline.roots) !== JSON.stringify(actual.roots)) {
    throw new Error('Protected model entry points changed; update refused');
  }
  for (const path of new Set([...Object.keys(baseline.packages), ...Object.keys(actual.packages)])) {
    if (JSON.stringify(baseline.packages[path]) !== JSON.stringify(actual.packages[path])) {
      throw new Error(`Protected model dependency changed: ${path}; update refused`);
    }
  }
}

/** Verify the installed dependency tree against the independent local baseline. */
export function verifyModelDependencies(projectRoot, lockPath) {
  const baseline = JSON.parse(readFileSync(lockPath, 'utf8'));
  assertModelDependencies(baseline, captureModelDependencies(projectRoot, baseline.roots));
  return baseline;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const path = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'model-dependencies.lock.json');
  if (process.argv.includes('--accept-current')) {
    const baseline = captureModelDependencies(root);
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Explicitly approved ${Object.keys(baseline.packages).length} installed model dependencies`);
  } else {
    verifyModelDependencies(root, path);
    console.log('Installed model dependency lock verified');
  }
}
