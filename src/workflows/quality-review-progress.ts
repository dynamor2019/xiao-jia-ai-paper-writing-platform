import { createHash } from 'node:crypto';
import type { PipelineState, Section, ToolResult } from '../types.js';
import type { CrossReviewRound, ScientificReview } from '../plugins/verification/scientific-quality-reviewer.js';
import { renderCanonicalMarkdown } from './canonical-draft.js';

interface RoundProgress { round: number; primary?: ScientificReview; secondary?: ScientificReview; revisionSummary?: string; completed?: boolean }
interface QualityProgress { sourceHash: string; rounds: RoundProgress[] }
type SavedState = PipelineState & { qualityReviewProgress?: QualityProgress };
interface ReviewServices {
  review: (task: 'quality' | 'qualityCrossReview') => Promise<ToolResult<ScientificReview>>;
  revise: (reviews: ScientificReview[], save: (sections: Section[]) => void) => Promise<ToolResult<{ sections: Section[]; summary: string }>>;
  save: () => void;
}

/** Hash manuscript bodies, not bookkeeping attached to sections. */
function manuscriptHash(state: PipelineState): string {
  const source = renderCanonicalMarkdown(state.sections) ?? JSON.stringify(state.sections.map(({ id, title, content }) => ({ id, title, content })));
  return createHash('sha256').update(source).digest('hex');
}

/** Checkpoint reviews before paid revisions and continue the same two-round audit. */
export async function runQualityReviewRounds(state: PipelineState, services: ReviewServices): Promise<CrossReviewRound[]> {
  const saved = state as SavedState;
  if (saved.qualityReviewProgress?.sourceHash !== manuscriptHash(state)) {
    saved.qualityReviewProgress = { sourceHash: manuscriptHash(state), rounds: [] };
  }
  const progress = saved.qualityReviewProgress!;
  for (let round = 1; round <= 2; round++) {
    let current = progress.rounds.find((item) => item.round === round);
    if (!current) { current = { round }; progress.rounds.push(current); }
    if (current.completed) continue;
    for (const [key, task] of [['primary', 'quality'], ['secondary', 'qualityCrossReview']] as const) {
      if (current[key]) continue;
      console.log(`[交叉评审] 第 ${round}/2 轮：${task}`);
      const result = await services.review(task);
      if (!result.success || !result.data) throw new Error(result.error || 'Scientific review returned no result');
      current[key] = result.data;
      services.save();
    }
    const revision = await services.revise([current.primary!, current.secondary!], (sections) => {
      state.sections = sections;
      progress.sourceHash = manuscriptHash(state);
      services.save();
    });
    if (!revision.success || !revision.data) throw new Error(revision.error || 'Scientific revision returned no result');
    state.sections = revision.data.sections;
    current.revisionSummary = revision.data.summary;
    current.completed = true;
    progress.sourceHash = manuscriptHash(state);
    services.save();
  }
  return progress.rounds.map((item) => ({ round: item.round, primary: item.primary!, secondary: item.secondary!, revisionSummary: item.revisionSummary! }));
}
