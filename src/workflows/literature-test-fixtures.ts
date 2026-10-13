import type { Paper, Section } from '../types.js';

/** Create synthetic metadata for isolated tests, never production manuscript evidence. */
export function researchFixture(count = 15) {
  const papers: Paper[] = Array.from({ length: count }, (_, index) => ({ id: `p${index}`, title: `Research ${index}`,
    authors: ['Author'], year: new Date().getFullYear(), abstract: 'A primary abstract.', source: 'manual',
    url: `https://doi.org/10.1000/p${index}`, tags: ['publication:journal-article', 'metadata:crossref'] }));
  const section: Section = { id: '2.1', nodeId: '2.1', title: 'Literature review', status: 'completed', wordCount: 50,
    content: papers.map((_, index) => `[${index + 1}]`).join(' '),
    citations: papers.map((paper, index) => ({ paperId: paper.id, marker: `[${index + 1}]`, rawText: 'Context', verified: true })) };
  return { papers, sections: [section] };
}
