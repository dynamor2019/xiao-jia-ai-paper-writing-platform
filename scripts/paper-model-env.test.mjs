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
