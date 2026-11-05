import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { assertModelDependencies, captureModelDependencies, MODEL_CALLER_ROOTS, MODEL_ROOTS } from './model-dependency-lock.mjs';
import { guardedModelUpdate, validateUpdateSpecs } from './guarded-model-update.mjs';
import { preserveModelUpdateAssets } from './model-update-assets.mjs';
import { preserveLockedModelLayer } from './preserve-model-layer.mjs';

/** Build a disposable model package with a transport SDK and peer dependency. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-model-guard-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  for (const name of ['adapter', 'sdk', 'peer']) {
    const path = join(root, 'node_modules', name);
    mkdirSync(path, { recursive: true });
    const dependencies = name === 'adapter' ? { dependencies: { sdk: '1.0.0' },
      peerDependencies: { peer: '1.0.0' }, optionalDependencies: { absent: '1.0.0' } } : {};
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...dependencies }));
    writeFileSync(join(path, 'index.js'), 'export const value = 1;\n');
  }
  const baseline = captureModelDependencies(root, ['adapter']);
  const lockPath = join(root, 'model.lock.json');
  writeFileSync(lockPath, JSON.stringify(baseline));
  return { root, baseline, lockPath };
}

test('a running host blocks installation before npm, while check-only can inspect safely', (t) => {
  const { root, lockPath } = fixture(t);
  mkdirSync(join(root, '.dsh-state'));
  writeFileSync(join(root, '.dsh-state/web-supervisor.lock.json'), JSON.stringify({ pid: process.pid }));
  let calls = 0;
  const options = { projectRoot: root, lockPath, specs: ['core@2.0.0'],
    prepare: () => {}, run: () => { calls++; } };
  assert.throws(() => guardedModelUpdate(options), /DSH is running/);
  assert.equal(calls, 0);
  assert.deepEqual(guardedModelUpdate({ ...options, checkOnly: true }), { checked: true, installed: false });
  assert.equal(calls, 1);
});

test('a host starting during staging prevents promotion and leaves live manifests intact', (t) => {
  const { root, lockPath } = fixture(t);
  const before = readFileSync(join(root, 'package.json'));
  assert.throws(() => guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'],
    prepare: () => {}, run: () => {
      mkdirSync(join(root, '.dsh-state'));
      writeFileSync(join(root, '.dsh-state/web-supervisor.lock.json'), JSON.stringify({ pid: process.pid }));
    } }), /DSH is running/);
  assert.ok(readFileSync(join(root, 'package.json')).equals(before));
  assert.equal(JSON.parse(readFileSync(join(root, 'node_modules/adapter/package.json'))).version, '1.0.0');
});

test('an unreadable supervisor record cannot silently authorize dependency replacement', (t) => {
  const { root, lockPath } = fixture(t);
  mkdirSync(join(root, '.dsh-state'));
  writeFileSync(join(root, '.dsh-state/web-supervisor.lock.json'), 'invalid-json');
  assert.throws(() => guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'],
    run: () => { throw new Error('npm must not run'); } }), /Cannot verify DSH supervisor state/);
});

test('captures transport SDK and required peers, tolerating missing optional packages', (t) => {
  const { baseline } = fixture(t);
  assert.deepEqual(Object.keys(baseline.packages), ['node_modules/adapter', 'node_modules/peer', 'node_modules/sdk']);
});

test('detects same-version executable changes', (t) => {
  const { root, baseline } = fixture(t);
  writeFileSync(join(root, 'node_modules/sdk/index.js'), 'export const value = 2;\n');
  assert.throws(() => assertModelDependencies(baseline, captureModelDependencies(root, ['adapter'])), /sdk/);
});

test('detects changed dependency resolution even with identical SDK code', (t) => {
  const { root, baseline } = fixture(t);
  cpSync(join(root, 'node_modules/sdk'), join(root, 'node_modules/adapter/node_modules/sdk'), { recursive: true });
  assert.throws(() => assertModelDependencies(baseline, captureModelDependencies(root, ['adapter'])), /changed/);
});

test('detects a new adapter copy nested under an unrelated package', (t) => {
  const { root, baseline } = fixture(t);
  const parent = join(root, 'node_modules/unrelated');
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(parent, 'package.json'), '{"name":"unrelated","version":"1.0.0"}');
  cpSync(join(root, 'node_modules/adapter'), join(parent, 'node_modules/adapter'), { recursive: true });
  assert.throws(() => assertModelDependencies(baseline, captureModelDependencies(root, ['adapter'])), /changed/);
});

test('fingerprints all existing nested SDK copies, not just adapter resolution', (t) => {
  const { root } = fixture(t);
  const parent = join(root, 'node_modules/unrelated');
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(parent, 'package.json'), '{"name":"unrelated","version":"1.0.0"}');
  const nested = join(parent, 'node_modules/sdk');
  cpSync(join(root, 'node_modules/sdk'), nested, { recursive: true });
  const before = captureModelDependencies(root, ['adapter']);
  assert.ok(before.packages['node_modules/unrelated/node_modules/sdk']);
  writeFileSync(join(nested, 'index.js'), 'export const value = 42;\n');
  assert.throws(() => assertModelDependencies(before, captureModelDependencies(root, ['adapter'])), /changed/);
});

test('nested protected copies remain visible even if their containing package has no manifest', (t) => {
  const { root } = fixture(t);
  const nested = join(root, 'node_modules/container/node_modules/sdk');
  cpSync(join(root, 'node_modules/sdk'), nested, { recursive: true });
  const baseline = captureModelDependencies(root, ['adapter']);
  assert.ok(baseline.packages['node_modules/container/node_modules/sdk']);
  writeFileSync(join(nested, 'index.js'), 'export const value = 2;\n');
  assert.throws(() => assertModelDependencies(baseline, captureModelDependencies(root, ['adapter'])), /changed/);
});

test('rejects removing an entry point even if the package closure is identical', (t) => {
  const { root } = fixture(t);
  const before = captureModelDependencies(root, ['adapter', 'sdk']);
  assert.throws(() => assertModelDependencies(before, captureModelDependencies(root, ['adapter'])), /entry points/);
});

test('protects native chat, compaction, title, review, search and subagent callers', () => {
  assert.deepEqual(MODEL_CALLER_ROOTS.map((name) => name.replace('@deepseek-ai/', '')), [
    'dsh-agent-loop', 'dsh-api-session-controller', 'dsh-compaction-basic',
    'dsh-session-title-llm', 'dsh-subagent', 'dsh-tool-subagent',
    'dsh-experimental-auto-review', 'dsh-web-search-deepseek',
  ]);
});

test('incompatible staged upgrade never calls npm on the live workspace', (t) => {
  const { root, lockPath } = fixture(t);
  const before = readFileSync(join(root, 'package.json'));
  let stage;
  const calls = [];
  assert.throws(() => guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'],
    run: (cwd) => {
      calls.push(cwd);
      stage = cwd;
      cpSync(join(root, 'node_modules'), join(cwd, 'node_modules'), { recursive: true });
      const parent = join(cwd, 'node_modules/core');
      mkdirSync(parent);
      writeFileSync(join(parent, 'package.json'), '{"name":"core","version":"2.0.0"}');
      cpSync(join(root, 'node_modules/sdk'), join(parent, 'node_modules/sdk'), { recursive: true });
      writeFileSync(join(parent, 'node_modules/sdk/package.json'), '{"name":"sdk","version":"2.0.0"}');
    } }), /Protected model dependency changed/);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0], root);
  assert.ok(before.equals(readFileSync(join(root, 'package.json'))));
  assert.equal(existsSync(stage), false);
});

test('compatible upgrade promotes the exact tested tree without a second npm install', (t) => {
  const { root, lockPath } = fixture(t);
  const calls = [];
  guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'], run: (cwd, args) => {
    calls.push(args);
    assert.notEqual(cwd, root);
    assert.equal(readFileSync(join(cwd, 'node_modules/sdk/index.js'), 'utf8'), 'export const value = 1;\n');
    writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"tested":true}\n');
    const core = join(cwd, 'node_modules/core');
    mkdirSync(core);
    writeFileSync(join(core, 'package.json'), '{"name":"core","version":"2.0.0"}');
  } });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'package-lock.json'))).tested, true);
  assert.equal(JSON.parse(readFileSync(join(root, 'node_modules/core/package.json'))).version, '2.0.0');
});

test('refuses shell injection, paths and install-redirection flags', () => {
  for (const spec of ['--prefix=F:/dsh', 'core & whoami', 'file:../elsewhere', 'https://example.com/p.tgz']) {
    assert.throws(() => validateUpdateSpecs([spec]), /registry package specs/);
  }
  assert.doesNotThrow(() => validateUpdateSpecs(['@deepseek-ai/dsh@0.2.0-rc.2']));
});

test('failed verified-tree promotion restores original modules and manifest bytes', (t) => {
  const { root, lockPath, baseline } = fixture(t);
  const original = readFileSync(join(root, 'package-lock.json'));
  assert.throws(() => guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'],
    run: (cwd) => {
      writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"tested":true}\n');
    }, move: (from, to) => {
      if (from.includes('.dsh-model-stage-')) throw new Error('fixture promotion failed');
      renameSync(from, to);
    } }), /fixture promotion failed/);
  assert.ok(original.equals(readFileSync(join(root, 'package-lock.json'))));
  assertModelDependencies(baseline, captureModelDependencies(root, ['adapter']));
  assert.equal(readdirSync(root).some((name) => name.startsWith('.dsh-model-backup-')), false);
});

test('reviewed preparation runs on the isolated tree, never twice on the live installation', (t) => {
  const { root, lockPath } = fixture(t);
  const prepared = [];
  guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'],
    prepare: (cwd) => {
      prepared.push(cwd);
      writeFileSync(join(cwd, 'node_modules/sdk/index.js'), 'export const value = 1;\n');
    }, run: (cwd) => {
      writeFileSync(join(cwd, 'node_modules/sdk/index.js'), 'export const value = 0;\n');
    } });
  assert.equal(prepared.length, 1);
  assert.notEqual(prepared[0], root);
});

test('failed staged preparation leaves the live installation and baseline unchanged', (t) => {
  const { root, lockPath } = fixture(t);
  const before = readFileSync(join(root, 'node_modules/sdk/index.js'));
  const lock = readFileSync(lockPath);
  let installs = 0;
  assert.throws(() => guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'],
    prepare: () => { throw new Error('fixture preparation failed'); }, run: (cwd) => {
      installs++;
      cpSync(join(root, 'node_modules'), join(cwd, 'node_modules'), { recursive: true });
    } }), /preparation failed/);
  assert.equal(installs, 1);
  assert.ok(before.equals(readFileSync(join(root, 'node_modules/sdk/index.js'))));
  assert.ok(lock.equals(readFileSync(lockPath)));
});

test('check-only verifies the actual staged tree but never promotes manifests or installs live', (t) => {
  const { root, lockPath } = fixture(t);
  const before = readFileSync(join(root, 'package-lock.json'));
  const calls = [];
  const result = guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'], checkOnly: true,
    run: (cwd) => {
      calls.push(cwd);
      cpSync(join(root, 'node_modules'), join(cwd, 'node_modules'), { recursive: true });
      writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"staged":true}\n');
    } });
  assert.deepEqual(result, { checked: true, installed: false });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0], root);
  assert.ok(before.equals(readFileSync(join(root, 'package-lock.json'))));
  assert.equal(existsSync(calls[0]), false);
});

test('stage audit can inspect mismatches before rejection and cleanup without accepting drift', (t) => {
  const { root, lockPath } = fixture(t);
  let audited = false;
  let stage;
  assert.throws(() => guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'], checkOnly: true,
    auditStage: ({ staging, baseline, actual }) => {
      audited = true;
      stage = staging;
      assert.equal(actual.packages['node_modules/core/node_modules/sdk'].version, '2.0.0');
      assert.equal(baseline.packages['node_modules/core/node_modules/sdk'], undefined);
    }, run: (cwd) => {
      cpSync(join(root, 'node_modules'), join(cwd, 'node_modules'), { recursive: true });
      const parent = join(cwd, 'node_modules/core');
      mkdirSync(parent);
      writeFileSync(join(parent, 'package.json'), '{"name":"core","version":"2.0.0"}');
      cpSync(join(root, 'node_modules/sdk'), join(parent, 'node_modules/sdk'), { recursive: true });
      writeFileSync(join(parent, 'node_modules/sdk/package.json'), '{"name":"sdk","version":"2.0.0"}');
    } }), /Protected model dependency changed/);
  assert.equal(audited, true);
  assert.equal(existsSync(stage), false);
  assert.equal(readFileSync(join(root, 'node_modules/sdk/index.js'), 'utf8'), 'export const value = 1;\n');
});

test('an isolated install cannot borrow missing dependencies from the live parent', (t) => {
  const { root } = fixture(t);
  const isolated = join(root, 'isolated');
  cpSync(join(root, 'node_modules/adapter'), join(isolated, 'node_modules/adapter'), { recursive: true });
  assert.throws(() => captureModelDependencies(isolated, ['adapter']), /Missing dependency/);
});

test('restores missing locked copies and original code without changing the source or baseline', (t) => {
  const { root, baseline, lockPath } = fixture(t);
  const isolated = join(root, 'isolated');
  cpSync(join(root, 'node_modules'), join(isolated, 'node_modules'), { recursive: true });
  rmSync(join(isolated, 'node_modules/peer'), { recursive: true, force: true });
  writeFileSync(join(isolated, 'node_modules/sdk/index.js'), 'export const value = 9;\n');
  const before = readFileSync(lockPath);
  preserveLockedModelLayer(root, isolated, baseline);
  assertModelDependencies(baseline, captureModelDependencies(isolated, ['adapter']));
  assert.equal(readFileSync(join(root, 'node_modules/sdk/index.js'), 'utf8'), 'export const value = 1;\n');
  assert.ok(before.equals(readFileSync(lockPath)));
});

test('removes only identical redundant copies whose fallback is the approved ancestor', (t) => {
  const { root, baseline } = fixture(t);
  const isolated = join(root, 'isolated');
  cpSync(join(root, 'node_modules'), join(isolated, 'node_modules'), { recursive: true });
  const parent = join(isolated, 'node_modules/core');
  mkdirSync(parent);
  writeFileSync(join(parent, 'package.json'), '{"name":"core","version":"2.0.0"}');
  cpSync(join(root, 'node_modules/sdk'), join(parent, 'node_modules/sdk'), { recursive: true });
  preserveLockedModelLayer(root, isolated, baseline);
  assert.equal(existsSync(join(parent, 'node_modules/sdk')), false);
  assertModelDependencies(baseline, captureModelDependencies(isolated, ['adapter']));
});

test('source drift is rejected before copying any model code', (t) => {
  const { root, baseline } = fixture(t);
  const isolated = join(root, 'isolated');
  writeFileSync(join(root, 'node_modules/sdk/index.js'), 'export const value = 9;\n');
  assert.throws(() => preserveLockedModelLayer(root, isolated, baseline), /Protected model dependency changed/);
  assert.equal(existsSync(isolated), false);
});

test('new version shadows in unchanged fully frozen containers restore the approved resolution', (t) => {
  const { root } = fixture(t);
  const owner = join(root, 'node_modules/owner');
  mkdirSync(owner);
  writeFileSync(join(owner, 'package.json'), '{"name":"owner","version":"1.0.0","dependencies":{"adapter":"1.0.0"}}');
  cpSync(join(root, 'node_modules/adapter'), join(owner, 'node_modules/adapter'), { recursive: true });
  const baseline = captureModelDependencies(root, ['adapter']);
  const isolated = join(root, 'isolated');
  cpSync(join(root, 'node_modules'), join(isolated, 'node_modules'), { recursive: true });
  const shadow = join(isolated, 'node_modules/owner/node_modules/sdk');
  cpSync(join(root, 'node_modules/sdk'), shadow, { recursive: true });
  writeFileSync(join(shadow, 'package.json'), '{"name":"sdk","version":"2.0.0"}');
  const actual = preserveLockedModelLayer(root, isolated, baseline);
  assert.equal(existsSync(shadow), false);
  assertModelDependencies(baseline, actual);
});

test('changed unprotected owners cannot have incompatible new dependencies removed', (t) => {
  const { root } = fixture(t);
  const owner = join(root, 'node_modules/owner');
  mkdirSync(owner);
  writeFileSync(join(owner, 'package.json'), '{"name":"owner","version":"1.0.0","dependencies":{"adapter":"1.0.0"}}');
  cpSync(join(root, 'node_modules/adapter'), join(owner, 'node_modules/adapter'), { recursive: true });
  const baseline = captureModelDependencies(root, ['adapter']);
  const isolated = join(root, 'isolated');
  cpSync(join(root, 'node_modules'), join(isolated, 'node_modules'), { recursive: true });
  writeFileSync(join(isolated, 'node_modules/owner/package.json'), '{"name":"owner","version":"2.0.0","dependencies":{"adapter":"1.0.0"}}');
  const shadow = join(isolated, 'node_modules/owner/node_modules/sdk');
  cpSync(join(root, 'node_modules/sdk'), shadow, { recursive: true });
  writeFileSync(join(shadow, 'package.json'), '{"name":"sdk","version":"2.0.0"}');
  const actual = preserveLockedModelLayer(root, isolated, baseline);
  assert.equal(existsSync(shadow), true);
  assert.throws(() => assertModelDependencies(baseline, actual), /changed/);
});

test('linked upgrade paths cannot overwrite files outside the isolated dependency tree', (t) => {
  const { root, baseline } = fixture(t);
  const isolated = join(root, 'isolated');
  const external = join(root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'index.js'), 'external sentinel');
  cpSync(join(root, 'node_modules'), join(isolated, 'node_modules'), { recursive: true });
  rmSync(join(isolated, 'node_modules/sdk'), { recursive: true, force: true });
  symlinkSync(external, join(isolated, 'node_modules/sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => preserveLockedModelLayer(root, isolated, baseline), /Linked protected package path/);
  assert.equal(readFileSync(join(external, 'index.js'), 'utf8'), 'external sentinel');
});

test('same-version Electron assets survive script-free staging and live installation', (t) => {
  const { root, lockPath } = fixture(t);
  const electron = join(root, 'node_modules/electron');
  mkdirSync(join(electron, 'dist'), { recursive: true });
  writeFileSync(join(electron, 'package.json'), '{"name":"electron","version":"1.0.0"}');
  writeFileSync(join(electron, 'dist/electron.exe'), 'fixture runtime bytes');
  writeFileSync(join(electron, 'path.txt'), 'electron.exe');
  guardedModelUpdate({ projectRoot: root, lockPath, specs: ['core@2.0.0'], run: (cwd) => {
    const source = cwd !== root ? join(root, 'node_modules')
      : join(root, readdirSync(root).find((name) => name.startsWith('.dsh-model-backup-')));
    cpSync(source, join(cwd, 'node_modules'), { recursive: true });
    rmSync(join(cwd, 'node_modules/electron/dist'), { recursive: true, force: true });
    rmSync(join(cwd, 'node_modules/electron/path.txt'));
  } });
  assert.equal(readFileSync(join(electron, 'dist/electron.exe'), 'utf8'), 'fixture runtime bytes');
  assert.equal(readFileSync(join(electron, 'path.txt'), 'utf8'), 'electron.exe');
});

test('different Electron versions cannot reuse old desktop runtime assets', (t) => {
  const { root } = fixture(t);
  const source = join(root, 'node_modules/electron');
  const target = join(root, 'target/electron');
  mkdirSync(join(source, 'dist'), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"name":"electron","version":"1.0.0"}');
  writeFileSync(join(source, 'path.txt'), 'electron.exe');
  writeFileSync(join(target, 'package.json'), '{"name":"electron","version":"2.0.0"}');
  assert.throws(() => preserveModelUpdateAssets(join(root, 'node_modules'), join(root, 'target')), /version changed/);
  assert.equal(existsSync(join(target, 'dist')), false);
});

test('repository declares exact protected adapter and SDK versions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of [...MODEL_ROOTS, ...MODEL_CALLER_ROOTS, '@earendil-works/pi-ai']) {
    assert.match(manifest.dependencies[name], /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  }
});

test('required DSH peer services are declared rather than relying on a dirty installation', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const baseline = captureModelDependencies(fileURLToPath(new URL('../', import.meta.url)));
  for (const path of Object.keys(baseline.packages)) {
    const installed = JSON.parse(readFileSync(new URL(`../${path}/package.json`, import.meta.url), 'utf8'));
    for (const name of Object.keys(installed.peerDependencies || {})) {
      if (!name.startsWith('@deepseek-ai/') || installed.peerDependenciesMeta?.[name]?.optional) continue;
      assert.ok(manifest.dependencies[name], `Required peer ${name} from ${installed.name} is undeclared`);
    }
  }
});

test('all current DSH plugins resolve compatible framework peers', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const bootRequire = createRequire(join(root, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'));
  const { satisfies } = bootRequire('semver');
  const version = JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai/dsh/package.json'))).version;
  for (const name of Object.keys(manifest.dependencies).filter(name => name.startsWith('@deepseek-ai/dsh'))) {
    const file = join(root, 'node_modules', name, 'package.json');
    const plugin = JSON.parse(readFileSync(file));
    if (plugin.version !== version) continue;
    const pluginRequire = createRequire(file);
    for (const [peer, range] of Object.entries(plugin.peerDependencies || {})) {
      if (!peer.startsWith('@deepseek-ai/cordis') || plugin.peerDependenciesMeta?.[peer]?.optional) continue;
      const resolved = pluginRequire(`${peer}/package.json`).version;
      assert.ok(satisfies(resolved, range), `${name} requires ${peer}@${range}, resolved ${resolved}`);
    }
  }
});
