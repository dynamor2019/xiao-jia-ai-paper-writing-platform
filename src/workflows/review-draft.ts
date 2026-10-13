import type { Section } from '../types.js';

/** Frame a saved manuscript for author inspection without inheriting approval or canonical bindings. */
export function buildAuthorReviewSections(sections: Section[], stage: string): Section[] {
  if (!sections.some((section) => section.content.trim())) {
    throw new Error('A nonempty saved manuscript is required for author review');
  }
  const content = `AUTHOR REVIEW DRAFT - NOT SCIENTIFICALLY APPROVED\n\n`
    + `The pipeline remains at ${stage}. This document is only for author inspection of saved work. `
    + 'Scientific review, final citation validation and submission readiness are not certified. '
    + 'It is not an accepted final manuscript or a submission package. '
    + 'The supplied model contains disclosed assumed inputs and unknown outcomes; no field validation is established. '
    + 'Exporting this copy does not advance the pipeline, clear review findings or authorize submission.';
  const notice: Section = { id: 'author-review-notice', nodeId: 'author-review-notice', title: 'Author Review Status',
    content, citations: [], wordCount: content.split(/\s+/).length, status: 'needs-review' };
  return [notice, ...sections.map((section) => ({ ...section, canonicalSource: undefined }))];
}
