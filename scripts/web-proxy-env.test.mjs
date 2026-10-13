import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWebProxyEnv } from './web-proxy-env.mjs';

const current = 'http://127.0.0.1:7890';
const options = { platform: 'win32', supported: true, readProxy: () => current,
  probe: async (value) => value === current };

test('uses the existing listener instead of stale inherited VPN ports only in the child', async () => {
  const env = { HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897' };
  const original = { ...env };
  const result = await resolveWebProxyEnv(env, options);
  assert.equal(result.HTTP_PROXY, current);
  assert.equal(result.HTTPS_PROXY, current);
  assert.equal(result.NODE_USE_ENV_PROXY, '1');
  assert.equal(result.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.deepEqual(env, original);
});

test('keeps active explicit proxies and local bypass settings', async () => {
  const result = await resolveWebProxyEnv({ HTTPS_PROXY: current, NO_PROXY: 'localhost,custom.test' }, options);
  assert.deepEqual(result, { NODE_USE_ENV_PROXY: '1' });
});

test('does not replace remote explicit proxies', async () => {
  const result = await resolveWebProxyEnv({ HTTPS_PROXY: 'http://proxy.example:8080' }, options);
  assert.equal(result.HTTPS_PROXY, undefined);
});

test('does not invent an address when the Windows proxy is unavailable', async () => {
  assert.deepEqual(await resolveWebProxyEnv({}, { ...options, probe: async () => false }), {});
});

test('respects an explicit native-proxy opt-out and unsupported Node versions', async () => {
  assert.equal((await resolveWebProxyEnv({ HTTPS_PROXY: current, NODE_USE_ENV_PROXY: '0' }, options)).NODE_USE_ENV_PROXY, undefined);
  assert.equal((await resolveWebProxyEnv({ HTTPS_PROXY: current }, { ...options, supported: false })).NODE_USE_ENV_PROXY, undefined);
});
