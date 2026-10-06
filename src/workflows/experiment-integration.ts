import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { PipelineState } from '../types.js';
import { assertPrimaryExperimentScope } from './research-input-policy.js';

export interface ExperimentIntegration {
  referenceResult: string;
  protocolFile: string;
  reason: string;
}
interface IntegrationRecord extends ExperimentIntegration {
  referenceHash: string;
  protocolHash: string;
  resultsFile: string;
  experimentCommand: string;
  archiveDir: string;
}
type IntegratedState = PipelineState & { experimentIntegration?: IntegrationRecord; qualityReviewProgress?: unknown };

/** Compare exact evidence bytes rather than trusting success labels. */
function fingerprint(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Reject out-of-project evidence before any archive or state mutation. */
function projectFile(root: string, path: string): string {
  const full = resolve(path);
  if (!full.startsWith(resolve(root) + sep) || !existsSync(full)) throw new Error('Integration evidence must exist inside the bound project');
  return full;
}

/** Verify the independent replay reference, including every source/executable fingerprint. */
function validateReference(root: string, reference: string): string {
  assertPrimaryExperimentScope(root, reference);
  const hash = fingerprint(reference);
  const audit = JSON.parse(readFileSync(join(dirname(reference), 'independent-audit', 'numerical-audit.json'), 'utf8'));
  if (audit.status !== 'PASS' || audit.resultSha256 !== hash || !Array.isArray(audit.checks)
    || !audit.checks.length || audit.checks.some((check: { status?: string; evidence?: string }) => check.status !== 'PASS' || !check.evidence?.trim())
    || !audit.sourceHashes || !Object.keys(audit.sourceHashes).length) {
    throw new Error('Integration requires a current independent numerical audit, not publication approval');
  }
  for (const [path, expected] of Object.entries(audit.sourceHashes)) {
    if (!existsSync(path) || fingerprint(path) !== expected) throw new Error('Integration source or executable changed: ' + path);
  }
  return hash;
}

/** Return the frozen replay protocol only while its bytes remain unchanged. */
export function integratedProtocol(state: PipelineState): string | undefined {
  const record = (state as IntegratedState).experimentIntegration;
  if (!record) return undefined;
  if (fingerprint(record.protocolFile) !== record.protocolHash) throw new Error('Integrated protocol changed; explicit amendment and revalidation required');
  return record.protocolFile;
}

/** Resolve new audit artifacts without overwriting the historical experiment's reports. */
export function integratedEvidence(state: PipelineState, name: string): string | undefined {
  if (!(state as IntegratedState).experimentIntegration || !state.metadata.resultsFile) return undefined;
  return join(dirname(state.metadata.resultsFile), 'independent-audit', name);
}

/** Archive obsolete writing, then resume through real execution/data gates without marking any stage passed. */
export function integrateExperiment(root: string, state: PipelineState, request: ExperimentIntegration): boolean {
  if (!request.reason.trim() || !state.metadata.experimentCommand || !state.metadata.resultsFile) {
    throw new Error('Integration requires a reason, replay command and new results path');
  }
  const reference = projectFile(root, request.referenceResult);
  const protocol = projectFile(root, request.protocolFile);
  const referenceHash = validateReference(root, reference);
  const protocolHash = fingerprint(protocol);
  if (!/^# Frozen Research Protocol\r?\n/.test(readFileSync(protocol, 'utf8'))) throw new Error('Replay protocol must be explicitly frozen');
  const saved = state as IntegratedState;
  if (saved.experimentIntegration?.referenceHash === referenceHash
    && saved.experimentIntegration.resultsFile === state.metadata.resultsFile
    && saved.experimentIntegration.experimentCommand === state.metadata.experimentCommand
    && saved.experimentIntegration.protocolHash === protocolHash) return false;
  if (resolve(state.metadata.resultsFile) === reference) throw new Error('Replay output must not overwrite the independently audited reference');
  const archiveDir = join(root, 'archives', 'experiment-integration-' + randomUUID());
  mkdirSync(archiveDir, { recursive: true });
  const checkpoint = join(root, '.dsh-state', 'paper-pipeline-state.json');
  if (existsSync(checkpoint)) copyFileSync(checkpoint, join(archiveDir, 'paper-pipeline-state.json'));
  for (const relative of ['.dsh-state/manuscript.md', '.dsh-state/runtime/work', 'final']) {
    const source = join(root, relative);
    if (!existsSync(source)) continue;
    const destination = join(archiveDir, relative);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
  }
  saved.experimentIntegration = { ...request, referenceResult: reference, protocolFile: protocol,
    referenceHash, protocolHash, resultsFile: state.metadata.resultsFile,
    experimentCommand: state.metadata.experimentCommand, archiveDir };
  writeFileSync(join(archiveDir, 'integration.json'), JSON.stringify(saved.experimentIntegration, null, 2) + '\n');
  state.topic = state.metadata.originalTopic || state.topic;
  state.sections = [];
  delete state.outline;
  delete saved.qualityReviewProgress;
  delete state.metadata.awaitingApproval;
  state.stage = 'experiment-execution';
  return true;
}
