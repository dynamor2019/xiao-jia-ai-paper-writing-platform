import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface InputPolicy {
  schema_version: number;
  allow_generated_missing_inputs: boolean;
  allow_automatic_scope_change: boolean;
  allowed_primary_result_origins: string[];
}

/** Read explicit project policy without changing global defaults or provider configuration. */
function readPolicy(outputDir: string): InputPolicy | undefined {
  const path = join(outputDir, 'milestones', 'reproducibility', 'research-input-policy.json');
  if (!existsSync(path)) return undefined;
  const policy = JSON.parse(readFileSync(path, 'utf8')) as InputPolicy;
  if (policy.schema_version !== 1 || typeof policy.allow_generated_missing_inputs !== 'boolean'
    || typeof policy.allow_automatic_scope_change !== 'boolean'
    || !Array.isArray(policy.allowed_primary_result_origins)
    || !policy.allowed_primary_result_origins.length
    || policy.allowed_primary_result_origins.some((origin) => typeof origin !== 'string' || !origin.trim())) {
    throw new Error('Invalid research input policy; explicit source/generation boundary required');
  }
  return policy;
}

/** Stop the wrong experiment branch before paid rewriting, retaining original files and checkpoints. */
export function assertPrimaryExperimentScope(outputDir: string, resultsFile?: string): void {
  const policy = readPolicy(outputDir);
  if (!policy || policy.allow_automatic_scope_change) return;
  if (!resultsFile || !existsSync(resultsFile)) throw new Error('Missing primary experiment result; no synthetic fallback is permitted by project policy');
  const result = JSON.parse(readFileSync(resultsFile, 'utf8')) as { data_origin?: string };
  if (!result.data_origin || !policy.allowed_primary_result_origins.includes(result.data_origin)) {
    throw new Error(`Active result ${result.data_origin || 'UNDECLARED'} is not the authorized primary experiment. Retain it as supplemental evidence; finish the source-anchored experiment instead of changing the research goal.`);
  }
}

/** Carry missing-input permissions and mandatory disclosure into every post-experiment task. */
export function researchInputInstructions(outputDir: string): string {
  const policy = readPolicy(outputDir);
  if (!policy) return '';
  return [
    'Current explicit project input policy supersedes historical scope-change notes.',
    policy.allow_generated_missing_inputs
      ? 'Missing INPUT parameters may be generated as bounded experience-based assumptions. Register values, units, rationale, generation rule, sensitivity range, affected claims and replacement sources separately; preserve every available real source value.'
      : 'Do not generate missing input parameters without explicit authorization.',
    'Do not generate experimental OUTCOMES. Execute reproducible code to obtain results and preserve failures and adverse cases.',
    'Source design properties are not field measurements. Inferred topology and assumed fan/device parameters are model assumptions, not recovered project facts.',
    'Disclose assumptions in Methods and limitations and attach the generated-input table. When an assumption materially affects the main result, disclose that dependence in Results and Abstract. Never hide it as a measured quantity.',
    'Experience-based substitution enables model calculations, not field certification; public release and author declarations remain separate.',
    policy.allow_automatic_scope_change ? '' : 'Keep the original source-project research question. A purely synthetic toy study or partial screening cannot silently replace the primary experiment.',
  ].filter(Boolean).join('\n');
}
