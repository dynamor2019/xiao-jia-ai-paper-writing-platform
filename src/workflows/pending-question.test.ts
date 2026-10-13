import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptPendingDecision, stagePendingQuestion } from './paper-pipeline.js';
import type { PipelineState } from '../types.js';

function state(): PipelineState {
  return {
    topic: 'Conditional case',
    stage: 'introduction-writing',
    papers: [],
    notes: new Map(),
    sections: [],
    metadata: { startTime: '', currentStageStartTime: '', modelCalls: 0, totalTokens: 0 },
  };
}

test('an unanswered writing block pauses with explicit choices', () => {
  const checkpoint = state();
  const outcome = stagePendingQuestion(checkpoint, 'paragraph:2.1:1', checkpoint.stage, '这一段没有写成。', [
    { id: 'skip-marked', label: '跳过并标记' },
    { id: 'retry', label: '再试一次' },
  ]);
  assert.equal(outcome, 'pause');
  assert.equal(checkpoint.metadata.awaitingApproval, 'introduction-writing');
  assert.equal(checkpoint.metadata.pendingQuestion?.id, 'paragraph:2.1:1');
  assert.equal(acceptPendingDecision(checkpoint, 'invent'), false);
  assert.equal(acceptPendingDecision(checkpoint, 'skip-marked'), true);
  assert.equal(stagePendingQuestion(checkpoint, 'paragraph:2.1:1', checkpoint.stage, '这一段没有写成。', checkpoint.metadata.pendingQuestion?.choices || []), 'skip-marked');
  assert.equal(checkpoint.metadata.pendingQuestion, undefined);
  assert.equal(checkpoint.metadata.awaitingApproval, undefined);
});
