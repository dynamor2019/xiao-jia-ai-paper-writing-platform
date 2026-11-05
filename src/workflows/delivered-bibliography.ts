import type { Paper } from '../types.js';
import { extractCitations } from '../plugins/writing/section-writer.js';

/** Remove only uncited entries after every detected citation has a bound source identity. */
export function pruneDeliveredBibliography(markdown: string, papers: Paper[]): string {
  const heading = /^## References\r?$/m.exec(markdown);
  if (!heading || heading.index === undefined) throw new Error('Missing bibliography heading');
  const body = markdown.slice(0, heading.index);
  const citations = extractCitations(body, papers);
  if (!citations.length || citations.some(citation => citation.paperId.startsWith('missing-reference-'))) {
    throw new Error('Cannot prune bibliography with unbound citations');
  }
  const used = new Set(citations.map(citation => citation.paperId));
  const labels = papers.filter(paper => used.has(paper.id)).map(paper =>
    (paper as Paper & { citationLabel?: string }).citationLabel?.slice(1, -1));
  const entries = markdown.slice(heading.index + heading[0].length).trim().split(/\r?\n\s*\r?\n/);
  const retained = entries.filter(entry => labels.some(label => {
    if (!label) return false;
    const author = label.split(/ et al\.| and |,/)[0].trim();
    const year = label.match(/(?:19|20)\d{2}/)?.[0];
    return (entry.startsWith(`${author},`) || entry.startsWith(`${author} (`)) && entry.match(/\((\d{4})\)/)?.[1] === year;
  }));
  if (!retained.length) throw new Error('No safely bound bibliography entries remain');
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  return markdown.slice(0, heading.index + heading[0].length) + eol + eol + retained.join(eol + eol) + eol;
}
