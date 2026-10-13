import type { PipelineStage, PipelineState } from '../types.js';

export interface TaskProgress {
  status: 'running' | 'complete' | 'waiting' | 'degraded' | 'failed';
  attempts: number;
  updatedAt: string;
  error?: string;
}
export type ProgressState = PipelineState & {
  metadata: PipelineState['metadata'] & {
    workflow?: { version: 1; tasks: Partial<Record<PipelineStage, TaskProgress>> };
  };
};
const OPTIONAL_TASKS = new Set<PipelineStage>(['citation-verification', 'polishing', 'quality-validation', 'formatting']);
const BILLING = /insufficient balance|billing_error|insufficient_quota|credit balance|billing failure|余额不足|额度不足/i;
const INTEGRITY = /protected .*changed|bound .*changed|验收后发生变化|实证证据.*变化|缺少实验结果|缺少机器可读|缺少 result-provenance|禁止开始论文行文|Invalid research input policy|unauthorized primary|not the authorized primary|interpretation is incomplete|Invalid workflow/i;

/** Start a persisted task attempt without resetting limits on process restarts. */
export function beginTask(state: ProgressState, stage: PipelineStage, billingRestored = false): void {
  const workflow = state.metadata.workflow ||= { version: 1, tasks: {} };
  const previous = workflow.tasks[stage];
  if (previous?.status === 'failed' && BILLING.test(previous.error || '') && !billingRestored) {
    throw new Error('Billing failure requires explicit restored-account confirmation; no paid resume was started.');
  }
  if (previous && previous.attempts >= 3 && (['failed', 'running', 'degraded'].includes(previous.status) || previous.error?.startsWith('Handed off'))) {
    throw new Error(`Task attempt limit reached: ${stage}; 为避免重复计费，已停止自动重试。`);
  }
  workflow.tasks[stage] = {
    status: 'running', attempts: (previous?.attempts || 0) + 1, updatedAt: new Date().toISOString(),
  };
}

/** Persist actual outcomes, not success inferred from filenames or stage positions. */
export function finishTask(state: ProgressState, stage: PipelineStage, status: TaskProgress['status'], error?: string): void {
  const workflow = state.metadata.workflow ||= { version: 1, tasks: {} };
  workflow.tasks[stage] = {
    status, attempts: workflow.tasks[stage]?.attempts || 0, updatedAt: new Date().toISOString(), error,
  };
}

/** Only optional presentation/review failures can fall back to a visibly unvalidated draft. */
export function canDegradeTask(stage: PipelineStage, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return OPTIONAL_TASKS.has(stage) && !BILLING.test(message) && !INTEGRITY.test(message);
}

/** Do not retry billing incidents or integrity failures inside paragraph/revision loops. */
export function assertRecoverableContentFailure(error: string): void {
  if (BILLING.test(error) || INTEGRITY.test(error)) throw new Error(error);
}

/** Clear only this gate's owned markers after successful revalidation, never skipped prose gaps. */
export function resolveTaskMarkers(state: ProgressState, stage: PipelineStage): void {
  if (!OPTIONAL_TASKS.has(stage) && stage !== 'export') return;
  state.metadata.draftMarkers = state.metadata.draftMarkers?.filter((message) => !message.startsWith(`[${stage}] `));
}
