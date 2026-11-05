import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformUpdater } from './platform-updater.mjs';
import { compareVersions, productPath, validateUpdateManifest, PLATFORM_REPO,
  MANIFEST_ASSET, releaseAssetUrl } from './platform-update-files.mjs';
import { assertPlatformIdle, assertCompatibleDependencies, promotePlatformUpdate } from './install-platform-update.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xiaojia-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test', version: '0.1.8' }));
  return root;
}

function remote(bytes = Buffer.from('source-only zip')) {
  const tag = 'v0.1.9';
  const name = `XiaoJiaAI-Source-${tag}.zip`;
  const url = item => `https://github.com/${PLATFORM_REPO}/releases/download/${tag}/${item}`;
  const manifest = { format: 1, repository: PLATFORM_REPO, version: '0.1.9',
    files: { 'package.json': digest('package') }, asset: { name, sha256: digest(bytes) } };
  const release = { tag_name: tag, assets: [MANIFEST_ASSET, name].map(item => ({
    name: item, browser_download_url: url(item) })) };
  const calls = [];
  return { calls, manifest, fetchImpl: async request => {
    calls.push(request);
    return request.endsWith('/latest') ? Response.json(release)
      : request.endsWith('.json') ? Response.json(manifest) : new Response(bytes);
  } };
}

test('stable versions compare numerically and prereleases are rejected', () => {
  assert.equal(compareVersions('v0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.8', '0.1.8'), 0);
  assert.throws(() => compareVersions('0.2.0-alpha.1', '0.1.8'));
});

test('manifest rejects user data, dependencies and traversal', () => {
  for (const path of ['node_modules/a.js', '.env', 'output/paper.md', '../package.json',
    'scripts/../../.env', 'C:/a', 'scripts/a.bak', '.dsh/credentials.json']) {
    assert.equal(productPath(path), false, path);
    const manifest = remote().manifest;
    manifest.files[path] = digest('anything');
    assert.throws(() => validateUpdateManifest(manifest, 'v0.1.9'));
  }
  assert.equal(productPath('requirements.txt'), true);
  assert.throws(() => releaseAssetUrl('https://example.com/a.zip', 'v0.1.9', 'a.zip'));
});

test('automatic download is verified, cached and never changes running project', async t => {
  const root = fixture(t), server = remote();
  const updater = new PlatformUpdater({ projectRoot: root, stateRoot: join(root, 'state'),
    busy: () => true, fetchImpl: server.fetchImpl, env: {} });
  const original = readFileSync(join(root, 'package.json'));
  const [first, second] = await Promise.all([updater.check(), updater.check()]);
  assert.equal(first.status, 'ready');
  assert.equal(second.busy, true);
  assert.equal(server.calls.length, 3);
  await updater.check(true);
  assert.equal(server.calls.filter(url => url.endsWith('.zip')).length, 1);
  assert.deepEqual(readFileSync(join(root, 'package.json')), original);
  assert.ok(existsSync(updater.pendingPath));
});

test('automatic download can be disabled without disabling detection', async t => {
  const root = fixture(t), server = remote();
  const updater = new PlatformUpdater({ projectRoot: root, stateRoot: join(root, 'state'),
    fetchImpl: server.fetchImpl, env: { DSH_AUTO_UPDATE: 'false' } });
  assert.equal((await updater.check()).status, 'available');
  assert.equal(server.calls.length, 2);
  assert.equal(existsSync(updater.pendingPath), false);
  assert.equal((await updater.download()).status, 'ready');
});

test('checksum mismatch or offline error preserves current installation', async t => {
  const root = fixture(t), server = remote();
  server.manifest.asset.sha256 = digest('wrong');
  const updater = new PlatformUpdater({ projectRoot: root, stateRoot: join(root, 'state'),
    fetchImpl: server.fetchImpl, env: {} });
  assert.equal((await updater.check()).status, 'check-failed');
  assert.equal(existsSync(updater.pendingPath), false);
  updater.fetch = async () => { throw new Error('offline'); };
  assert.equal((await updater.check(true)).message, 'offline');
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '0.1.8');
});

test('host locks must positively establish absence before update', t => {
  const root = fixture(t);
  assertPlatformIdle(root);
  const lock = join(root, 'web-supervisor.lock.json');
  writeFileSync(lock, 'invalid json');
  assert.throws(() => assertPlatformIdle(root));
  writeFileSync(lock, JSON.stringify({ pid: 123 }));
  assert.throws(() => assertPlatformIdle(root, () => {}));
  assertPlatformIdle(root, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
  assert.throws(() => assertPlatformIdle(root, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }));
});

test('dependency changes require explicit setup rather than automatic package replacement', () => {
  const current = { name: 'test', dependencies: { model: '1' }, devDependencies: { electron: '1' } };
  assertCompatibleDependencies(current, { ...current, version: '0.1.9' });
  assert.throws(() => assertCompatibleDependencies(current, { ...current, dependencies: { model: '2' } }));
  assert.throws(() => assertCompatibleDependencies(current, { ...current, devDependencies: { electron: '2' } }));
});

for (const failure of ['write', 'approval', 'none']) {
  test(`file transaction ${failure} preserves secrets and rolls back failures`, t => {
    const root = fixture(t), staging = join(root, 'stage'), directory = join(root, 'state');
    mkdirSync(join(staging, 'scripts'), { recursive: true });
    writeFileSync(join(root, '.env'), 'private-key');
    const original = readFileSync(join(root, 'package.json'));
    const next = JSON.stringify({ name: 'test', version: '0.1.9' });
    writeFileSync(join(staging, 'package.json'), next);
    writeFileSync(join(staging, 'scripts/new.mjs'), 'export const value = 1;');
    const manifest = { version: '0.1.9', files: {
      'package.json': digest(next), 'scripts/new.mjs': digest('export const value = 1;') } };
    const run = () => promotePlatformUpdate({ projectRoot: root, staging, directory, manifest,
      dshHome: join(root, 'private'), beforeWrite: path => {
        if (failure === 'write' && path === 'package.json') throw new Error('disk failure');
      }, approve: () => { if (failure === 'approval') throw new Error('guard failure'); } });
    if (failure === 'none') {
      run();
      assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '0.1.9');
    } else {
      assert.throws(run);
      assert.deepEqual(readFileSync(join(root, 'package.json')), original);
      assert.equal(existsSync(join(root, 'scripts/new.mjs')), false);
    }
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'private-key');
    assert.equal(existsSync(join(directory, 'transaction.json')), false);
  });
}
