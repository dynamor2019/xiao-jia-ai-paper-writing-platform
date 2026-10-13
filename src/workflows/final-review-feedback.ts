import type { PipelineState, Section, ToolResult } from '../types.js';
import type { ScientificReview } from '../plugins/verification/scientific-quality-reviewer.js';
import { manuscriptReviewBlocked, manuscriptRevisionReview } from '../plugins/verification/scientific-quality-reviewer.js';

interface FeedbackProgress { review: ScientificReview; completed: boolean; contextHash?: string }
type FeedbackState = PipelineState & { finalReviewFeedback?: FeedbackProgress };
interface FeedbackServices {
  contextHash?: string;
  review: () => Promise<ToolResult<ScientificReview>>;
  revise: (review: ScientificReview, save: (sections: Section[]) => void) => Promise<ToolResult<{ sections: Section[]; summary: string }>>;
  save: () => void;
}

/** Final feedback is already downstream of completed cross-review rounds in this context. */
export function finalReviewFeedbackStarted(state: PipelineState, contextHash: string): boolean {
  return (state as FeedbackState).finalReviewFeedback?.contextHash === contextHash;
}

/** Feed the final audit back once; checkpoint partial revisions, never turn failure into approval. */
export async function runFinalReviewFeedback(state: PipelineState, services: FeedbackServices): Promise<ToolResult<ScientificReview>> {
  const saved = state as FeedbackState;
  if (!saved.finalReviewFeedback || saved.finalReviewFeedback.contextHash !== services.contextHash) {
    const result = await services.review();
    if (!result.success || !result.data) return result;
    if (!manuscriptReviewBlocked(result.data)) return result;
    if (!manuscriptRevisionReview(result.data).findings.length) return result;
    saved.finalReviewFeedback = { review: result.data, completed: false, contextHash: services.contextHash };
    services.save();
  }
  const progress = saved.finalReviewFeedback;
  if (!progress.completed) {
    const revision = await services.revise(manuscriptRevisionReview(progress.review), (sections) => {
      state.sections = sections;
      services.save();
    });
    if (!revision.success || !revision.data) return { success: false, error: revision.error || 'Final-review revision failed' };
    state.sections = revision.data.sections;
    progress.completed = true;
    services.save();
  }
  return services.review();
}
