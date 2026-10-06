/** Lossless status/claim boundaries for the conditional source-project network schema. */
const ARTIFACT_TYPE = 'conditional_source_project_finite_network_experiment';
const ORIGIN = 'SOURCE_ANCHORED_MODELLED_EXPERIMENT';
type RecordValue = Record<string, unknown>;

/** Recognize this schema without changing handling of unrelated research results. */
export function isConditionalNetwork(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object'
    && (value as RecordValue).artifact_type === ARTIFACT_TYPE);
}

/** Keep adverse and undefined results explicit instead of converting them to zero or dropping rows. */
export function conditionalNetworkRows(value: RecordValue): RecordValue[] {
  if (value.data_origin !== ORIGIN || value.field_validation !== false || !Array.isArray(value.records)) {
    throw new Error('Conditional network result requires explicit origin and unverified field status');
  }
  return value.records.map((entry: RecordValue) => {
    if (!entry || typeof entry !== 'object' || typeof entry.model_feasible !== 'boolean'
      || typeof entry.candidate_id !== 'string' || !entry.candidate_id
      || typeof entry.scenario_id !== 'string' || !entry.scenario_id
      || typeof entry.reason !== 'string' || !entry.reason || entry.data_origin !== ORIGIN
      || !['design', 'held_out'].includes(String(entry.split))
      || typeof entry.demand_multiplier !== 'number' || !Number.isFinite(entry.demand_multiplier)
      || entry.demand_multiplier <= 0 || typeof entry.grid_kgco2e_kwh !== 'number'
      || !Number.isFinite(entry.grid_kgco2e_kwh) || entry.grid_kgco2e_kwh < 0) {
      throw new Error('Invalid conditional candidate/scenario record');
    }
    if (entry.model_feasible
      ? typeof entry.objective !== 'number' || !Number.isFinite(entry.objective) || entry.objective < 0
      : entry.objective !== null) {
      throw new Error('Feasible outcomes must be finite; failed/unknown outcomes must remain null');
    }
    return { run_id: `${entry.candidate_id}/${entry.scenario_id}`, candidate_id: entry.candidate_id,
      scenario_id: entry.scenario_id, split: entry.split, demand_multiplier: entry.demand_multiplier,
      grid_kgco2e_kwh: entry.grid_kgco2e_kwh, model_feasible: entry.model_feasible,
      reason: entry.reason, objective_kgco2e: entry.model_feasible ? entry.objective : 'UNDEFINED_MODEL_OUTCOME',
      field_validation: 'UNVERIFIED', data_origin: ORIGIN };
  });
}

/** Read every record before constructing bounded writing evidence, not the first bytes of a large file. */
export function conditionalNetworkEvidence(value: RecordValue): string {
  const rows = conditionalNetworkRows(value);
  const selections = value.selections as Record<string, { selected?: string | null; objective?: number }>;
  if (!selections || typeof selections !== 'object') throw new Error('Missing finite-policy selections');
  const selected = new Set(Object.values(selections).map((item) => item.selected).filter(Boolean));
  const records = value.records as RecordValue[];
  for (const identifier of selected) {
    if (!rows.some((row) => row.candidate_id === identifier && row.split === 'design')) {
      throw new Error('Policy selection does not refer to an evaluated candidate');
    }
  }
  const statuses: Record<string, { feasible: number; unresolved: number; failed: number }> = {};
  for (const row of rows) {
    const tally = statuses[String(row.scenario_id)] ||= { feasible: 0, unresolved: 0, failed: 0 };
    if (row.model_feasible) tally.feasible++;
    else if (row.reason === 'UNRESOLVED_TRANSITIONAL_FLOW') tally.unresolved++;
    else tally.failed++;
  }
  const chosenRows = records.filter((row) => selected.has(String(row.candidate_id)))
    .map(({ components: _components, ...row }) => row);
  return JSON.stringify({ artifact_type: ARTIFACT_TYPE, data_origin: ORIGIN,
    sourceHashes: value.sourceHashes, codeHashes: value.codeHashes,
    terminal_count: value.terminal_count, source_terminal_total_m3_s: value.source_terminal_total_m3_s,
    assumed_pressure_root_ifc_id: value.assumed_pressure_root_ifc_id,
    model_assumptions: value.model_assumptions,
    generated_component_parameter_count: Array.isArray(value.generated_component_parameters)
      ? value.generated_component_parameters.length : 0,
    generated_component_parameters: value.generated_component_parameters,
    disclosure: 'Conditional model outputs, not field measurements or certified fan/LCA performance. Component details and generated-component table remain in the full result; do not infer omitted values. Failed or unresolved outcomes remain undefined. Held-out grid variants are deterministic stress cases, not independent statistical samples.',
    candidate_count: new Set(rows.map((row) => row.candidate_id)).size,
    scenario_count: new Set(rows.map((row) => row.scenario_id)).size,
    design_scenario_count: new Set(rows.filter((row) => row.split === 'design').map((row) => row.scenario_id)).size,
    held_out_scenario_count: new Set(rows.filter((row) => row.split === 'held_out').map((row) => row.scenario_id)).size,
    record_count: rows.length, scenario_status_counts: statuses,
    selections: Object.fromEntries(Object.entries(selections).map(([name, entry]) =>
      [name, { selected: entry.selected ?? null, objective: entry.objective ?? null }])),
    selected_candidate_all_scenarios: chosenRows, field_validation: false });
}
