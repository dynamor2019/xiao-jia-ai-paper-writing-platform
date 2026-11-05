import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { acceptInstalledModelCode, lockInstalledModelRouting, providerFingerprint, verifyModelRouting } from './verify-model-routing.mjs';
import { captureModelDependencies } from './model-dependency-lock.mjs';

const profile = (model = 'claude-opus-5-5') => `- id: llm-pi-ai\n  config:\n    providers:\n      rayinai-claude:\n        apiKeyEnv: ANTHROPIC_API_KEY\n        api: openai-completions\n        baseURL: https://api-slb.rayinai.com/v1\n        models:\n          - id: ${model}\n`;

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-lock-'));
  const sourceDir = join(root, 'config', 'dsh', 'web');
  const runtimeDir = join(root, 'home', 'profiles', 'web');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  const sourcePath = join(sourceDir, 'cordis.patch.yml');
  const runtimePath = join(runtimeDir, 'cordis.patch.yml');
  const lockPath = join(sourceDir, 'model-routing.lock.json');
  await writeFile(sourcePath, profile() + '- id: version-update\n  disabled: true\n');
  await writeFile(runtimePath, profile());
  const providersSha256 = providerFingerprint(sourcePath);
  await writeFile(lockPath, JSON.stringify({ version: 2, providersSha256, protectedFiles: {} }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home: join(root, 'home'), sourcePath, runtimePath, lockPath };
}

test('allows routine sync when source and installed model routes match the lock', async (t) => {
  const fixture = await createFixture(t);
  const result = verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home });
  assert.equal(result.sourceFingerprint, result.runtimeFingerprint);
});

test('blocks accidental source model changes before sync', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.sourcePath, profile('claude-opus-5') + '- id: version-update\n  disabled: true\n');
  assert.throws(
    () => verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home }),
    /与锁定基线不符/u,
  );
});

test('preserves local model changes instead of silently overwriting them', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.runtimePath, profile('claude-opus-5'));
  assert.throws(
    () => verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home }),
    /拒绝用项目同步覆盖/u,
  );
  const result = verifyModelRouting({
    projectRoot: fixture.root,
    dshHome: fixture.home,
    allowRuntimeDrift: true,
  });
  assert.notEqual(result.runtimeFingerprint, result.sourceFingerprint);
  assert.match(await readFile(fixture.runtimePath, 'utf8'), /claude-opus-5/u);
});

test('allows first-run sync when no local profile exists yet', async (t) => {
  const fixture = await createFixture(t);
  await rm(fixture.runtimePath);
  const result = verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home });
  assert.equal(result.runtimeFingerprint, null);
});

test('removing or enabling the unprotected GUI updater fails before runtime synchronization', async (t) => {
  const fixture = await createFixture(t);
  for (const suffix of ['', '- id: version-update\n  disabled: false\n']) {
    await writeFile(fixture.sourcePath, profile() + suffix);
    assert.throws(() => verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home }),
      /Unprotected version updater must remain disabled/);
  }
  assert.equal(await readFile(fixture.runtimePath, 'utf8'), profile());
});

test('repository upgrade keeps the independent installed provider baseline', async (t) => {
  const fixture = await createFixture(t);
  lockInstalledModelRouting(fixture.root, fixture.home);
  const installedFingerprint = providerFingerprint(fixture.runtimePath);
  await writeFile(fixture.sourcePath, profile('claude-next-release') + '- id: version-update\n  disabled: true\n');
  const upgraded = providerFingerprint(fixture.sourcePath);
  await writeFile(fixture.lockPath, JSON.stringify({ providersSha256: upgraded, protectedFiles: {} }));
  const result = verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home });
  assert.equal(result.runtimeFingerprint, installedFingerprint);
  assert.notEqual(result.sourceFingerprint, installedFingerprint);
  await writeFile(fixture.runtimePath, profile('unapproved-model'));
  assert.throws(() => verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home }), /拒绝用项目同步覆盖/u);
});

test('blocks edits to protected model-call files before runtime sync', async (t) => {
  const fixture = await createFixture(t);
  const protectedPath = 'src/lib/model-client.ts';
  const absolutePath = join(fixture.root, protectedPath);
  await mkdir(join(fixture.root, 'src', 'lib'), { recursive: true });
  await writeFile(absolutePath, 'approved model call');
  const protectedSha256 = createHash('sha256').update('approved model call').digest('hex');
  const lock = JSON.parse(await readFile(fixture.lockPath, 'utf8'));
  lock.protectedFiles[protectedPath] = protectedSha256;
  await writeFile(fixture.lockPath, JSON.stringify(lock));
  await writeFile(absolutePath, 'changed model call');
  assert.throws(
    () => verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home }),
    /src\/lib\/model-client\.ts/u,
  );
});

