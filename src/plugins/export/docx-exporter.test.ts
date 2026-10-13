import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMarkdown } from './docx-exporter.js';
import type { Paper, Section } from '../../types.js';

/** Build one bound reference without invoking the document converter. */
function markdown(paper: Paper, citationStyle?: 'APA' | 'IEEE'): string {
  const section = { nodeId: '1', title: 'Methods', content: 'Evidence [1].',
    citations: [{ paperId: paper.id, marker: '[1]' }] } as Section;
  return buildMarkdown([section], [paper], { title: 'Review', citationStyle });
}

test('complete imported bibliography entries are not formatted twice', () => {
  const citation = 'A. Author, "A study," Journal, 2026. https://doi.org/10.1234/example.';
  const paper = { id: 'canonical-ref-1', title: citation, authors: ['A. Author'],
    year: 2026, abstract: '', url: '', source: 'manual' } as Paper;
  const output = markdown(paper);
  assert.ok(output.includes(`[1] ${citation}\n\n`));
  assert.ok(!output.includes('A. Author. A. Author'));
  assert.ok(!output.includes('example.[J]'));
});

test('ordinary references retain their configured formatting', () => {
  const paper = { id: 'regular', title: 'A study', authors: ['A. Author'],
    year: 2026, abstract: '', url: '', source: 'manual' } as Paper;
  assert.ok(markdown(paper, 'APA').includes('[1] A. Author (2026). A study.'));
});
