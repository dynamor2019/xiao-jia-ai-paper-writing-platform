import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPrimaryExperimentScope, researchInputInstructions } from './research-input-policy.js';

/** Create an isolated explicit-policy project; no credentials or model requests. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-input-policy-'));
  const directory = join(root, 'milestones', 'reproducibility');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'research-input-policy.json'), JSON.stringify({ schema_version: 1,
    allow_generated_missing_inputs: true, allow_automatic_scope_change: false,
    allowed_primary_result_origins: ['SOURCE_ANCHORED_MODELLED_EXPERIMENT'] }));
  return root;
}

test('disclosed missing-input generation does not authorize replacing the main experiment with a toy', () => {
  const root = fixture();
  try {
    const path = join(root, 'result.json');
    writeFileSync(path, JSON.stringify({ data_origin: 'SYNTHETIC_METHOD_BENCHMARK_01' }));
    assert.throws(() => assertPrimaryExperimentScope(root, path), /not the authorized primary experiment/);
    writeFileSync(path, JSON.stringify({ data_origin: 'SOURCE_ANCHORED_MODELLED_SCREENING' }));
    assert.throws(() => assertPrimaryExperimentScope(root, path), /not the authorized primary experiment/);
    writeFileSync(path, JSON.stringify({ data_origin: 'SOURCE_ANCHORED_MODELLED_EXPERIMENT' }));
    assert.doesNotThrow(() => assertPrimaryExperimentScope(root, path));
    const instructions = researchInputInstructions(root);
    assert.match(instructions, /Missing INPUT parameters may be generated/);
    assert.match(instructions, /Do not generate experimental OUTCOMES/);
    assert.match(instructions, /Results and Abstract/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('projects without explicit input policy retain existing behavior', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-input-default-'));
  try {
    assert.equal(researchInputInstructions(root), '');
    assert.doesNotThrow(() => assertPrimaryExperimentScope(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
