import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PaperPipeline } from './paper-pipeline.js';
import { researchFixture } from './literature-test-fixtures.js';

const REQUIRED = ['research-brief.md', 'topic-discovery.md', 'analysis-plan.md', 'data-validation.md',
  'citation-verification-report.md', 'final-citation-verification-report.md', 'paper-quality-report.md',
  'scientific-review.md', 'docx-quality-report.md', 'research-integrity.md', 'cover-letter.md'];

/** Isolate final-stage state transitions; no experiment, model or converter is run. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-submission-wait-'));
  for (const file of REQUIRED) writeFileSync(join(root, file), 'Checked fixture artifact.');
  writeFileSync(join(root, 'final-scientific-review.md'), 'Manuscript gate: CLEAR\n- [MINOR] [SUBMISSION] Author declarations pending.');
  const metadata: { awaitingApproval?: string; currentStageStartTime?: string } = {};
  const pipeline = Object.assign(Object.create(PaperPipeline.prototype), {
    state: { ...researchFixture(), stage: 'submission-readiness', metadata }, outputDir: root, reportsDir: root, milestoneDir: root,
    ensureSubmissionDocuments: async () => {}, ensureProjectDirs: async () => {}, saveState: () => {}, cleanupRuntimeFiles: async () => {},
  }) as {
    stageSubmissionReadiness(): Promise<void>;
    runLocked(): Promise<unknown>;
    onApproval?: () => Promise<boolean>;
  };
  const cleanup = () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    rmSync(root, { recursive: true, force: true });
  };
  return { root, metadata, pipeline, cleanup };
}

test('pending author requirements preserve manuscript delivery and wait instead of failing', async () => {
  const { root, metadata, pipeline, cleanup } = fixture();
  try {
    await pipeline.stageSubmissionReadiness();
    assert.equal(metadata.awaitingApproval, 'submission-readiness');
    assert.match(readFileSync(join(root, 'submission-manifest.md'), 'utf8'), /Submission status: BLOCKED/);
  } finally { cleanup(); }
});

test('unresolved author requirements cannot be approved by an automatic callback', async () => {
  const { metadata, pipeline, cleanup } = fixture();
  let calls = 0;
  pipeline.onApproval = async () => { calls++; return true; };
  try {
    await pipeline.runLocked();
    assert.equal(calls, 0);
    assert.equal(metadata.awaitingApproval, 'submission-readiness');
  } finally { cleanup(); }
});

test('an approval click rechecks author requirements rather than skipping the gate', async () => {
  const { metadata, pipeline, cleanup } = fixture();
  metadata.awaitingApproval = 'submission-readiness';
  pipeline.onApproval = async () => true;
  try {
    await pipeline.runLocked();
    assert.equal(metadata.awaitingApproval, 'submission-readiness');
  } finally { cleanup(); }
});

test('a missing required artifact remains a blocking failure', async () => {
  const { root, metadata, pipeline, cleanup } = fixture();
  try {
    unlinkSync(join(root, 'docx-quality-report.md'));
    await assert.rejects(pipeline.stageSubmissionReadiness(), /仍缺少产物/);
    assert.equal(metadata.awaitingApproval, undefined);
  } finally { cleanup(); }
});
