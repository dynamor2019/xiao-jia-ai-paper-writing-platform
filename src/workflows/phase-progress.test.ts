import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../config/dsh.config.js';
import { PAPER_PHASES, paperStages, groupPaperPhases } from '../../config/dsh/web/paper-phases.js';
import { beginTask, finishTask, canDegradeTask, assertRecoverableContentFailure, resolveTaskMarkers } from './phase-progress.js';

test('six phases own every stable task exactly once and write results before the introduction', () => {
  const stages = paperStages();
  assert.equal(PAPER_PHASES.length, 6);
  assert.equal(stages.length, 20);
  assert.equal(new Set(stages).size, stages.length);
  assert.ok(stages.indexOf('data-validation') < stages.indexOf('literature-search'));
  assert.ok(stages.indexOf('results-writing') < stages.indexOf('introduction-writing'));
  assert.ok(stages.indexOf('discussion-writing') < stages.indexOf('manuscript-completion'));
});

test('degraded checks never show passed on the six-phase workbench', () => {
  const stages = paperStages().map((id) => ({ id, label: id, status: id === 'quality-validation' ? 'degraded' : 'complete' }));
  const phases = groupPaperPhases(stages);
  assert.equal(phases.find((phase) => phase.id === 'gates')?.passed, false);
  assert.equal(phases.find((phase) => phase.id === 'gates')?.status, 'degraded');
  assert.equal(phases.find((phase) => phase.id === 'delivery')?.passed, true);
});

test('failed tasks retain a three-attempt ceiling across serialized resumes', () => {
  const state = createInitialState('Question');
  for (let i = 0; i < 3; i++) {
    beginTask(state, 'experiment-execution');
    finishTask(state, 'experiment-execution', 'failed', 'timeout');
  }
  assert.throws(() => beginTask(JSON.parse(JSON.stringify(state)), 'experiment-execution'), /attempt limit/);
});

test('backward handoffs cannot create unlimited paid loops', () => {
  const state = createInitialState('Question');
  for (let i = 0; i < 3; i++) {
    beginTask(state, 'citation-verification');
    finishTask(state, 'citation-verification', 'waiting', 'Handed off to literature-search');
  }
  assert.throws(() => beginTask(state, 'citation-verification'), /attempt limit/);
});

test('interrupted running records cannot escape the persisted attempt ceiling', () => {
  const state = createInitialState('Question');
  for (let i = 0; i < 3; i++) beginTask(state, 'protocol-design');
  assert.throws(() => beginTask(state, 'protocol-design'), /attempt limit/);
});

test('review outages degrade but billing and scientific integrity failures stop', () => {
  assert.equal(canDegradeTask('quality-validation', new Error('HTTP 503')), true);
  assert.equal(canDegradeTask('polishing', new Error('timeout')), true);
  assert.equal(canDegradeTask('data-validation', new Error('invalid data')), false);
  assert.equal(canDegradeTask('quality-validation', new Error('Bound experiment results changed')), false);
  assert.equal(canDegradeTask('quality-validation', new Error('insufficient balance')), false);
  assert.throws(() => assertRecoverableContentFailure('insufficient_quota'), /insufficient_quota/);
});

test('billing failures need explicit restored-account confirmation without resetting attempts', () => {
  const state = createInitialState('Question');
  beginTask(state, 'quality-validation');
  finishTask(state, 'quality-validation', 'failed', 'insufficient balance');
  assert.throws(() => beginTask(state, 'quality-validation'), /restored-account confirmation/);
  assert.equal(canDegradeTask('quality-validation', 'Billing failure requires explicit restored-account confirmation'), false);
  assert.doesNotThrow(() => beginTask(state, 'quality-validation', true));
});

test('successful gate revalidation clears only its own markers and retains skipped prose gaps', () => {
  const state = createInitialState('Question');
  state.metadata.draftMarkers = ['[quality-validation] Review unavailable', '[methods-writing] Paragraph missing', '[citation-verification] Source mismatch'];
  resolveTaskMarkers(state, 'quality-validation');
  assert.deepEqual(state.metadata.draftMarkers, ['[methods-writing] Paragraph missing', '[citation-verification] Source mismatch']);
  resolveTaskMarkers(state, 'methods-writing');
  assert.equal(state.metadata.draftMarkers.length, 2);
});
