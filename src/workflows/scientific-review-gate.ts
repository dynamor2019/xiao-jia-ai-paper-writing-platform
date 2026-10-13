import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Section } from '../types.js';
import { renderCanonicalMarkdown } from './canonical-draft.js';
import { validateReviewEvidence } from '../plugins/verification/review-evidence.js';
import { manuscriptReviewBlocked, reviewScientificQuality, type ScientificReviewResult } from '../plugins/verification/scientific-quality-reviewer.js';

type ReviewTask = 'quality' | 'qualityCrossReview';
type ReviewService = typeof reviewScientificQuality;

/** Check the returned verdict against the actual immutable review inputs. */
function checked(result: ScientificReviewResult, manuscript: string, evidence: string): ScientificReviewResult {
  if (!result.success || !result.data) return result;
  try {
    validateReviewEvidence(result.data, manuscript, evidence);
    return result;
  } catch (error) {
    return { success: false, failureKind: 'review-response', data: result.data,
      error: error instanceof Error ? error.message : String(error) };
  }
}

/** Use at most one existing independent review route; preserve every original response. */
export async function reviewWithAdjudication(
  sections: Section[], evidence: string, task: ReviewTask = 'quality', cacheDir?: string,
  review: ReviewService = reviewScientificQuality,
): Promise<ScientificReviewResult> {
  const manuscript = renderCanonicalMarkdown(sections)
    ?? sections.map(section => `## ${section.title}\n\n${section.content}`).join('\n\n');
  const original = await review(sections, evidence, task, cacheDir);
  const primary = checked(original, manuscript, evidence);
  if (!primary.success && primary.failureKind !== 'review-response') return primary;
  if (primary.success && primary.data && !manuscriptReviewBlocked(primary.data)) return primary;
  const instructions = `${evidence}\n\nBOUNDED REVIEW ADJUDICATION (not manuscript or experimental evidence):\n${JSON.stringify({ review: original.data, responseError: primary.error })}\nIndependently audit the complete manuscript and supplied evidence. Assess the preceding concerns, retaining any demonstrated unresolved scientific defect. Establish whether each alleged difference actually exists before inheriting its severity. An acknowledged code/prose match is not a contradiction; accurate negation of an unused rule, correct-table emphasis and repeated correct explanations are editorial suggestions. Do not inherit an unsupported accusation or treat reviewer prose as machine evidence. Copy quote fields from the original input only, never from the preceding opinion, with no ellipses or bracketed descriptions. Do not change manuscript or results, demand ideal outcomes, waive integrity, or certify submission permission. Return your own grounded review, not a vote or an automatic pass. If the preceding response was invalid, that is a reviewer error, not proof the manuscript is valid.`;
  const otherTask = task === 'quality' ? 'qualityCrossReview' : 'quality';
  const secondary = checked(await review(sections, instructions, otherTask, cacheDir), manuscript, evidence);
  if (cacheDir) {
    mkdirSync(cacheDir, { recursive: true });
    const key = createHash('sha256').update(JSON.stringify({ manuscript, evidence, task, policy: 1 })).digest('hex');
    writeFileSync(join(cacheDir, `adjudication-${key}.json`), JSON.stringify({
      policy: 1, primary: original, primaryValidation: primary.error,
      adjudication: secondary, scientificApproval: secondary.success && secondary.data
        ? !manuscriptReviewBlocked(secondary.data) : false, submissionApproved: false,
    }, null, 2) + '\n', 'utf8');
  }
  return secondary;
}
