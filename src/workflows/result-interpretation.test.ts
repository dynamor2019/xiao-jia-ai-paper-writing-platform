import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resultInterpretationInstructions } from './result-interpretation.js';

test('missing interpretation never invents support and preserves negative outcomes', () => {
  const text = resultInterpretationInstructions('nonexistent');
  assert.match(text, /unsupported/);
  assert.match(text, /exploratory/);
  assert.match(text, /conflicting/);
});

test('result-bound decisions permit unsupported hypotheses but reject stale hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-interpretation-'));
  try {
    const result = join(root, 'results.json');
    writeFileSync(result, '{"results":[{"id":1,"value":-1}]}');
    const directory = join(root, 'milestones', 'reproducibility');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'result-interpretation.json'), JSON.stringify({
      resultSha256: createHash('sha256').update('{"results":[{"id":1,"value":-1}]}').digest('hex'),
      originalHypothesis: 'Improvement across all candidates', outcome: 'unsupported',
      explanation: 'No universal improvement observed in this conditional model.', exploratoryHypothesis: 'Boundary-dependent effects',
    }));
    assert.match(resultInterpretationInstructions(root, result), /unsupported/);
    writeFileSync(result, '{"results":[]}');
    assert.throws(() => resultInterpretationInstructions(root, result), /bound results changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
