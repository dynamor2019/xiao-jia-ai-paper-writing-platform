import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../config/dsh.config.js';
import { PaperPipeline, PIPELINE_STAGES } from './paper-pipeline.js';
import type { ProgressState } from './phase-progress.js';
import type { PipelineStage } from '../types.js';

/** Exercise scheduling with injected stage methods, never models or experiments. */
function fixture(stage: PipelineStage, fail?: PipelineStage, error = 'HTTP 503') {
  const state: ProgressState = { ...createInitialState('Question'), stage };
  const calls: PipelineStage[] = [];
  const pipeline = Object.assign(Object.create(PaperPipeline.prototype), {
    state, outputDir: 'test-only', saveState: () => {}, cleanupRuntimeFiles: async () => {},
    recordDraftMarker: async (message: string) => { (state.metadata.draftMarkers ||= []).push(message); },
    executeStage: async (task: PipelineStage) => {
      calls.push(task);
      if (task === fail) throw new Error(error);
      if (task === 'submission-readiness') state.metadata.awaitingApproval = task;
    },
  }) as { runLocked(): Promise<unknown> };
  return { state, pipeline, calls };
}

test('optional review failure continues to draft export and ends awaiting author', async () => {
  const { state, pipeline, calls } = fixture('quality-validation', 'quality-validation');
  await pipeline.runLocked();
  assert.ok(calls.includes('export'));
  assert.equal(state.metadata.workflow?.tasks['quality-validation']?.status, 'degraded');
  assert.equal(state.metadata.awaitingApproval, 'submission-readiness');
  assert.equal(state.metadata.workflow?.tasks['submission-readiness']?.status, 'waiting');
});

test('data failure never advances to literature or writing', async () => {
  const { state, pipeline, calls } = fixture('data-validation', 'data-validation', 'invalid source');
  await assert.rejects(pipeline.runLocked(), /invalid source/);
  assert.deepEqual(calls, ['data-validation']);
  assert.equal(state.metadata.workflow?.tasks['data-validation']?.status, 'failed');
});

test('billing failures never continue through optional stages', async () => {
  const { pipeline, calls } = fixture('quality-validation', 'quality-validation', 'insufficient balance');
  await assert.rejects(pipeline.runLocked(), /insufficient balance/);
  assert.deepEqual(calls, ['quality-validation']);
});

test('unknown checkpoint stage fails before executing any task', async () => {
  const { state, pipeline, calls } = fixture('project-intake');
  state.stage = 'obsolete-unknown' as PipelineStage;
  await assert.rejects(pipeline.runLocked(), /Invalid workflow checkpoint/);
  assert.equal(calls.length, 0);
});

test('successful task checkpoints advance so resumes do not pay to repeat them', async () => {
  const { state, pipeline, calls } = fixture('formatting', 'export', 'converter missing');
  await assert.rejects(pipeline.runLocked(), /converter missing/);
  assert.equal(state.stage, 'export');
  assert.equal(state.metadata.workflow?.tasks.formatting?.status, 'complete');
  assert.deepEqual(calls, PIPELINE_STAGES.slice(PIPELINE_STAGES.indexOf('formatting'), PIPELINE_STAGES.indexOf('export') + 1));
});

test('a plan added while awaiting protocol approval runs its pilot before advancing', async () => {
  const { state, pipeline, calls } = fixture('protocol-design');
  state.metadata.awaitingApproval = 'protocol-design';
  let pilotCalls = 0;
  Object.assign(pipeline, { onApproval: async () => true, runPlannedExperiments: async (phase: string) => {
    assert.equal(phase, 'pilot'); pilotCalls++;
  } });
  await pipeline.runLocked();
  assert.equal(pilotCalls, 1);
  assert.equal(calls[0], 'experiment-execution');
});
