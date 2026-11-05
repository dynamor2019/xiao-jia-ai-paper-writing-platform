import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveNpmCache } from './shared-npm-cache.mjs';

test('Windows projects share the standard npm user cache by default', () => {
  const env = { USERPROFILE: resolve('fixture-user'), LOCALAPPDATA: resolve('fixture-local') };
  assert.equal(resolveNpmCache(env, 'win32'), join(env.LOCALAPPDATA, 'npm-cache'));
  assert.equal(resolveNpmCache({ USERPROFILE: env.USERPROFILE }, 'win32'),
    join(env.USERPROFILE, 'AppData', 'Local', 'npm-cache'));
});

test('explicit existing cache settings retain their priority', () => {
  assert.equal(resolveNpmCache({ DSH_NPM_CACHE: 'custom', NPM_CONFIG_CACHE: 'existing' }), resolve('custom'));
  assert.equal(resolveNpmCache({ DSH_NPM_CACHE: '', NPM_CONFIG_CACHE: 'existing' }), resolve('existing'));
  assert.equal(resolveNpmCache({ npm_config_cache: 'lowercase' }), resolve('lowercase'));
});

test('Unix uses the shared user npm cache', () => {
  const home = resolve('fixture-home');
  assert.equal(resolveNpmCache({ HOME: home }, 'linux'), join(home, '.npm'));
  assert.throws(() => resolveNpmCache({ HOME: 'relative' }, 'linux'), /absolute/);
});

test('install and runtime entries all resolve the same cache', () => {
  for (const file of ['start-dsh-web.mjs', 'setup-dsh.mjs', 'setup-model-dependencies.mjs']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /resolveNpmCache\(/, file);
  }
  for (const file of ['setup-dsh.ps1', 'update-dsh-safe.ps1']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /shared-npm-cache\.mjs/, file);
  }
});
