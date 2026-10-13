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

test('compact evidence retains source identity without certifying field validation', () => {
  const source = { ...fixture(), model_id: 'source-model', system_name: '302PK01', source_roles: ['terminal_design_demands'] };
  const evidence = JSON.parse(conditionalNetworkEvidence(source));
  assert.equal(evidence.model_id, source.model_id);
  assert.equal(evidence.system_name, source.system_name);
  assert.deepEqual(evidence.source_roles, source.source_roles);
  assert.equal(evidence.field_validation, false);
});

test('writing evidence reaches final held-out failures without sending component details', () => {
  const evidence = conditionalNetworkEvidence(fixture());
  assert.ok(evidence.length < 4000);
  assert.match(evidence, /H1/);
  assert.match(evidence, /VELOCITY_SCREEN_FAILURE/);
  assert.match(evidence, /not field measurements/);
  assert.doesNotMatch(evidence, /xxxxx/);
  const counts = JSON.parse(evidence);
  assert.equal(counts.candidate_count, 1);
  assert.equal(counts.scenario_count, 2);
  assert.equal(counts.design_scenario_count, 1);
  assert.equal(counts.held_out_scenario_count, 1);
  assert.equal(counts.record_count, 2);
});

test('held-out regret uses all feasible alternatives and never inherits the design bound', () => {
  const source = fixture();
  const row = source.records[0];
  source.records = [row, { ...row, candidate_id: 'b', objective: 10 },
    { ...row, scenario_id: 'H1', split: 'held_out', objective: 20 },
    { ...row, candidate_id: 'b', scenario_id: 'H1', split: 'held_out', objective: 10 }];
  const evidence = JSON.parse(conditionalNetworkEvidence(source));
  assert.equal(evidence.scenario_best_feasible_objective_kgco2e.H1, 10);
  const summary = evidence.selected_candidate_regret_summary.a;
  assert.equal(summary.design.max_regret_all_scenarios_kgco2e, 2);
  assert.equal(summary.held_out.max_regret_all_scenarios_kgco2e, 10);
  source.records.push({ ...row, scenario_id: 'H2', split: 'held_out', model_feasible: false,
    objective: null, reason: 'UNRESOLVED_TRANSITIONAL_FLOW' });
  const incomplete = JSON.parse(conditionalNetworkEvidence(source));
  assert.equal(incomplete.scenario_best_feasible_objective_kgco2e.H2, null);
  assert.equal(incomplete.selected_candidate_regret_summary.a.held_out.max_regret_all_scenarios_kgco2e, null);
  assert.equal(incomplete.selected_candidate_regret_summary.a.held_out.failed_or_unresolved, 1);
});

test('unknown feasibility, measured-field claims and nonexistent policy selections are rejected', () => {
  assert.throws(() => conditionalNetworkRows({ ...fixture(), field_validation: true }), /unverified/);
  assert.throws(() => conditionalNetworkEvidence({ ...fixture(), selections: { minimax: { selected: 'absent' } } }), /evaluated candidate/);
  assert.throws(() => conditionalNetworkRows({ ...fixture(), records: [{ ...fixture().records[0], model_feasible: null }] }), /Invalid/);
});
