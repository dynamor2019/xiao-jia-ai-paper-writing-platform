import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeReview } from './reviewer-response-store.mjs';

/** Isolate all test writes from real papers. */
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'manuscript.md'), '# Methods\nWe evaluated 27 candidates. Failed cases remain reported.\n');
  writeFileSync(join(root, 'results.json'), '{"candidates":27,"failed":241}');
  return root;
}

/** Prepare an approved real-text reply using the same author operations as the UI. */
export function approvedFixture(t) {
  const root = fixture(t);
  let state = changeReview(root, { action: 'import', revision: 0, source: '1. Report candidate count.', reviewer: 'R1' });
  state = changeReview(root, { action: 'manuscript', revision: state.revision, manuscript: 'manuscript.md' });
  state = changeReview(root, { action: 'edit', revision: state.revision, id: 'R1.1', patch: {
    response: 'We report the 27 evaluated candidates in Methods.', location: 'Section 2, paragraph 1',
    evidence: [{ file: 'manuscript.md', quote: 'We evaluated 27 candidates.' }],
  } });
  state = changeReview(root, { action: 'approve', revision: state.revision, id: 'R1.1', confirmed: true }, { author: true });
  return { root, state };
}
