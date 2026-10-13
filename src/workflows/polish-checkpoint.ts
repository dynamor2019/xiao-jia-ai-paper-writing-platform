import { createHash } from 'node:crypto';
import type { Section } from '../types.js';
import { canonicalRevisionIsSafe, renderCanonicalMarkdown } from './canonical-draft.js';
import { auditAcademicStyle, polishIntegrityIssues, type PolishAudit } from '../plugins/writing/academic-style.js';

type SavedSection = Section & { polishCheckpoint?: { sha256: string; outcome: string; audit?: PolishAudit } };
type PolishInput = Pick<Section, 'id' | 'title' | 'content'>;
type PolishOutput = string | { content: string; integrityIssues?: string[] };

/** Persist each cosmetic edit; unsafe edits retain the source for substantive review. */
export async function polishWithCheckpoints(
  sections: Section[],
  polish: (section: PolishInput) => Promise<PolishOutput>,
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
    const output = asset ? original : await polish({ id: section.id, title: section.title, content: original });
    const candidate = typeof output === 'string' ? output : output.content;
    const issues = [...(typeof output === 'string' ? [] : output.integrityIssues ?? []),
      ...polishIntegrityIssues(original, candidate)];
    if (canonical && !canonicalRevisionIsSafe(original, candidate)) issues.push('canonical-evidence');
    const accepted = issues.length === 0;
    section.content = accepted ? candidate : original;
    section.polishCheckpoint = { sha256: hash(section.content),
      outcome: asset ? 'asset-preserved' : accepted ? 'completed' : 'unsafe-cosmetic-edit-rejected',
      audit: { before: auditAcademicStyle(original), after: auditAcademicStyle(section.content), integrityIssues: issues } };
    if (!accepted) console.warn(`[润色保护] ${section.id}: 保留原文，拒绝 ${issues.join(', ')} 改动；继续质量评审`);
    try { save(); } catch (error) {
      section.content = original;
      section.polishCheckpoint = previous;
      throw error;
    }
  }
}
