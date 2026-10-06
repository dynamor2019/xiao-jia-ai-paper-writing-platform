import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInitialState } from '../config/dsh.config.js';
import { adoptCanonicalDraft, canonicalRevisionIsSafe, canonicalScope, parseCanonicalSections, renderCanonicalMarkdown, syncCanonicalDraft } from './canonical-draft.js';

const SOURCE = '# Synthetic source\n\n## 1. Introduction\n\n<!-- PARAGRAPH: I01 -->\n\nA supplied candidate has score 2.0000 [1].\n\n## 7. Abstract\n\n<!-- PARAGRAPH: A01 -->\n\nA transparent finite demonstration.\n\n<!-- NEXT_PARAGRAPH: QUALITY_REVIEW -->\n\n## Tables and Figures\n\n### Table 1. Scores\n\n| Score |\n|---|\n| 2.0000 |\n\n## References\n\n[1] Author, "Example", 2026. https://doi.org/10.1234/example.\n';
const sha = (content: string) => createHash('sha256').update(content).digest('hex');

test('current review scope excludes stale workflow status and rejects changed visual evidence', () => {
  const { root, state } = fixture();
  try {
    adoptCanonicalDraft(root, state);
    writeFileSync(join(root, 'milestones', 'writing-scope-amendment.md'), 'Synthetic limits remain.\n## Current draft delivery and concentrated author facts\nOld image reads failed; visual readiness BLOCKED.\n');
    writeFileSync(join(root, 'image.png'), 'reviewed image');
    writeFileSync(join(root, 'milestones', 'supervisor-visual-review.md'), `File: image.png\nSHA256: ${sha('reviewed image')}\nScoped PNG inspection.\n`);
    assert.match(canonicalScope(root, state.sections)!, /Synthetic limits remain/);
    assert.doesNotMatch(canonicalScope(root, state.sections)!, /Old image reads failed/);
    assert.match(canonicalScope(root, state.sections)!, /hash-matched supervisor visual evidence/);
    writeFileSync(join(root, 'image.png'), 'changed');
    assert.match(canonicalScope(root, state.sections)!, /stale or unverifiable/);
    assert.doesNotMatch(canonicalScope(root, state.sections)!, /Scoped PNG inspection/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Build a fully source-bound fixture, with no model or network request. */
function fixture(source = SOURCE) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-canonical-'));
  mkdirSync(join(root, '.dsh-state'));
  mkdirSync(join(root, 'milestones', 'reproducibility'), { recursive: true });
  const path = join(root, '.dsh-state', 'manuscript.md');
  writeFileSync(path, source);
  const result = join(root, 'result.json');
  writeFileSync(result, '{}');
  writeFileSync(join(root, 'milestones', 'reproducibility', 'manuscript-consistency.json'), JSON.stringify({
    status: 'PASS_SCOPED_SOURCE_CONSISTENCY', manuscriptSha256: sha(source), resultSha256: sha('{}'),
    checks: [{ status: 'PASS' }], submissionReady: false,
  }));
  const state = createInitialState('Old field topic');
  state.stage = 'introduction-writing';
  state.metadata.resultsFile = result;
  return { root, path, state };
}

test('adoption imports complete prose and bibliography without changing the checkpoint stage', () => {
  const { root, path, state } = fixture();
  try {
    assert.equal(adoptCanonicalDraft(root, state), true);
    assert.equal(state.stage, 'introduction-writing');
    assert.equal(state.topic, 'Synthetic source');
    assert.equal(state.sections.length, 3);
    assert.ok(state.sections.every((section) => section.status === 'completed'));
    assert.equal(state.sections[0].citations[0].paperId, 'canonical-ref-1');
    assert.equal(state.papers[0].url, 'https://doi.org/10.1234/example');
    assert.equal(readFileSync(path, 'utf8'), SOURCE);
    assert.equal(adoptCanonicalDraft(root, state), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stale source audits refuse old-outline drafting instead of silently ignoring a manuscript', () => {
  const { root, path, state } = fixture();
  try {
    writeFileSync(path, SOURCE + '\nChanged.\n');
    assert.throws(() => adoptCanonicalDraft(root, state), /stale or failed/);
    assert.equal(state.topic, 'Old field topic');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unchanged manuscript cannot silently resume against replacement experiment results', () => {
  const { root, path, state } = fixture();
  try {
    adoptCanonicalDraft(root, state);
    writeFileSync(state.metadata.resultsFile!, '{"changed":true}');
    assert.throws(() => adoptCanonicalDraft(root, state), /different experiment/);
    assert.equal(readFileSync(path, 'utf8'), SOURCE);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('partial drafts and pre-data-validation checkpoints are not promoted', () => {
  const { root, state } = fixture(SOURCE.replace('QUALITY_REVIEW', 'I02'));
  try {
    assert.equal(adoptCanonicalDraft(root, state), false);
    state.stage = 'experiment-execution';
    assert.equal(adoptCanonicalDraft(root, state), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prose edits write through with comments, CRLF, tables and references retained', () => {
  const crlf = SOURCE.replace(/\n/g, '\r\n');
  const { root, path, state } = fixture(crlf);
  try {
    adoptCanonicalDraft(root, state);
    state.sections[0].content = state.sections[0].content.replace('supplied', 'declared');
    syncCanonicalDraft(state.sections);
    const expected = crlf.replace('supplied', 'declared');
    assert.equal(readFileSync(path, 'utf8'), expected);
    syncCanonicalDraft(state.sections);
    const exported = renderCanonicalMarkdown(state.sections)!;
    assert.equal(exported, expected.replace(/<!--[\s\S]*?-->/g, ''));
    assert.equal((exported.match(/## References/g) || []).length, 1);
    assert.ok(!exported.includes('NEXT_PARAGRAPH'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('altered numbers, lost paragraphs and concurrent source edits are refused without overwrite', () => {
  const { root, path, state } = fixture();
  try {
    adoptCanonicalDraft(root, state);
    state.sections[0].content = state.sections[0].content.replace('2.0000', '1.0000');
    assert.throws(() => syncCanonicalDraft(state.sections), /protected/);
    assert.equal(readFileSync(path, 'utf8'), SOURCE);
    state.sections[0].content = state.sections[0].content.replace('1.0000', '2.0000');
    writeFileSync(path, SOURCE + '\nExternal edit.\n');
    assert.throws(() => syncCanonicalDraft(state.sections), /externally/);
    state.sections.pop();
    assert.throws(() => renderCanonicalMarkdown(state.sections), /added or dropped/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate paragraph markers cannot silently alias source spans', () => {
  assert.throws(() => parseCanonicalSections(SOURCE.replace('A01', 'I01')), /Duplicate/);
});

test('citation sentence reordering preserves identities without allowing dropped references or changed data', () => {
  assert.equal(canonicalRevisionIsSafe('Claim A [2]. Claim B [1]. Claim C [1]. Value 2.0.',
    'Claim B [1]. Claim C [1]. Claim A [2]. Value 2.0.'), true);
  assert.equal(canonicalRevisionIsSafe('Claim [1]. Claim [2]. Value 2.0.', 'Claim [1]. Value 2.0.'), false);
  assert.equal(canonicalRevisionIsSafe('Claim [1]. Value 2.0.', 'Claim [1]. Value 1.0.'), false);
});

test('resume refreshes primary evidence without redrafting or changing stages', () => {
  const { root, state } = fixture();
  try {
    adoptCanonicalDraft(root, state);
    state.stage = 'citation-verification';
    const cache = join(root, '.dsh-state', 'literature-cache', 'core-routing');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'example.txt'), 'Title\nSupported claim\nRelevant constraint\n');
    writeFileSync(join(root, 'milestones', 'citation-audit.md'), 'example.txt:2–3');
    assert.equal(adoptCanonicalDraft(root, state), false);
    assert.equal(state.stage, 'citation-verification');
    assert.match(state.papers[0].abstract, /Supported claim\nRelevant constraint/);
    assert.equal(state.sections[0].content, 'A supplied candidate has score 2.0000 [1].');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
