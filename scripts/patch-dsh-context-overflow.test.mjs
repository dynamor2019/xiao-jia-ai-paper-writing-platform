import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { patchContextOverflowSource } from './patch-dsh-context-overflow.mjs';

/** Execute the actual adapter classifier with its overflow dependency, without network calls. */
function classifier() {
  const source = patchContextOverflowSource(readFileSync('node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js', 'utf8'));
  const start = source.indexOf('function mapStopReason(message, contextWindow) {');
  const fn = source.slice(start, source.indexOf('\n/**', start));
  return new Function('isContextOverflow', 'isContextWindowExceededError', 'emptyRequiredToolCall',
    'classifyPiAiError', 'CONTEXT_WINDOW_EXCEEDED_CODE', 'EMPTY_RESPONSE_CODE', `${fn}; return mapStopReason;`)(
    isContextOverflow, text => /context.*(?:exceed|overflow)|prompt.*too long/i.test(text), () => undefined,
    () => 'PI_AI_ERROR', 'CONTEXT_WINDOW_EXCEEDED', 'EMPTY_RESPONSE');
}

test('a completed 317517-token response is not discarded because of catalog capacity', () => {
  const classify = classifier();
  assert.equal(classify({ stopReason: 'stop', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Complete answer' }],
    usage: { input: 317517, output: 1105, cacheRead: 0 } }, 262144).kind, 'stop');
});

test('explicit overflow errors and zero-output truncation remain recoverable errors', () => {
  const classify = classifier();
  for (const message of [
    { stopReason: 'error', errorMessage: 'prompt is too long: 300000 > 262144', content: [] },
    { stopReason: 'length', content: [], usage: { input: 262144, cacheRead: 0, output: 0 } },
  ]) assert.equal(classify(message, 262144).failure.code, 'CONTEXT_WINDOW_EXCEEDED');
});

test('the classification patch is idempotent and preserves CRLF and BOM', () => {
  const source = '\uFEFFfunction f() {\r\n\tconst piAiOverflow = isContextOverflow(message, contextWindow);\r\n}\r\n';
  const patched = patchContextOverflowSource(source);
  assert.equal(patchContextOverflowSource(patched), patched);
  assert.equal(patched.charCodeAt(0), 0xfeff);
  assert.equal(patched.split('\n').length, patched.split('\r\n').length);
  assert.throws(() => patchContextOverflowSource('unrecognized upstream'), /uniquely/);
});
