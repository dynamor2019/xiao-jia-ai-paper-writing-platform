import assert from 'node:assert/strict';
import test from 'node:test';
import type { Outline, Section } from '../types.js';
import { outlineSections } from './outline-sections.js';
import { buildMarkdown } from '../plugins/export/docx-exporter.js';

test('render restores parent headings while preserving exact source prose and orphan sections', () => {
  const section = { id: '3.1', nodeId: '3.1', title: 'Source data', content: 'Unchanged result 1.5.',
    wordCount: 3, citations: [], status: 'completed' } as Section;
  const orphan = { ...section, id: 'appendix', nodeId: 'appendix', title: 'Appendix' };
  const outline = { nodes: [{ id: '3', title: 'Methods', children: [{ id: '3.1', title: 'Source data' }] }] } as Outline;
  const rendered = outlineSections([section, orphan], outline);
  assert.deepEqual(rendered.map((item) => item.title), ['Methods', 'Source data', 'Appendix']);
  assert.equal(rendered[1], section);
  assert.equal(rendered[2], orphan);
  assert.equal(section.content, 'Unchanged result 1.5.');
  assert.match(buildMarkdown(rendered, [], { title: 'Paper' }), /## Methods\n\n[\s\S]*### Source data/);
});

test('absent outline does not create or change sections', () => {
  const sections: Section[] = [];
  assert.equal(outlineSections(sections), sections);
});
