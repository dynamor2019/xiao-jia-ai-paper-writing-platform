interface ReviewFinding {
  severity: string;
  issue: string;
  requiredAction: string;
  section: string;
}

/** Distinguish an invalid reviewer response from a demonstrated manuscript defect. */
export class ReviewConsistencyError extends Error {
  readonly code = 'REVIEW_SELF_CONTRADICTION';

  constructor(section: string) {
    super(`REVIEW_SELF_CONTRADICTION: reviewer labels an acknowledged non-defect as blocking in ${section}; a consistent independent verdict is required, not automatic approval`);
    this.name = 'ReviewConsistencyError';
  }
}

/** Exclude quoted manuscript assertions before checking the reviewer's own statements. */
function reviewer_statements(finding: ReviewFinding): string {
  return [finding.issue, finding.requiredAction].map(text =>
    text.replace(/"[^"\n]*"|“[^”\n]*”/g, '')).join('\n');
}

/** Reject the entire ambiguous review; never remove findings or manufacture a PASS. */
export function assert_consistent_review(findings: ReviewFinding[]): void {
  const acknowledged_non_defect = /\bno\s+(?:numerical\s+)?contradiction\s+exists\b|\b(?:the\s+)?code\s+and\s+(?:the\s+)?prose\s+already\s+match\b/i;
  for (const finding of findings) {
    if (!['critical', 'major'].includes(finding.severity)) continue;
    if (acknowledged_non_defect.test(reviewer_statements(finding))) {
      throw new ReviewConsistencyError(finding.section);
    }
  }
}
