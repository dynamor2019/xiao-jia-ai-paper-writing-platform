import { createHash } from 'node:crypto';
import type { Section } from '../types.js';
import { canonicalRevisionIsSafe, renderCanonicalMarkdown } from './canonical-draft.js';

type SavedSection = Section & { polishCheckpoint?: { sha256: string; outcome: string } };
type PolishInput = Pick<Section, 'id' | 'title' | 'content'>;

/** Persist each cosmetic edit; unsafe edits retain the source for substantive review. */
export async function polishWithCheckpoints(
  sections: Section[],
  polish: (section: PolishInput) => Promise<string>,
  save: () => void,
): Promise<void> {
  const canonical = renderCanonicalMarkdown(sections) !== undefined;
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  for (const item of sections) {
    const section = item as SavedSection;
    if (section.polishCheckpoint?.sha256 === hash(section.content)) continue;
    const original = section.content;
    const previous = section.polishCheckpoint;
    const asset = canonical && section.id.startsWith('asset-');
    const candidate = asset ? original : await polish({ id: section.id, title: section.title, content: original });
    const accepted = Boolean(candidate.trim()) && (!canonical || canonicalRevisionIsSafe(original, candidate));
    section.content = accepted ? candidate : original;
    section.polishCheckpoint = { sha256: hash(section.content),
      outcome: asset ? 'asset-preserved' : accepted ? 'completed' : 'unsafe-cosmetic-edit-rejected' };
    if (!accepted) console.warn(`[润色保护] ${section.id}: 保留原文，拒绝公式/数字/引用改动；继续质量评审`);
    try { save(); } catch (error) {
      section.content = original;
      section.polishCheckpoint = previous;
      throw error;
    }
  }
}
