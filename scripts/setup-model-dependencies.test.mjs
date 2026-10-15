import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureSetupModelDependencies, loadSetupPaths } from './setup-model-dependencies.mjs';
import { patchOpenAiProtocolAlias } from './patch-dsh-protocol-alias.mjs';

/** Simulate a first npm install without accessing the user's installation or network. */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-setup-model-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  const home = join(base, 'home');
  const seed = join(base, 'seed', 'adapter');
  mkdirSync(root);
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(seed, 'package.json'), '{"name":"adapter","version":"1.0.0"}');
  writeFileSync(join(seed, 'index.js'), 'export const value = 1;\n');
  const calls = [];
  const options = { projectRoot: root, dshHome: home, roots: ['adapter'], required: ['adapter'],
    verifySource: async () => {}, run: (_cwd, args) => {
      calls.push(args);
      cpSync(join(base, 'seed'), join(root, 'node_modules'), { recursive: true });
    } };
  return { root, home, calls, options };
}

test('fresh setup uses npm ci and creates a model baseline only after verification', async (t) => {
  const f = fixture(t);
  f.options.verifySource = async () => assert.equal(existsSync(join(f.home, 'model-dependencies.lock.json')), false);
  assert.deepEqual(await ensureSetupModelDependencies(f.options), { installed: true, baselineCreated: true });
  assert.deepEqual(f.calls, [['ci', '--legacy-peer-deps']]);
  const lock = JSON.parse(readFileSync(join(f.home, 'model-dependencies.lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/adapter'].version, '1.0.0');
});

test('repeated setup verifies and preserves the independent baseline without npm', async (t) => {
  const f = fixture(t);
  await ensureSetupModelDependencies(f.options);
  const before = readFileSync(join(f.home, 'model-dependencies.lock.json'));
  assert.deepEqual(await ensureSetupModelDependencies(f.options), { installed: false, baselineCreated: false });
  assert.equal(f.calls.length, 1);
  assert.ok(before.equals(readFileSync(join(f.home, 'model-dependencies.lock.json'))));
});

test('fresh baseline includes reviewed adapter patches and repeated setup never reapplies them', async (t) => {
  const f = fixture(t);
  let patched = 0;
  f.options.prepare = () => {
    patched++;
    writeFileSync(join(f.root, 'node_modules/adapter/index.js'), 'export const value = 2;\n');
  };
  await ensureSetupModelDependencies(f.options);
  await ensureSetupModelDependencies(f.options);
  assert.equal(patched, 1);
  assert.equal(f.calls.length, 1);
});

test('setup rejects changed or incomplete protected dependencies before npm', async (t) => {
  const f = fixture(t);
  await ensureSetupModelDependencies(f.options);
  writeFileSync(join(f.root, 'node_modules/adapter/index.js'), 'export const value = 2;\n');
  await assert.rejects(ensureSetupModelDependencies(f.options), /Protected model dependency changed/);
  rmSync(join(f.root, 'node_modules'), { recursive: true, force: true });
  await assert.rejects(ensureSetupModelDependencies(f.options), /Missing protected/);
  assert.equal(f.calls.length, 1);
});

test('setup does not silently approve existing unprotected installations', async (t) => {
  const f = fixture(t);
  f.options.run(f.root, []);
  f.calls.length = 0;
  await assert.rejects(ensureSetupModelDependencies(f.options), /no approved model baseline/);
  assert.equal(f.calls.length, 0);
});

test('failed npm or source verification never creates an approved baseline', async (t) => {
  const failed = fixture(t);
  failed.options.run = () => { throw new Error('fixture installation failed'); };
  await assert.rejects(ensureSetupModelDependencies(failed.options), /installation failed/);
  assert.equal(existsSync(join(failed.home, 'model-dependencies.lock.json')), false);
  const rejected = fixture(t);
  rejected.options.verifySource = async () => { throw new Error('source lock drift'); };
  await assert.rejects(ensureSetupModelDependencies(rejected.options), /source lock drift/);
  assert.equal(existsSync(join(rejected.home, 'model-dependencies.lock.json')), false);
});

test('missing lockfile and explicit skip never run an unpinned install', async (t) => {
  const f = fixture(t);
  await assert.rejects(ensureSetupModelDependencies({ ...f.options, skipInstall: true }), /explicitly skipped/);
  rmSync(join(f.root, 'package-lock.json'));
  await assert.rejects(ensureSetupModelDependencies(f.options), /Missing package-lock/);
  assert.equal(f.calls.length, 0);
});

test('built-in setup parser reads paths without inheriting keys or protocol settings', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.env'), 'PAPER_DATA_ROOT="C:/Data Space"\nDSH_HOME=C:/CustomHome\nOPENAI_API_KEY=fixture-secret\nOPENAI_BASE_URL=https://example.invalid\n');
  const env = { DSH_HOME: 'C:/ExistingHome' };
  loadSetupPaths(f.root, env);
  assert.deepEqual(env, { DSH_HOME: 'C:/ExistingHome', PAPER_DATA_ROOT: 'C:/Data Space' });
});

test('setup imports only built-in or dependency-free modules before installation', () => {
  const source = readFileSync(new URL('./setup-dsh.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes("import 'dotenv/config'"), false);
  assert.ok(source.includes('await ensureNodeDependencies()'));
  const legacy = readFileSync(new URL('./setup-dsh.ps1', import.meta.url), 'utf8');
  assert.equal(legacy.includes('npm install'), false);
  assert.ok(legacy.indexOf('setup-model-dependencies.mjs') < legacy.indexOf('node scripts/link-dsh-data-root.mjs'));
});

for (const eol of ['\n', '\r\n']) {
  for (const bom of ['', '\uFEFF']) {
    test(`protocol alias preparation preserves BOM=${Boolean(bom)} and EOL=${JSON.stringify(eol)}`, (t) => {
      const f = fixture(t);
      const target = join(f.root, 'adapter.js');
      const source = bom + ['const PROTOCOLS = {', '\t"anthropic-messages": anthropicMessagesApi', '};',
        'const profile = {', '\tapi: z.union(supportedProtocols()),', '};',
        'const LISTABLE_PROTOCOLS = new Set([', '\t"openai-responses"', ']);', ''].join(eol);
      writeFileSync(target, source);
      assert.equal(patchOpenAiProtocolAlias(target), true);
      const patched = readFileSync(target);
      assert.equal(patched.toString().startsWith('\uFEFF'), Boolean(bom));
      assert.equal(patched.includes(Buffer.from('\r\n')), eol === '\r\n');
      assert.equal(patchOpenAiProtocolAlias(target), false);
      assert.ok(patched.equals(readFileSync(target)));
    });
  }
}

test('unknown adapter layout refuses a partial protocol patch', (t) => {
  const f = fixture(t);
  const target = join(f.root, 'adapter.js');
  const source = '\t"anthropic-messages": anthropicMessagesApi\n// unsupported schema\n';
  writeFileSync(target, source);
  assert.throws(() => patchOpenAiProtocolAlias(target), /refusing partial patch/);
  assert.equal(readFileSync(target, 'utf8'), source);
});
