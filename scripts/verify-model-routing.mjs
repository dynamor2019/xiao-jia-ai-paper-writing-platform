import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { verifyModelDependencies } from './model-dependency-lock.mjs';

const PROTECTED_FILES = [
  'config/dsh/web/model-router.js',
  'src/config/model-routing.ts',
  'src/lib/model-client.ts',
  'src/lib/model-request-policy.ts',
  'src/lib/model-request-context.ts',
  'src/lib/responses-stream.ts',
  'scripts/paper-model-env.mjs',
  'scripts/paper-model-env.d.mts',
  'scripts/model-credentials.mjs',
  'scripts/model-failure-policy.mjs',
  'scripts/model-failure-policy.d.mts',
  'scripts/model-request-budget.mjs',
  'scripts/paper-context-memory.mjs',
  'scripts/project-env.mjs',
  'scripts/project-env.d.mts',
  'scripts/shared-npm-cache.mjs',
  'scripts/start-dsh-web.mjs',
  'scripts/paper-cli.mjs',
  'scripts/paper-background-runner.mjs',
  'scripts/model-health-check.mjs',
  'config/dsh/web/model-credentials.js',
  'scripts/sync-dsh-runtime.mjs',
  'scripts/verify-model-routing.mjs',
  'scripts/model-dependency-lock.mjs',
  'scripts/guarded-model-update.mjs',
  'scripts/model-update-idle.mjs',
  'scripts/packaged-model-baseline.mjs',
  'scripts/setup-model-dependencies.mjs',
  'scripts/setup-dsh.mjs',
  'scripts/setup-dsh.ps1',
  'scripts/prepare-model-installation.mjs',
  'scripts/model-update-assets.mjs',
  'scripts/preserve-model-layer.mjs',
  'scripts/patch-dsh-empty-tool-call.mjs',
  'scripts/patch-dsh-protocol-alias.mjs',
  'scripts/update-dsh-safe.ps1',
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function providerFingerprint(profilePath) {
  const profile = parse(readFileSync(profilePath, 'utf8'), { logLevel: 'silent' });
  const config = profile.find((entry) => entry.id === 'llm-pi-ai')?.config;
  if (!config?.providers || typeof config.providers !== 'object') {
    throw new Error(`模型 provider 配置缺失或格式无效: ${profilePath}`);
  }
  const canonical = JSON.stringify(stableValue(config.providers));
  return createHash('sha256').update(canonical).digest('hex');
}

function fileFingerprint(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runtimeRouterFingerprint(path, projectRoot) {
  const normalized = readFileSync(path, 'utf8')
    .replaceAll(projectRoot, '__DSH_PAPER_PROJECT_DIR__');
  return createHash('sha256').update(normalized).digest('hex');
}

function protectedFileFingerprints(projectRoot, files = PROTECTED_FILES) {
  return Object.fromEntries(files.map((relativePath) => [
    relativePath,
    fileFingerprint(join(projectRoot, relativePath)),
  ]));
}

/** Include the emitted JavaScript actually loaded by Web and desktop callers. */
function installedCodeFingerprints(projectRoot, sourceFiles) {
  const sources = Object.keys(sourceFiles);
  const emitted = sources.filter((path) => path.startsWith('src/') && path.endsWith('.ts'))
    .map((path) => `dist/${path.slice(4, -3)}.js`)
    .filter((path) => existsSync(join(projectRoot, path)));
  return protectedFileFingerprints(projectRoot, [...sources, ...emitted]);
}

/** A repository release cannot approve its own replacement of installed call code. */
function assertInstalledModelCode(projectRoot, installed, allowCodeDrift) {
  if (!installed || allowCodeDrift) return;
  if (!installed.protectedFiles || typeof installed.protectedFiles !== 'object'
    || Array.isArray(installed.protectedFiles)) {
    throw new Error('Installed model code baseline is missing; review and run --accept-installed-code explicitly');
  }
  for (const [path, expected] of Object.entries(installed.protectedFiles)) {
    if (fileFingerprint(join(projectRoot, path)) !== expected) {
      throw new Error(`Installed model call code changed: ${path}; repository approval cannot replace the local baseline`);
    }
  }
}

/** Refuse the third-party installer and its automatic rollback/scheduler bypass. */
function assertProtectedUpdateEntry(profilePath) {
  const profile = parse(readFileSync(profilePath, 'utf8'), { logLevel: 'silent' });
  const entries = profile.filter((entry) => entry.id === 'version-update');
  if (entries.length !== 1 || entries[0].disabled !== true) {
    throw new Error('Unprotected version updater must remain disabled; use scripts/update-dsh-safe.ps1');
  }
}

/** Fail before sync when the approved provider catalog has drifted. */
export function verifyModelRouting({ projectRoot, dshHome, allowRuntimeDrift = false, allowCodeDrift = false }) {
  const localDependencyLock = join(dshHome, 'model-dependencies.lock.json');
  const dependencyLock = existsSync(localDependencyLock) ? localDependencyLock
    : join(projectRoot, 'config', 'dsh', 'web', 'model-dependencies.lock.json');
  if (existsSync(dependencyLock)) verifyModelDependencies(projectRoot, dependencyLock);
  const sourcePath = join(projectRoot, 'config', 'dsh', 'web', 'cordis.patch.yml');
  assertProtectedUpdateEntry(sourcePath);
  const runtimePath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  const lockPath = join(projectRoot, 'config', 'dsh', 'web', 'model-routing.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const sourceFingerprint = providerFingerprint(sourcePath);
  if (sourceFingerprint !== lock.providersSha256) {
    throw new Error('模型 provider 配置与锁定基线不符；拒绝静默同步，请显式审核并更新模型路由锁。');
  }
  const protectedFiles = lock.protectedFiles || {};
  const actualFiles = protectedFileFingerprints(projectRoot, Object.keys(protectedFiles));
  for (const [relativePath, expected] of Object.entries(protectedFiles)) {
    if (actualFiles[relativePath] !== expected) {
      throw new Error(`模型调用链文件与锁定基线不符: ${relativePath}；拒绝静默同步。`);
    }
  }
  const localLockPath = join(dshHome, 'model-routing.lock.json');
  const installed = existsSync(localLockPath) ? JSON.parse(readFileSync(localLockPath, 'utf8')) : undefined;
  assertInstalledModelCode(projectRoot, installed, allowCodeDrift);
  if (!existsSync(runtimePath)) return { sourceFingerprint, runtimeFingerprint: null, protectedFiles: actualFiles };
  const runtimeFingerprint = providerFingerprint(runtimePath);
  const localLock = installed || lock;
  if (!allowRuntimeDrift && runtimeFingerprint !== localLock.providersSha256) {
    throw new Error('本机模型 provider 配置与锁定基线不符；拒绝用项目同步覆盖本机配置。');
  }
  const runtimeRouter = join(dshHome, 'profiles', 'web', 'model-router.js');
  const expectedRouter = localLock.modelRouterSha256 || lock.protectedFiles?.['config/dsh/web/model-router.js'];
  if (!allowRuntimeDrift && expectedRouter && existsSync(runtimeRouter)
    && runtimeRouterFingerprint(runtimeRouter, projectRoot) !== expectedRouter) {
    throw new Error('本机模型路由器与锁定基线不符；拒绝用项目同步覆盖本机配置。');
  }
  return { sourceFingerprint, runtimeFingerprint, protectedFiles: actualFiles };
}

/** Persist a non-secret local baseline that survives repository and core upgrades. */
export function lockInstalledModelRouting(projectRoot, dshHome, replace = false) {
  const lockPath = join(dshHome, 'model-routing.lock.json');
  if (existsSync(lockPath) && !replace) return;
  const profile = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  const router = join(dshHome, 'profiles', 'web', 'model-router.js');
  const sourceLock = JSON.parse(readFileSync(join(projectRoot, 'config', 'dsh', 'web', 'model-routing.lock.json'), 'utf8'));
  const baseline = { version: 2, providersSha256: providerFingerprint(profile),
    protectedFiles: installedCodeFingerprints(projectRoot, sourceLock.protectedFiles || {}) };
  if (existsSync(router)) baseline.modelRouterSha256 = runtimeRouterFingerprint(router, projectRoot);
  writeFileSync(lockPath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: replace ? 'w' : 'wx' });
}

/** Explicit code approval preserves installed providers, router and dependency locks. */
export function acceptInstalledModelCode(projectRoot, dshHome) {
  const { protectedFiles } = verifyModelRouting({ projectRoot, dshHome, allowCodeDrift: true });
  const path = join(dshHome, 'model-routing.lock.json');
  const bytes = readFileSync(path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const baseline = JSON.parse(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const next = { ...baseline, version: 2, protectedFiles: installedCodeFingerprints(projectRoot, protectedFiles) };
  writeFileSync(`${path}.before-code-approval-${Date.now()}.bak`, bytes, { flag: 'wx' });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`.replaceAll('\n', eol));
}

function acceptCurrentModelRouting(projectRoot) {
  const sourcePath = join(projectRoot, 'config', 'dsh', 'web', 'cordis.patch.yml');
  const lockPath = join(projectRoot, 'config', 'dsh', 'web', 'model-routing.lock.json');
  const providersSha256 = providerFingerprint(sourcePath);
  const protectedFiles = protectedFileFingerprints(projectRoot);
  writeFileSync(lockPath, `${JSON.stringify({ version: 2, providersSha256, protectedFiles }, null, 2)}\n`, 'utf8');
  console.log(`已显式接受模型路由基线 ${providersSha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--accept-current')) {
    acceptCurrentModelRouting(projectRoot);
  } else if (process.argv.includes('--accept-installed-code')) {
    const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
    acceptInstalledModelCode(projectRoot, dshHome);
    console.log('Explicitly approved installed model call code; provider and credential configuration unchanged');
  } else {
    const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
    const result = verifyModelRouting({ projectRoot, dshHome });
    console.log(`模型路由锁定校验通过: ${result.sourceFingerprint}`);
  }
}
