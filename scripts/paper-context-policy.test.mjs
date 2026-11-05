import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';

test('paper context policy preserves a reusable prefix without unlimited summary calls', () => {
  const presets = parse(readFileSync('config/dsh/presets/paper/agent.cordis.yml', 'utf8'));
  const group = presets.find(plugin => plugin.id === 'compaction');
  const { config } = group.config.find(plugin => plugin.id === 'compaction-basic');
  assert.equal(config.thresholdRatio, 0.75);
  assert.equal(config.retainRatio, 0.25);
  assert.ok(config.retainRatio < config.thresholdRatio);
  assert.ok(config.maxTokens <= config.headroomTokens);
  assert.equal(config.maxTokens, 8192);
  assert.equal(config.compactionRetries, 0);
  assert.equal(config.maxOverflowRetries, 1);
  assert.equal(config.summarizationProvider, undefined);
  assert.equal(config.summarizationModel, undefined);
  const grok = config.modelPolicies.find(policy => policy.provider === 'sub2api-grok' && policy.model === 'grok-4.7');
  assert.equal(grok.thresholdRatio, 0.25);
  assert.equal(grok.retainRatio, 0.08);
  const trigger = 1_000_000 * grok.thresholdRatio;
  assert.ok(trigger + 32768 + config.headroomTokens < 512000);
  assert.ok(1_000_000 * grok.retainRatio + config.maxTokens < trigger);
});

test('paper recovery requires original evidence instead of treating absent context as missing work', () => {
  const presets = parse(readFileSync('config/dsh/presets/paper/agent.cordis.yml', 'utf8'));
  const prefix = presets.find(plugin => plugin.id === 'persona').config.prefix;
  assert.match(prefix, /read the bound project's existing pipeline state/);
  assert.match(prefix, /Do not repeat completed experiments/);
  assert.match(prefix, /Missing context is not evidence that work is missing/);
  const group = presets.find(plugin => plugin.id === 'compaction');
  const { config } = group.config.find(plugin => plugin.id === 'tool-result-pruner');
  assert.deepEqual(config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
});

test('custom personas render with native variables and keep literal cwd in runtime context', () => {
  for (const preset of ['paper', 'super', 'liangshen']) {
    const plugins = parse(readFileSync(`config/dsh/presets/${preset}/agent.cordis.yml`, 'utf8'), { logLevel: 'silent' });
    const persona = plugins.find(plugin => plugin.id === 'persona');
    if (!persona) continue;
    const assembly = { variables: { provider: 'fixture', model: 'fixture-model' },
      sections: ['prefix', 'suffix'].map(key => ({ name: `deployment:persona-${key}`, text: persona.config[key] || '' })),
      contexts: [{ name: 'working-directory:current', interpolate: false,
        text: 'Current working directory: "C:/research/{{literal-folder}}".' }],
    };
    assert.doesNotThrow(() => renderPrompt(assembly), preset);
    assert.match(renderContextSnapshot(assembly), /C:\/research\/\{\{literal-folder\}\}/);
    assert.doesNotThrow(() => renderPrompt({ ...assembly, sections: [...assembly.sections,
      { name: 'next-step', text: 'Continue the saved project.' }] }));
  }
});
