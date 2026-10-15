import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { ensureModelCredentials, readModelProviders } from './model-credentials.mjs';
import { resolvePaperModelEnv } from './paper-model-env.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-model-credentials-'));
  const home = join(root, 'home');
  const profile = join(home, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      rayinai-claude:\n        api: openai-completions\n        apiKeyEnv: CLAUDE_GROUP_KEY\n        baseURL: https://claude.example/v1\n');
  writeFileSync(join(root, '.env'), 'CLAUDE_GROUP_KEY=test-claude-group\nSUB2API_API_KEY=test-grok-group\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home };
}

test('seeds the configured missing credential and never borrows another group key', async (t) => {
  const { root, home } = fixture(t);
  const values = new Map();
  const service = { resolve: async (ref) => values.has(ref) ? { value: values.get(ref) } : undefined,
    set: async (ref, value) => values.set(ref, value) };
  const providers = readModelProviders(home, root);
  assert.deepEqual(await ensureModelCredentials(service, providers, root), ['CLAUDE_GROUP_KEY']);
  assert.equal(values.get('CLAUDE_GROUP_KEY'), 'test-claude-group');
  values.set('CLAUDE_GROUP_KEY', 'user-updated-credential');
  assert.deepEqual(await ensureModelCredentials(service, providers, root), []);
  assert.equal(values.get('CLAUDE_GROUP_KEY'), 'user-updated-credential');
  assert.equal(values.has('SUB2API_API_KEY'), false);
});

test('pipeline reads active profile and stored credentials while ignoring imported stale settings', (t) => {
  const { root, home } = fixture(t);
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  CLAUDE_GROUP_KEY: stored-claude-group\n');
  writeFileSync(join(home, 'settings.yaml.imported'), 'llm-pi-ai:\n  providers:\n    rayinai-claude:\n      apiKeyEnv: SUB2API_API_KEY\n      baseURL: https://stale.example/v1\n');
  const env = resolvePaperModelEnv({}, home, root);
  assert.equal(env.ANTHROPIC_API_KEY, 'stored-claude-group');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://claude.example/v1');
  assert.equal(env.ANTHROPIC_API_MODE, 'openai-completions');
});

test('Web settings overrides and explicit environment remain supported', (t) => {
  const { root, home } = fixture(t);
  writeFileSync(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    rayinai-claude:\n      api: openai-responses\n');
  const env = resolvePaperModelEnv({ ANTHROPIC_API_KEY: 'explicit-run-key', ANTHROPIC_BASE_URL: 'https://explicit.example/v1' }, home, root);
  assert.equal(env.ANTHROPIC_API_KEY, 'explicit-run-key');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://explicit.example/v1');
  assert.equal(env.ANTHROPIC_API_MODE, 'openai-responses');
});

test('native credentials persist independently of the next invocation directory', async (t) => {
  const { root, home } = fixture(t);
  const service = new LocalCredentialProvider(new Context(), { dshHome: home, watch: false });
  await service.loadInitial();
  await ensureModelCredentials(service, readModelProviders(home, root), root);
  const reopened = new LocalCredentialProvider(new Context(), { dshHome: home, watch: false });
  await reopened.loadInitial();
  assert.equal((await reopened.resolve('CLAUDE_GROUP_KEY')).value, 'test-claude-group');
  assert.deepEqual(await ensureModelCredentials(reopened, readModelProviders(home, root), root), []);
});

test('Grok credentials are mapped independently and native DeepSeek credentials remain available', (t) => {
  const { root, home } = fixture(t);
  writeFileSync(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    sub2api-grok:\n      api: openai-responses\n      apiKeyEnv: GROK_GROUP_REF\n      baseURL: https://grok.example/v1\n      models:\n        - id: grok-4.7\n');
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  GROK_GROUP_REF: stored-grok-key\n  DEEPSEEK_API_KEY: stored-deepseek-key\n');
  const env = resolvePaperModelEnv({}, home, root);
  assert.equal(env.GROK_API_KEY, 'stored-grok-key');
  assert.equal(env.GROK_API_MODE, 'openai-responses');
  assert.equal(env.GROK_BASE_URL, 'https://grok.example/v1');
  assert.equal(env.GROK_MODEL, 'grok-4.7');
  assert.equal(env.DEEPSEEK_API_KEY, 'stored-deepseek-key');
});

test('native DeepSeek Web settings bind the same key, URL and Messages protocol in the pipeline', (t) => {
  const { root, home } = fixture(t);
  writeFileSync(join(home, 'settings.yaml'), 'llm-deepseek-api-key:\n  apiKeyEnv: NATIVE_DEEPSEEK_KEY\n  baseURL: https://native.example/anthropic\n');
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  NATIVE_DEEPSEEK_KEY: native-group-key\n');
  const env = resolvePaperModelEnv({}, home, root);
  assert.equal(env.DEEPSEEK_API_KEY, 'native-group-key');
  assert.equal(env.DEEPSEEK_BASE_URL, 'https://native.example/anthropic');
  assert.equal(env.DEEPSEEK_API_MODE, 'anthropic-messages');
});
