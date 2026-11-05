import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSystemMessage } from '@deepseek-ai/dsh-llm';

/** Exercise the installed native projection rather than a copied implementation. */
function projection() {
  const source = readFileSync('node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', 'utf8');
  const start = source.indexOf('var SystemPromptProjection = class {');
  const end = source.indexOf('/** Tracks the last retained runtime-context snapshot', start);
  assert.ok(start >= 0 && end > start, 'Native system prompt projection must be identifiable');
  const factory = new Function('createSystemMessage', 'textOf',
    `${source.slice(start, end)}; return SystemPromptProjection;`);
  const Projection = factory(createSystemMessage, message => message.content[0]?.text || '');
  const messages = ['original instructions', 'updated instructions'];
  return new Projection({ surface: { nodes: [0, 1] }, eventAt: seq => ({
    type: 'system/message', data: { message: createSystemMessage(messages[seq]) },
  }) });
}

test('new request series preserves an unchanged effective prompt and cached prefix', () => {
  assert.deepEqual(projection().project('updated instructions', { inHistory: true, startsSeries: true }), []);
});

test('a changed prompt and routes without in-history system support still normalize correctly', () => {
  for (const input of [{ inHistory: true, startsSeries: true }, { inHistory: false, startsSeries: false }]) {
    const changes = projection().project('new instructions', input);
    assert.equal(changes.length, 2);
    assert.equal(changes[0].message.content[0]?.text || '', '');
    assert.equal(changes[1].message.content[0].text, 'new instructions');
  }
});
