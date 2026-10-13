// The workbench and executor share phase ownership; persisted task IDs stay compatible.
export const PAPER_PHASES = [
  ['direction', '选题与问题', ['project-intake', 'topic-discovery', 'topic-confirmation']],
  ['protocol', '方案与数据路径', ['protocol-design']],
  ['experiments', '正式实验与结果', ['experiment-execution', 'data-validation']],
  ['writing', '文献与成文', ['literature-search', 'literature-review', 'outline-generation', 'results-writing', 'methods-writing', 'discussion-writing', 'introduction-writing', 'manuscript-completion']],
  ['gates', '交叉审查与修订', ['citation-verification', 'polishing', 'quality-validation']],
  ['delivery', '格式与交付', ['formatting', 'export', 'submission-readiness']],
];

/** Return stable task IDs in execution order, without renaming old checkpoints. */
export function paperStages() {
  return PAPER_PHASES.flatMap(([, , tasks]) => tasks);
}

/** Look up the phase that actually owns a task. */
export function phaseForStage(stage) {
  return PAPER_PHASES.find(([, , tasks]) => tasks.includes(stage));
}

/** Render recorded outcomes without treating a degraded gate as passed. */
export function groupPaperPhases(stages) {
  return PAPER_PHASES.map(([id, label, ids]) => {
    const members = stages.filter((stage) => ids.includes(stage.id));
    const status = members.some((stage) => stage.status === 'error') ? 'error'
      : members.some((stage) => stage.status === 'active') ? 'active'
        : members.some((stage) => stage.status === 'degraded') ? 'degraded'
          : members.length === ids.length && members.every((stage) => stage.status === 'complete') ? 'complete'
            : members.some((stage) => stage.status === 'complete') ? 'active' : 'pending';
    const current = members.find((stage) => ['active', 'error', 'degraded'].includes(stage.status));
    return { id, label, status, passed: status === 'complete', detail: current?.detail || current?.label || '' };
  });
}
