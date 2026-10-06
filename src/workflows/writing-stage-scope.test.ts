import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../config/dsh.config.js';
import type { OutlineNode } from '../types.js';
import { reconcileWritingStages, writingTasks } from './writing-stage-scope.js';

/** Titles intentionally contain words that previously caused wrong-phase routing. */
function fixture(): OutlineNode[] {
  const leaf = (id: string, title: string): OutlineNode => ({ id, level: 2, title, estimatedWords: 200, supportingPapers: [] });
  return [{ id: '1', level: 1, title: 'Introduction', estimatedWords: 400, supportingPapers: [],
    children: [leaf('1.1', 'Research gap and contribution'), leaf('1.2', 'Paper organization')] },
  { id: '5', level: 1, title: 'Discussion', estimatedWords: 200, supportingPapers: [],
    children: [leaf('5.1', 'Future work and data requirements')] }];
}

test('chapter ownership includes introduction leaves and prevents data word from stealing discussion', () => {
  assert.deepEqual(writingTasks(fixture()).map((task) => task.stage), ['introduction-writing', 'introduction-writing', 'discussion-writing']);
});

test('resume rewinds missing writing but never rewinds a scientific review or changes completed content', () => {
  const state = createInitialState('Source question');
  state.outline = { topic: state.topic, nodes: fixture(), totalEstimatedWords: 600 };
  state.stage = 'methods-writing';
  reconcileWritingStages(state);
  assert.equal(state.stage, 'introduction-writing');
  state.stage = 'quality-validation';
  reconcileWritingStages(state);
  assert.equal(state.stage, 'quality-validation');
});