test('startup sync refuses changed installed adapter code without accepting a new baseline', async (t) => {
  const fixture = await createFixture(t);
  const directory = join(fixture.root, 'node_modules', 'adapter');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"name":"adapter","version":"1.0.0"}');
  await writeFile(join(directory, 'index.js'), 'export const value = 1;');
  const baseline = captureModelDependencies(fixture.root, ['adapter']);
  await writeFile(join(fixture.home, 'model-dependencies.lock.json'), JSON.stringify(baseline));
  verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home });
  await writeFile(join(directory, 'index.js'), 'export const value = 2;');
  assert.throws(() => verifyModelRouting({ projectRoot: fixture.root, dshHome: fixture.home,
    allowRuntimeDrift: true }), /Protected model dependency changed/);
});

/** Simulate a release changing a caller and shipping an updated repository lock. */
async function approveRepositoryCaller(fixture, content) {
  const path = 'src/lib/model-client.ts';
  await mkdir(join(fixture.root, 'src', 'lib'), { recursive: true });
  await writeFile(join(fixture.root, path), content);
  const lock = JSON.parse(await readFile(fixture.lockPath, 'utf8'));
  lock.protectedFiles[path] = createHash('sha256').update(content).digest('hex');
  await writeFile(fixture.lockPath, JSON.stringify(lock));
}

test('a self-approved repository update cannot replace installed model call code', async (t) => {
  const f = await createFixture(t);
  await approveRepositoryCaller(f, 'approved client');
  lockInstalledModelRouting(f.root, f.home);
  const local = join(f.home, 'model-routing.lock.json');
  const before = await readFile(local);
  await approveRepositoryCaller(f, 'new release client');
  lockInstalledModelRouting(f.root, f.home);
  assert.deepEqual(await readFile(local), before);
  for (const allowRuntimeDrift of [false, true]) {
    assert.throws(() => verifyModelRouting({ projectRoot: f.root, dshHome: f.home, allowRuntimeDrift }),
      /Installed model call code changed: src\/lib\/model-client.ts/);
  }
  await rm(f.runtimePath);
  assert.throws(() => verifyModelRouting({ projectRoot: f.root, dshHome: f.home }), /Installed model call code changed/);
});

test('explicit code approval preserves provider, router, settings and credential baselines', async (t) => {
  const f = await createFixture(t);
  await approveRepositoryCaller(f, 'approved client');
  lockInstalledModelRouting(f.root, f.home);
  const local = join(f.home, 'model-routing.lock.json');
  const before = JSON.parse(await readFile(local, 'utf8'));
  const files = [f.runtimePath, join(f.home, 'settings.yaml'), join(f.home, '.credentials.yaml')];
  await writeFile(files[1], '# user settings\n');
  await writeFile(files[2], '# fixture credential store\n');
  const original = await Promise.all(files.map((path) => readFile(path)));
  await approveRepositoryCaller(f, 'reviewed new client');
  acceptInstalledModelCode(f.root, f.home);
  const after = JSON.parse(await readFile(local, 'utf8'));
  assert.equal(after.providersSha256, before.providersSha256);
  assert.equal(after.modelRouterSha256, before.modelRouterSha256);
  assert.notDeepEqual(after.protectedFiles, before.protectedFiles);
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path))), original);
  verifyModelRouting({ projectRoot: f.root, dshHome: f.home });
});

test('legacy local baselines require explicit code review rather than automatic adoption', async (t) => {
  const f = await createFixture(t);
  await approveRepositoryCaller(f, 'reviewed migration');
  const path = join(f.home, 'model-routing.lock.json');
  const legacy = { version: 1, providersSha256: providerFingerprint(f.runtimePath) };
  await writeFile(path, JSON.stringify(legacy, null, 2).replaceAll('\n', '\r\n'));
  assert.throws(() => verifyModelRouting({ projectRoot: f.root, dshHome: f.home }), /Installed model code baseline is missing/);
  acceptInstalledModelCode(f.root, f.home);
  const text = await readFile(path, 'utf8');
  assert.doesNotMatch(text, /(?<!\r)\n/);
  assert.equal(JSON.parse(text).providersSha256, legacy.providersSha256);
  verifyModelRouting({ projectRoot: f.root, dshHome: f.home });
});

test('compiled model caller replacements are refused even when source is unchanged', async (t) => {
  const f = await createFixture(t);
  await approveRepositoryCaller(f, 'approved client source');
  await mkdir(join(f.root, 'dist', 'lib'), { recursive: true });
  const compiled = join(f.root, 'dist', 'lib', 'model-client.js');
  await writeFile(compiled, 'approved compiled client');
  lockInstalledModelRouting(f.root, f.home);
  verifyModelRouting({ projectRoot: f.root, dshHome: f.home });
  await writeFile(compiled, 'unapproved compiled client');
  assert.throws(() => verifyModelRouting({ projectRoot: f.root, dshHome: f.home }),
    /Installed model call code changed: dist\/lib\/model-client.js/);
  acceptInstalledModelCode(f.root, f.home);
  verifyModelRouting({ projectRoot: f.root, dshHome: f.home });
});
