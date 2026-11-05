/** Consolidate retained authoritative disclosures without generating new author assertions. */
export function consolidateDeliveredDeclarations(markdown: string): string {
  const headings = [...markdown.matchAll(/^(#{2,3}) (.+)\r?$/gm)];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const endOf = (index: number): number => headings[index + 1]?.index ?? markdown.length;
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  for (const [sourceTitle, targetTitle] of [
    ['Declaration of AI-assisted preparation', 'Use of generative AI'],
    ['Data and code availability', 'Data availability'],
  ]) {
    const source = headings.findIndex(heading => heading[1] === '##' && heading[2].trim() === sourceTitle);
    const target = headings.findIndex(heading => heading[1] === '###' && heading[2].trim() === targetTitle);
    if (source < 0 || target < 0) continue;
    if (headings.filter(heading => heading[2].trim() === sourceTitle).length !== 1
      || headings.filter(heading => heading[2].trim() === targetTitle).length !== 1) throw new Error('Ambiguous declaration headings');
    const body = markdown.slice(headings[source].index! + headings[source][0].length, endOf(source)).trim();
    if (!body) throw new Error('Cannot replace a declaration with an empty authoritative disclosure');
    edits.push({ start: headings[source].index!, end: endOf(source), text: '' },
      { start: headings[target].index!, end: endOf(target), text: `### ${targetTitle}${eol}${eol}${body}${eol}${eol}` });
  }
  const draft = headings.findIndex(heading => heading[2].trim() === 'Draft highlights');
  if (draft >= 0 && headings.some(heading => heading[2].trim() === 'Highlights')) {
    edits.push({ start: headings[draft].index!, end: endOf(draft), text: '' });
  }
  return edits.sort((a, b) => b.start - a.start).reduce((text, edit) =>
    text.slice(0, edit.start) + edit.text + text.slice(edit.end), markdown);
}
