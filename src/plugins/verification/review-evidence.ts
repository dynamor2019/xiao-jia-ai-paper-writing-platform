import type { ScientificReview } from './scientific-quality-reviewer.js';
import { assert_consistent_review } from './review-consistency.js';
import { submissionOnly } from './scientific-quality-reviewer.js';

/** Preserve meaning while tolerating whitespace differences in exact quotations. */
function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Reject an ungrounded reviewer response, never downgrade a scientific defect. */
export function validateReviewEvidence(review: ScientificReview, manuscript: string, evidence: string): void {
  if (review.verdict === 'revise' && review.findings.length === 0) {
    throw new Error('REVIEW_EVIDENCE_INVALID: revise verdict without findings');
  }
  assert_consistent_review(review.findings);
  for (const finding of review.findings) {
    if (!['manuscript', 'submission'].includes(finding.blockingStage || '')) {
      throw new Error('REVIEW_EVIDENCE_INVALID: missing finding classification');
    }
    if (finding.blockingStage === 'submission') {
      if (!submissionOnly(finding)) throw new Error('REVIEW_EVIDENCE_INVALID: scientific defect classified as submission-only');
      continue;
    }
    if (!['critical', 'major'].includes(finding.severity)) continue;
    if (!finding.claimQuote?.trim() || !normalized(manuscript).includes(normalized(finding.claimQuote))) {
      throw new Error('REVIEW_EVIDENCE_INVALID: blocking claim quote is absent from manuscript');
    }
    if (finding.evidenceSource === 'missing') {
      if (!finding.requiredEvidence?.trim() || finding.evidenceQuote !== '') {
        throw new Error('REVIEW_EVIDENCE_INVALID: missing evidence requires a specific obligation');
      }
      continue;
    }
    const source = finding.evidenceSource === 'manuscript' ? manuscript
      : finding.evidenceSource === 'validated-evidence' ? evidence : '';
    if (!finding.evidenceQuote?.trim() || !normalized(source).includes(normalized(finding.evidenceQuote))) {
      throw new Error('REVIEW_EVIDENCE_INVALID: blocking evidence quote is absent from its source');
    }
  }
}
