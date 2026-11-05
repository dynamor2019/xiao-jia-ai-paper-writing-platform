import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asReviewSections, currentCitationEvidence } from './validate-paper.js';

test('scientific review receives title, authors and the full final section', () => {
  const source = '# Current title\n\nAuthor Example\nauthor@example.org\n\n## Abstract\nAbstract text.\n\n## References\nFinal reference.';
  const sections = asReviewSections(source);
  assert.match(sections[0].content, /Author Example/);
  assert.match(sections[0].content, /author@example.org/);
  assert.equal(sections[1].title, 'Abstract');
  assert.equal(sections.at(-1)?.content, 'Final reference.');
});

test('a manuscript without subsections remains intact', () => {
  assert.equal(asReviewSections('# Title\nFull text')[0].content, '# Title\nFull text');
});

test('scientific review receives exact-version source passages but not a copied approval verdict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-citation-evidence-'));
  try {
    await mkdir(join(directory, '.dsh-state', 'citation-support'), { recursive: true });
    await writeFile(join(directory, '.dsh-state', 'citation-support', 'current.json'), JSON.stringify({
      sha256: 'current', status: 'clear', results: [{ status: 'verified', citation: { marker: '[1]' },
        paper: { id: 'source', title: 'Source title', abstract: 'Actual source passage' } }],
    }));
    await assert.rejects(currentCitationEvidence(join(directory, 'manuscript.md'), 'changed'), /CITATION_AUDIT_STALE/);
    const evidence = await currentCitationEvidence(join(directory, 'manuscript.md'), 'current');
    assert.match(evidence, /Actual source passage/);
    assert.ok(!evidence.includes('"status":"clear"'));
    assert.ok(!evidence.includes('"status":"verified"'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
