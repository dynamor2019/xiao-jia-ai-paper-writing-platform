import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { lockInstalledModelRouting, providerFingerprint, verifyModelRouting } from './verify-model-routing.mjs';
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
  await writeFile(sourcePath, profile());
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
  await writeFile(fixture.sourcePath, profile('claude-opus-5'));
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

test('repository upgrade keeps the independent installed provider baseline', async (t) => {
  const fixture = await createFixture(t);
  lockInstalledModelRouting(fixture.root, fixture.home);
  const installedFingerprint = providerFingerprint(fixture.runtimePath);
  await writeFile(fixture.sourcePath, profile('claude-next-release'));
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
