import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureModelDependencies } from './model-dependency-lock.mjs';
import { initializePackagedModelBaseline, packagedModelBaselinePath } from './packaged-model-baseline.mjs';
import { providerFingerprint, verifyModelRouting } from './verify-model-routing.mjs';

/** Build an isolated desktop tree without real credentials or user configuration. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const packageDir = join(root, 'node_modules', 'model-adapter');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), '{"name":"model-adapter","version":"1.0.0"}');
  const code = join(packageDir, 'index.js');
  writeFileSync(code, 'export const approved = true;\n');
  const baseline = captureModelDependencies(root, ['model-adapter']);
  const packaged = packagedModelBaselinePath(root);
  mkdirSync(join(root, 'config', 'dsh', 'web'), { recursive: true });
  writeFileSync(packaged, JSON.stringify(baseline));
  return { root, home, code, packaged, local: join(home, 'model-dependencies.lock.json') };
}

test('fresh desktop adopts the verified packaged bytes once without secrets', (t) => {
  const f = fixture(t);
  assert.equal(initializePackagedModelBaseline(f.root, f.home), true);
  assert.deepEqual(readFileSync(f.local), readFileSync(f.packaged));
  assert.equal(initializePackagedModelBaseline(f.root, f.home), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.local))), ['version', 'roots', 'packages']);
});

test('changed desktop adapter fails before creating a local baseline', (t) => {
  const f = fixture(t);
  writeFileSync(f.code, 'export const approved = false;\n');
  assert.throws(() => initializePackagedModelBaseline(f.root, f.home), /Protected model dependency changed/);
  assert.equal(existsSync(f.home), false);
});

test('a newer package cannot replace or invalidate a working local baseline', (t) => {
  const f = fixture(t);
  initializePackagedModelBaseline(f.root, f.home);
  const before = readFileSync(f.local);
  writeFileSync(f.packaged, 'invalid newer package');
  assert.equal(initializePackagedModelBaseline(f.root, f.home), false);
  assert.deepEqual(readFileSync(f.local), before);
  writeFileSync(f.code, 'export const upgraded = true;\n');
  assert.throws(() => initializePackagedModelBaseline(f.root, f.home), /Protected model dependency changed/);
  assert.deepEqual(readFileSync(f.local), before);
});

test('source clones without a packaged asset are left for normal setup', (t) => {
  const f = fixture(t);
  rmSync(f.packaged);
  assert.equal(initializePackagedModelBaseline(f.root, f.home), false);
  assert.equal(existsSync(f.home), false);
});

test('first-run verification audits the packaged tree before synchronization', (t) => {
  const f = fixture(t);
  const profile = join(f.root, 'config', 'dsh', 'web', 'cordis.patch.yml');
  writeFileSync(profile, '- id: version-update\n  disabled: true\n- id: llm-pi-ai\n  config:\n    providers:\n      fixture:\n        api: openai-responses\n');
  writeFileSync(join(f.root, 'config', 'dsh', 'web', 'model-routing.lock.json'),
    JSON.stringify({ providersSha256: providerFingerprint(profile), protectedFiles: {} }));
  verifyModelRouting({ projectRoot: f.root, dshHome: f.home });
  writeFileSync(f.code, 'changed();\n');
  assert.throws(() => verifyModelRouting({ projectRoot: f.root, dshHome: f.home }), /Protected model dependency changed/);
  assert.equal(existsSync(f.home), false);
});

test('all supported desktop npm packaging entries prepare a shipped baseline', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  for (const entry of ['desktop:pack', 'desktop:pack:local', 'desktop:pack:github', 'desktop:dir']) {
    assert.equal(scripts[`pre${entry}`], 'node scripts/packaged-model-baseline.mjs');
  }
});
