import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolvePaperModelEnv } from './paper-model-env.mjs';

for (const filename of ['settings.yaml', 'settings.yaml.imported']) {
  test(`preserves existing keys and URLs while resolving Responses from ${filename}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-model-env-'));
    try {
      writeFileSync(join(home, filename), 'llm-pi-ai:\n  providers:\n    rayinai-claude:\n      api: openai-responses\n      apiKeyEnv: CLAUDE_KEY\n      baseURL: https://unused.invalid/v1\n');
      const env = { ANTHROPIC_API_KEY: 'existing-private-group', ANTHROPIC_BASE_URL: 'https://existing.invalid/v1', ANTHROPIC_API_MODE: 'openai-completions' };
      const resolved = resolvePaperModelEnv(env, home);
      assert.equal(resolved.ANTHROPIC_API_MODE, 'openai-responses');
      assert.equal(resolved.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY);
      assert.equal(resolved.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
      assert.equal(env.ANTHROPIC_API_MODE, 'openai-completions');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('managed child projections refresh credentials, models and endpoints without stale environment promotion', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-model-refresh-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const settings = (model, baseURL) => writeFileSync(join(home, 'settings.yaml'), JSON.stringify({
    'llm-pi-ai': { providers: { rayinai: {
      api: 'openai-completions', apiKeyEnv: 'OPENAI_API_KEY', baseURL, models: [{ id: model }],
    } } },
  }));
  const credentials = (refs) => writeFileSync(join(home, '.credentials.yaml'), JSON.stringify({ version: 1, refs }));
  settings('initial-model', 'https://initial.invalid/v1');
  credentials({ OPENAI_API_KEY: 'initial-fixture' });
  const initial = resolvePaperModelEnv({}, home, home);
  settings('updated-model', 'https://updated.invalid/v1');
  credentials({ OPENAI_API_KEY: 'updated-fixture' });
  const refreshed = resolvePaperModelEnv(initial, home, home);
  assert.equal(refreshed.OPENAI_API_KEY, 'updated-fixture');
  assert.equal(refreshed.OPENAI_BASE_URL, 'https://updated.invalid/v1');
  assert.equal(refreshed.OPENAI_MODEL, 'updated-model');
  assert.equal(initial.OPENAI_API_KEY, 'initial-fixture');
  assert.ok(!refreshed.DSH_MANAGED_MODEL_FIELDS.includes('fixture'));
  credentials({});
  assert.equal(resolvePaperModelEnv(refreshed, home, home).OPENAI_API_KEY, undefined);
});

test('explicit credentials and URLs remain explicit across repeated resolution', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-model-explicit-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'settings.yaml'), JSON.stringify({ 'llm-pi-ai': { providers: {
    rayinai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://managed.invalid/v1' },
  } } }));
  writeFileSync(join(home, '.credentials.yaml'), JSON.stringify({ version: 1, refs: { OPENAI_API_KEY: 'managed-fixture' } }));
  const explicit = { OPENAI_API_KEY: 'explicit-fixture', OPENAI_BASE_URL: 'https://explicit.invalid/v1' };
  const result = resolvePaperModelEnv(resolvePaperModelEnv(explicit, home, home), home, home);
  assert.equal(result.OPENAI_API_KEY, explicit.OPENAI_API_KEY);
  assert.equal(result.OPENAI_BASE_URL, explicit.OPENAI_BASE_URL);
});

test('projection metadata cannot remove arbitrary application variables', () => {
  for (const marker of ['invalid-json', '{}', '["PATH"]', '[123]']) {
    assert.throws(() => resolvePaperModelEnv({ DSH_MANAGED_MODEL_FIELDS: marker }), /Invalid managed model environment metadata/);
  }
});
