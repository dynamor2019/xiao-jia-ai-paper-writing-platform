import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { loadProjectEnv } from './project-env.mjs';
import { readModelCredentialRefs, readModelProviders, ensureModelCredentials } from './model-credentials.mjs';
import { resolvePaperModelEnv } from './paper-model-env.mjs';

/** Build an isolated project with a custom credential reference. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-env-'));
  const home = join(root, 'home');
  const profile = join(home, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      rayinai-claude:\n        api: openai-completions\n        apiKeyEnv: CUSTOM_CLAUDE_KEY\n        baseURL: https://profile.example/v1\n- id: research-search\n  config:\n    apiKeyEnv: SEARCH_GROUP_KEY\n');
  writeFileSync(join(root, '.env'), 'CUSTOM_CLAUDE_KEY=dotenv-key\nANTHROPIC_API_KEY=old-canonical-key\nSEARCH_GROUP_KEY=search-key\nDEEPSEEK_API_KEY=deepseek-key\nANTHROPIC_BASE_URL=https://old.example/v1\nPAPER_DATA_ROOT=fixture-data\nROUTE_WRITING_PROVIDER=claude\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home };
}

test('dotenv credentials remain fallbacks while application and routing options load', (t) => {
  const { root, home } = fixture(t);
  const env = loadProjectEnv({ DSH_HOME: home }, root);
  assert.equal(env.CUSTOM_CLAUDE_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.SEARCH_GROUP_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.PAPER_DATA_ROOT, 'fixture-data');
  assert.equal(env.ROUTE_WRITING_PROVIDER, 'claude');
});

test('pipeline uses a Web-stored key and current profile instead of an old dotenv key', (t) => {
  const { root, home } = fixture(t);
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  CUSTOM_CLAUDE_KEY: updated-from-models-page\n');
  const env = resolvePaperModelEnv(loadProjectEnv({ DSH_HOME: home }, root), home, root);
  assert.equal(env.ANTHROPIC_API_KEY, 'updated-from-models-page');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://profile.example/v1');
});

test('explicit custom-reference environment credentials take priority', (t) => {
  const { root, home } = fixture(t);
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  CUSTOM_CLAUDE_KEY: stored-key\n');
  const env = resolvePaperModelEnv(loadProjectEnv({ DSH_HOME: home, CUSTOM_CLAUDE_KEY: 'explicit-key' }, root), home, root);
  assert.equal(env.ANTHROPIC_API_KEY, 'explicit-key');
});

test('auxiliary search and native DeepSeek credentials initialize through the same service', async (t) => {
  const { root, home } = fixture(t);
  const service = new LocalCredentialProvider(new Context(), { dshHome: home, watch: false });
  await service.loadInitial();
  const refs = readModelCredentialRefs(home, root);
  await ensureModelCredentials(service, readModelProviders(home, root), root, refs);
  assert.equal((await service.resolve('SEARCH_GROUP_KEY')).value, 'search-key');
  assert.equal((await service.resolve('DEEPSEEK_API_KEY')).value, 'deepseek-key');
  await service.set('CUSTOM_CLAUDE_KEY', 'updated-key');
  assert.equal((await service.resolve('CUSTOM_CLAUDE_KEY')).value, 'updated-key');
});

test('malformed credential documents fail without revealing credential contents', (t) => {
  const { root, home } = fixture(t);
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs: [fixture-secret: broken\n');
  assert.throws(() => resolvePaperModelEnv({}, home, root), (error) => {
    assert.match(error.message, /Invalid managed credential store/);
    assert.doesNotMatch(error.message, /fixture-secret/);
    return true;
  });
});
