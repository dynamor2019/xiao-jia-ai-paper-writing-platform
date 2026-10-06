import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInitialState } from '../config/dsh.config.js';
import { integrateExperiment, integratedProtocol } from './experiment-integration.js';

/** Supply current evidence without making model requests or touching user sessions. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-integrate-'));
  const reference = join(root, 'result.json');
  const protocol = join(root, 'replay.md');
  mkdirSync(join(root, 'independent-audit'));
  mkdirSync(join(root, '.dsh-state'));
  writeFileSync(reference, JSON.stringify({ data_origin: 'SOURCE_ANCHORED_MODELLED_EXPERIMENT' }));
  writeFileSync(protocol, '# Frozen Research Protocol\nReplay known exploratory results; no preregistration claim.\n');
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(join(root, 'independent-audit', 'numerical-audit.json'), JSON.stringify({ status: 'PASS',
    resultSha256: digest(reference), sourceHashes: { [protocol]: digest(protocol) },
    checks: [{ status: 'PASS', evidence: 'Independent calculation test fixture.' }] }));
  writeFileSync(join(root, '.dsh-state', 'manuscript.md'), 'Old toy manuscript');
  writeFileSync(join(root, '.dsh-state', 'paper-pipeline-state.json'), 'old checkpoint');
  const state = createInitialState('Original real-source research question');
  state.topic = 'Old toy title';
  state.metadata.originalTopic = 'Original real-source research question';
  state.metadata.experimentCommand = 'python replay.py';
  state.metadata.resultsFile = join(root, 'new-result.json');
  state.stage = 'quality-validation';
  return { root, state, request: { referenceResult: reference, protocolFile: protocol, reason: 'Restore source experiment' } };
}

test('integration archives stale prose and returns through execution gates; repeated resume is idempotent', () => {
  const { root, state, request } = fixture();
  try {
    assert.equal(integrateExperiment(root, state, request), true);
    assert.equal(state.stage, 'experiment-execution');
    assert.equal(state.topic, 'Original real-source research question');
    assert.equal(state.sections.length, 0);
    assert.equal(existsSync(join(root, '.dsh-state', 'manuscript.md')), false);
    assert.equal(integratedProtocol(state), request.protocolFile);
    state.stage = 'methods-writing';
    assert.equal(integrateExperiment(root, state, request), false);
    assert.equal(state.stage, 'methods-writing');
    writeFileSync(request.protocolFile, 'changed');
    assert.throws(() => integratedProtocol(state), /changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changed source fingerprint rejects integration before archiving any manuscript', () => {
  const { root, state, request } = fixture();
  try {
    writeFileSync(request.protocolFile, '# Frozen Research Protocol\nModified after audit.');
    assert.throws(() => integrateExperiment(root, state, request), /changed/);
    assert.equal(state.stage, 'quality-validation');
    assert.equal(readFileSync(join(root, '.dsh-state', 'manuscript.md'), 'utf8'), 'Old toy manuscript');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
