import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionalNetworkEvidence, conditionalNetworkRows } from './conditional-network-results.js';

/** Include deliberately bulky component details before the scientifically important final records. */
function fixture() {
  const origin = 'SOURCE_ANCHORED_MODELLED_EXPERIMENT';
  const row = { candidate_id: 'a', scenario_id: 'D1', split: 'design', model_feasible: true,
    objective: 12, demand_multiplier: 1, grid_kgco2e_kwh: 0.2, reason: 'PASS_CONDITIONAL_RADIAL_MODEL_ONLY',
    data_origin: origin, components: 'x'.repeat(30000) };
  return { artifact_type: 'conditional_source_project_finite_network_experiment', data_origin: origin,
    field_validation: false, records: [row, { ...row, scenario_id: 'H1', split: 'held_out',
      model_feasible: false, reason: 'VELOCITY_SCREEN_FAILURE', objective: null }],
    selections: { minimax: { selected: 'a', objective: 12 } } };
}

test('failed network outcomes are retained as undefined, never missing or zero', () => {
  const result = fixture();
  assert.equal(conditionalNetworkRows(result)[1].objective_kgco2e, 'UNDEFINED_MODEL_OUTCOME');
  result.records[1].objective = 0;
  assert.throws(() => conditionalNetworkRows(result), /remain null/);
});

test('writing evidence reaches final held-out failures without sending component details', () => {
  const evidence = conditionalNetworkEvidence(fixture());
  assert.ok(evidence.length < 4000);
  assert.match(evidence, /H1/);
  assert.match(evidence, /VELOCITY_SCREEN_FAILURE/);
  assert.match(evidence, /not field measurements/);
  assert.doesNotMatch(evidence, /xxxxx/);
});

test('unknown feasibility, measured-field claims and nonexistent policy selections are rejected', () => {
  assert.throws(() => conditionalNetworkRows({ ...fixture(), field_validation: true }), /unverified/);
  assert.throws(() => conditionalNetworkEvidence({ ...fixture(), selections: { minimax: { selected: 'absent' } } }), /evaluated candidate/);
  assert.throws(() => conditionalNetworkRows({ ...fixture(), records: [{ ...fixture().records[0], model_feasible: null }] }), /Invalid/);
});
