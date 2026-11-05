import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncAgentPresets } from './sync-dsh-runtime.mjs';

test('startup cannot rewrite imported API protocols', () => {
  const source = readFileSync(new URL('./start-dsh-web.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /writeFileSync\(settingsImportedPath/);
  assert.doesNotMatch(source, /replace\('api: openai-responses', 'api: openai-completions'\)/);
  assert.doesNotMatch(source, /no-proxy\.mjs|directApiEnv\(/);
  assert.doesNotMatch(source, /NO_PROXY:\s*'\*'/);
  assert.doesNotMatch(source, /config-watcher\.mjs/);
  assert.match(source, /resolveWebProxyEnv\(process.env\)/);
});

test('pipeline resume cannot promote stages from file existence alone', () => {
  const source = readFileSync(new URL('../src/workflows/paper-pipeline.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /detectActualStage\(/);
  assert.match(source, /assertPrimaryExperimentScope\(/);
  assert.match(source, /acceptPendingDecision\(/);
});

test('preset synchronization supports LF and CRLF without changing the profile line endings', async () => {
  for (const eol of ['\n', '\r\n']) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-release-presets-'));
    try {
      const file = join(root, 'cordis.patch.yml');
      const prefix = '# preserved user comment' + eol;
      await writeFile(file, prefix + '- id: agent-preset-registry' + eol);
      const count = await syncAgentPresets(root);
      const content = await readFile(file, 'utf8');
      assert.ok(count >= 1);
      assert.ok(content.startsWith(prefix));
      assert.match(content, /id: preset-paper/);
      assert.equal(content.split('- id: agent-preset-registry').length, 2);
      if (eol === '\r\n') assert.doesNotMatch(content, /(?<!\r)\n/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
