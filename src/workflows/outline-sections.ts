import type { Outline, OutlineNode, Section } from '../types.js';
import { renderCanonicalMarkdown } from './canonical-draft.js';

/** Restore saved outline headings for rendering only, without rewriting or checkpointing prose. */
export function outlineSections(sections: Section[], outline?: Outline): Section[] {
  if (!outline || renderCanonicalMarkdown(sections) !== undefined) return sections;
  const byNode = new Map(sections.map((section) => [section.nodeId, section]));
  const included = new Set<Section>();
  const visit = (node: OutlineNode): Section[] => {
    const section = byNode.get(node.id);
    const children = (node.children || []).flatMap(visit);
    if (section) {
      included.add(section);
      return [section, ...children];
    }
    if (!children.length) return [];
    return [{ id: `outline-heading:${node.id}`, nodeId: node.id, title: node.title,
      content: '', wordCount: 0, status: 'completed', citations: [] }, ...children];
  };
  const planned = outline.nodes.flatMap(visit);
  return [...planned, ...sections.filter((section) => !included.has(section))];
}
