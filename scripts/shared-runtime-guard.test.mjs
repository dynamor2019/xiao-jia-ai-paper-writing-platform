import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { assertSharedRuntimeCompatible, olderCore } from './shared-runtime-guard.mjs';

test('older cores cannot overwrite a newer runtime; same-version clones and upgrades remain supported', () => {
  assert.equal(olderCore('0.1.2-rc.1', '0.1.7-rc.2'), true);
  assert.equal(olderCore('0.1.7-rc.2', '0.1.7-rc.2'), false);
  assert.equal(olderCore('0.1.8', '0.1.7-rc.2'), false);
  assert.equal(olderCore('0.2.0', '0.1.10'), false);
  assert.throws(() => olderCore('invalid', '0.1.7'), /Invalid DSH/);
});

/** Keep compatibility checks isolated from all actual runtime and credentials files. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-guard-'));
  mkdirSync(join(root, 'profiles', 'web'), { recursive: true });
  writeFileSync(join(root, 'profiles', 'web', 'package.json'), '{}');
  const cleanup = () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  };
  return { root, cleanup };
}

test('shared-profile conflict rejects sync before any runtime writes', () => {
  const { root, cleanup } = fixture();
  try {
    assert.throws(() => assertSharedRuntimeCompatible('old-project', root, (anchor) => ({
      version: anchor.includes('profiles') ? '0.1.7-rc.2' : '0.1.2-rc.1', path: anchor,
    })), /拒绝旧副本覆盖共享 DSH 配置/);
  } finally { cleanup(); }
});

test('fresh profiles and equal-version clones do not need migration', () => {
  const { root, cleanup } = fixture();
  try {
    assertSharedRuntimeCompatible('project', join(root, 'fresh'), () => { throw new Error('No lookup needed'); });
    assertSharedRuntimeCompatible('project', root, (path) => ({ version: '0.1.7-rc.2', path }));
  } finally { cleanup(); }
});

test('missing shared core allows initialization but unrelated resolution errors remain visible', () => {
  const { root, cleanup } = fixture();
  try {
    const resolver = (anchor) => {
      if (anchor.includes('profiles')) throw Object.assign(new Error('Not installed'), { code: 'MODULE_NOT_FOUND' });
      return { version: '0.1.7', path: anchor };
    };
    assertSharedRuntimeCompatible('project', root, resolver);
    assert.throws(() => assertSharedRuntimeCompatible('project', root, (anchor) => {
      if (anchor.includes('profiles')) throw new Error('Permission denied');
      return { version: '0.1.7', path: anchor };
    }), /Permission denied/);
  } finally { cleanup(); }
});
