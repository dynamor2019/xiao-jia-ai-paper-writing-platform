import type { OutlineNode, PipelineStage, PipelineState } from '../types.js';

const WRITING_PHASES: Array<[PipelineStage, RegExp]> = [
  ['introduction-writing', /introduction|background|related work|literature review|引言|前言|背景|相关工作|文献综述/i],
  ['methods-writing', /method|methodology|materials|data|experimental setup|framework|algorithm|方法|材料|数据|实验设置|模型|算法/i],
  ['results-writing', /results?|findings?|evaluation|performance|结果|发现|评估|性能/i],
  ['discussion-writing', /discussion|implication|limitation|threat|讨论|启示|局限|威胁/i],
  ['manuscript-completion', /.*/],
];

/** Assign leaves by their owning chapter, not accidental words in a subsection title. */
export function writingTasks(nodes: OutlineNode[]): Array<{ node: OutlineNode; stage: PipelineStage }> {
  const tasks: Array<{ node: OutlineNode; stage: PipelineStage }> = [];
  const visit = (node: OutlineNode, owner: PipelineStage): void => {
    if (node.children?.length) node.children.forEach((child) => visit(child, owner));
    else tasks.push({ node, stage: owner });
  };
  for (const root of nodes) {
    const owner = WRITING_PHASES.find(([, pattern]) => pattern.test(root.title))![0];
    visit(root, owner);
  }
  return tasks;
}

/** Rewind only incomplete writing, keeping completed paragraphs and scientific validation intact. */
export function reconcileWritingStages(state: PipelineState): void {
  if (!state.outline || !WRITING_PHASES.some(([stage]) => stage === state.stage)) return;
  const tasks = writingTasks(state.outline.nodes);
  const current = WRITING_PHASES.findIndex(([stage]) => stage === state.stage);
  for (let index = 0; index <= current; index++) {
    const stage = WRITING_PHASES[index][0];
    if (tasks.some((task) => task.stage === stage
      && !state.sections.some((section) => section.nodeId === task.node.id && section.status === 'completed'))) {
      state.stage = stage;
      break;
    }
  }
  const order = new Map(tasks.map((task, index) => [task.node.id, index]));
  state.sections.sort((a, b) => (order.get(a.nodeId) ?? Infinity) - (order.get(b.nodeId) ?? Infinity));
}
