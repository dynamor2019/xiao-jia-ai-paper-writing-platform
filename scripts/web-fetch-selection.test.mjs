import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { defaultWebFetchProvider } from './web-fetch-selection.mjs';

test('the shipped profile selects fetch and academic search independently', () => {
  const profile = parse(readFileSync(new URL('../config/dsh/web/cordis.patch.yml', import.meta.url), 'utf8'), { logLevel: 'silent' });
  const config = profile.find(item => item.id === 'web').config;
  assert.equal(config.fetchProvider, 'http');
  assert.equal(config.searchProvider, 'openalex');
});

/** Use the installed core's actual provider registry, with network-free provider results. */
function runtime(t, configured, reverse = false) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const web = new WebRuntime(ctx, { fetchProvider: { get: () => configured }, searchProvider: { get: () => 'openalex' } });
  for (const id of reverse ? ['http', 'deepseek-fetch-api'] : ['deepseek-fetch-api', 'http']) {
    web.registerFetchProvider({ id, available: () => true, ready: provider => id === 'http' || provider === 'deepseek',
      fetch: async () => ({ provider: id }) });
  }
  return web;
}

test('reproduces the installed core ambiguity before the configuration fix', async t => {
  await assert.rejects(runtime(t).fetch({ url: 'https://example.com' }), { code: 'WEB_PROVIDER_AMBIGUOUS' });
});

for (const reversed of [false, true]) {
  test(`explicit HTTP fetch is model-independent and order-independent (${reversed})`, async t => {
    const web = runtime(t, 'http', reversed);
    for (const provider of ['rayinai', 'rayinai-claude', 'sub2api-grok', 'deepseek']) {
      assert.equal(await web.fetchReady(provider), true);
      assert.equal((await web.fetch({ url: 'https://example.com', llmProvider: provider })).provider, 'http');
    }
  });
}

for (const eol of ['\n', '\r\n']) {
  test(`migration preserves BOM, comments, model configuration and search for ${JSON.stringify(eol)}`, () => {
    const original = ['\uFEFF# user comment', '- id: llm-pi-ai', '  config: { providers: { private: { apiKeyEnv: PRIVATE_KEY } } }',
      '- id: web', '  config:', '    searchProvider: openalex # keep', '- id: other', ''].join(eol);
    const fixed = defaultWebFetchProvider(original);
    assert.equal(fixed.replace(`    fetchProvider: http${eol}`, ''), original);
    assert.equal(defaultWebFetchProvider(fixed), fixed);
    assert.equal(parse(fixed).find(item => item.id === 'web').config.searchProvider, 'openalex');
  });
}

test('existing explicit user choices, including disabled selection, remain untouched', () => {
  for (const value of ['deepseek-fetch-api', 'http', 'null']) {
    const source = `- id: web\n  config: { fetchProvider: ${value}, searchProvider: custom }\n`;
    assert.equal(defaultWebFetchProvider(source), source);
  }
});

test('missing and inline web blocks receive only the default fetch selection', () => {
  for (const source of ['- id: other\n', '- id: web\n', '- id: web\n  config: { searchProvider: openalex }\n']) {
    const fixed = defaultWebFetchProvider(source);
    assert.equal(parse(fixed).find(item => item.id === 'web').config.fetchProvider, 'http');
  }
});

test('ambiguous or malformed YAML fails without producing a replacement profile', () => {
  assert.throws(() => defaultWebFetchProvider('- id: web\n- id: web\n'));
  assert.throws(() => defaultWebFetchProvider('- id: [broken\n'));
});
