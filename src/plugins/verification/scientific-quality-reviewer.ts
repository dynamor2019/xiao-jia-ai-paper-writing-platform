import { getModelClient } from '../../lib/model-client.js';
import { createHash } from 'node:crypto';
import type { TaskType } from '../../config/model-routing.js';
import type { Section, ToolResult } from '../../types.js';
import { canonicalRevisionIsSafe, renderCanonicalMarkdown } from '../../workflows/canonical-draft.js';

export interface ScientificReviewFinding {
  category: 'theory' | 'methods' | 'experiments' | 'presentation' | 'reproducibility' | 'consistency' | 'references';
  severity: 'critical' | 'major' | 'minor';
  section: string;
  issue: string;
  requiredAction: string;
}

export interface ScientificReview {
  verdict: 'pass' | 'revise';
  findings: ScientificReviewFinding[];
}

export interface CrossReviewRound {
  round: number;
  primary: ScientificReview;
  secondary: ScientificReview;
  revisionSummary: string;
}

const SYSTEM_PROMPT = `You are an independent senior reviewer performing a submission-blocking audit of a scientific paper.
Check mathematical definitions and derivations, theorem assumptions and proofs, method-result consistency, experimental validity, missing controls or ablations, tables/figures, and reproducibility.
Explicitly treat as critical: synthetic or reconstructed observations presented as real experiments; statistics or significance not traceable to machine outputs; hidden negative/null/failed results; causal language based only on correlation or regression; and contradictions among plotted values, captions, Results, Abstract, and Conclusion.
Treat figure/table numbering disorder, misleading chart types, dual-axis ambiguity, inaccessible colors, and conclusions embedded as artwork titles as major presentation defects.
For column-generation papers, block submission unless reduced-cost pricing is theoretically standard or explicitly justified: identify the commodity assignment dual, check whether all commodities are priced, and verify that lower-bound, LP-optimum, or pool-optimal claims follow from the implemented algorithm.
For BIM/IFC/MEP routing papers, block submission if engineering realism is unsupported: synthetic capacities, random terminals, inferred connectivity, or routing bands require a real or quasi-real engineering anchor and explicit semantic limits.
For target-journal positioning, block submission when recent SOTA or strong baselines are missing, especially commercial solvers/software, recent graph-based routing/path-planning/clash-coordination work, and directly relevant Automation in Construction papers.
For references, block citation-position errors: the cited paper must support the sentence where it appears; bibliography padding and DOI-only existence are not sufficient.
For reproducibility, block unsupported "preregistered", "all data/code provided", or repository-upon-acceptance claims.
For causal or econometric papers, treat as critical: unnamed or outdated identification strategy (staggered TWFE, IV without first-stage F, RD with high-order polynomials), missing assumption or pre-trend tests, and coefficients reported only by sign and significance with no economic magnitude.
Never estimate acceptance probability, predict editor decisions, or reassure with scores.
Do not praise, rewrite prose, or invent missing evidence. Return strict JSON only with this schema:
{"verdict":"pass|revise","findings":[{"category":"theory|methods|experiments|presentation|reproducibility|consistency|references","severity":"critical|major|minor","section":"...","issue":"...","requiredAction":"..."}]}
Use critical or major for any issue that a competent external reviewer could use to reject or require major revision.`;

/** Use an independent model pass to catch semantic defects deterministic checks cannot prove. */
export async function reviewScientificQuality(
  sections: Section[],
  journalInstructions: string,
  task: TaskType = 'quality'
): Promise<ToolResult<ScientificReview>> {
  try {
    const response = await getModelClient().generate(
      `${SYSTEM_PROMPT}\nKeep the JSON compact: at most five highest-priority actionable findings, under 700 words. Do not certify source verification or visual inspection you did not perform.`,
      `Target journal constraints:\n${journalInstructions || 'General scientific journal'}\n\nManuscript:\n${buildReviewManuscript(sections)}`,
      { task, temperature: 0, maxTokens: 5000, timeoutMs: 120000, maxAttempts: 1, minOutputChars: 20 }
    );
    return { success: true, data: parseReview(response) };
  } catch (error) {
    return { success: false, error: `独立科技审查失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function reviseSectionsFromReviews(
  sections: Section[],
  reviews: ScientificReview[],
  journalInstructions: string,
  saveProgress?: (sections: Section[]) => void
): Promise<ToolResult<{ sections: Section[]; summary: string }>> {
  try {
    if (reviews.every((review) => review.findings.length === 0)) {
      return { success: true, data: { sections, summary: 'Reviewers requested no changes.' } };
    }
    const reviewHash = digest(JSON.stringify({ reviews, journalInstructions }));
    const plan = await revisionPlan(sections, reviews, journalInstructions, reviewHash);
    saveProgress?.(sections);
    const revised = [...sections];
    const unresolved: string[] = [];
    const canonical = renderCanonicalMarkdown(sections) !== undefined;
    for (const id of plan.ids) {
      const index = revised.findIndex((section) => section.id === id);
      const section = revised[index] as RevisionSection;
      if (section.reviewRevision?.reviewHash === reviewHash && section.reviewRevision.contentHash === digest(section.content)) continue;
      const cached = section.reviewRevisionRejected;
      const canReuse = cached?.reviewHash === reviewHash && cached.originalHash === digest(section.content)
        && canonicalRevisionIsSafe(section.content, cached.content);
      if (canonical && cached?.reviewHash === reviewHash && cached.originalHash === digest(section.content) && !canReuse) {
        unresolved.push(id);
        console.warn(`[评审保护] ${id}: 保留原文，未解决意见留给最终科学审查`);
        continue;
      }
      const content = canReuse ? cached!.content : await reviseSingleSection(section, revised, reviews, journalInstructions, () => saveProgress?.(revised));
      if (canonical && !canonicalRevisionIsSafe(section.content, content)) {
        section.reviewRevisionRejected = { reviewHash, originalHash: digest(section.content), content };
        saveProgress?.(revised);
        unresolved.push(id);
        console.warn(`[评审保护] ${id}: 拒绝保护内容改动，保留原文；意见未解决`);
        continue;
      }
      revised[index] = { ...section, content, citations: rebindSectionCitations(section, content),
        reviewRevisionRejected: undefined, wordCount: countWords(content), status: 'completed',
        reviewRevision: { reviewHash, contentHash: digest(content) } } as RevisionSection;
      saveProgress?.(revised);
      console.log(`[评审改稿] ${id} 已保存`);
    }
    const summary = [plan.summary, unresolved.length
      ? `UNRESOLVED: unsafe revisions were refused for ${unresolved.join(', ')}; original prose retained. These findings require final scientific assessment, not a claim of repair.` : ''].filter(Boolean).join('\n');
    return { success: true, data: { sections: revised, summary } };
  } catch (error) {
    return { success: false, error: `评审意见改稿失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function formatScientificReview(review: ScientificReview): string {
  const lines = ['# Independent Scientific Quality Review', '', `Verdict: ${review.verdict.toUpperCase()}`, ''];
  if (review.findings.length === 0) lines.push('- No blocking findings.');
  for (const finding of review.findings) {
    lines.push(`- [${finding.severity.toUpperCase()}] ${finding.category} / ${finding.section}: ${finding.issue}`);
    lines.push(`  Required action: ${finding.requiredAction}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatCrossReviewRounds(rounds: CrossReviewRound[]): string {
  const lines = ['# Cross-Model Reviewer Revision Report', ''];
  for (const round of rounds) {
    lines.push(`## Round ${round.round}`);
    lines.push('');
    lines.push('### Primary Reviewer');
    lines.push(formatScientificReview(round.primary).trim());
    lines.push('');
    lines.push('### Secondary Reviewer');
    lines.push(formatScientificReview(round.secondary).trim());
    lines.push('');
    lines.push('### Writing Model Revision');
    lines.push(round.revisionSummary || 'No revision summary returned.');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function buildReviewManuscript(sections: Section[]): string {
  const canonical = renderCanonicalMarkdown(sections);
  if (canonical) return canonical;
  let remaining = 42000;
  const chunks: string[] = [];
  for (const section of sections) {
    if (remaining <= 0) break;
    const content = section.content.slice(0, Math.min(7000, remaining));
    chunks.push(`## ${section.title}\n\n${content}`);
    remaining -= content.length;
  }
  return chunks.join('\n\n');
}

interface RevisionPlan { reviewHash: string; ids: string[]; summary: string }
type RevisionSection = Section & {
  reviewRevisionPlan?: RevisionPlan;
  reviewRevision?: { reviewHash: string; contentHash: string };
  reviewRevisionRejected?: { reviewHash: string; originalHash: string; content: string };
  reviewRevisionResponse?: { reviewHash: string; originalHash: string; raw: string };
};

/** Bind saved work to the exact review instructions and content. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Rebind existing source identities to each literal marker in the revised paragraph. */
function rebindSectionCitations(section: Section, content: string): Section['citations'] {
  const known = new Map(section.citations.map((citation) => [citation.marker, citation]));
  return [...content.matchAll(/\[(\d+)\]/g)].map((match) => {
    const citation = known.get(match[0]);
    if (!citation) throw new Error(`Unbound citation ${match[0]} in revision of ${section.id}`);
    return { ...citation, rawText: content, verified: false };
  });
}

/** Plan minimal affected paragraphs before requesting any replacement prose. */
async function revisionPlan(sections: Section[], reviews: ScientificReview[], instructions: string, reviewHash: string): Promise<RevisionPlan> {
  const first = sections[0] as RevisionSection | undefined;
  if (!first) throw new Error('Cannot revise an empty manuscript');
  if (first.reviewRevisionPlan?.reviewHash === reviewHash) return first.reviewRevisionPlan;
  const response = await getModelClient().generate(
    'Plan targeted scientific revisions. Return only JSON {"summary":"...","ids":["existing-section-id"]}. Select only paragraphs directly needing changes for these findings, not unchanged paragraphs. Do not request new experiments or invent evidence. An unaddressable finding must remain explicitly unresolved in the summary; never claim it fixed. Do not return replacement prose.',
    `Constraints:\n${instructions}\n\nFindings:\n${formatReviewBundle(reviews)}\n\nSections:\n${sections.map((section) => `id=${section.id} title=${section.title}\n${section.content}`).join('\n\n')}`,
    { task: 'writing', temperature: 0, maxTokens: 1500, timeoutMs: 120000, maxAttempts: 1, minOutputChars: 20 }
  );
  const parsed = parseModelObject(response) as { summary: string; ids: unknown[] };
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.ids)
    || parsed.ids.some((id: unknown) => typeof id !== 'string' || !sections.some((section) => section.id === id))
    || new Set(parsed.ids).size !== parsed.ids.length) throw new Error('Invalid targeted revision plan');
  const plan: RevisionPlan = { reviewHash, ids: parsed.ids as string[], summary: parsed.summary };
  first.reviewRevisionPlan = plan;
  return plan;
}

/** Bound each output to one existing paragraph so a whole-paper JSON cannot truncate. */
async function reviseSingleSection(section: Section, sections: Section[], reviews: ScientificReview[], instructions: string, save?: () => void): Promise<string> {
  const reviewHash = digest(JSON.stringify({ reviews, journalInstructions: instructions }));
  const saved = (section as RevisionSection).reviewRevisionResponse;
  if (saved?.reviewHash === reviewHash && saved.originalHash === digest(section.content)) {
    try { return parseSingleRevision(saved.raw, section.id); } catch { /* An incomplete response needs a fresh bounded request. */ }
  }
  const protectedTokens = section.content.match(/\$[^$]*\$|\[[0-9]+\]|\b\d+(?:\.\d+)?\b|!\[[^\]]*\]\([^)]*\)/g) || [];
  const response = await getModelClient().generate(
    'Conservatively revise ONLY the specified paragraph. Return strict JSON {"summary":"...","sections":[{"id":"the-specified-id","content":"complete replacement paragraph"}]}. Return exactly one section, never the whole paper. Do not invent facts, citations, methods or results. Narrow unsupported claims instead. Preserve every number, formula, citation marker, image/table token and their order exactly. References elsewhere in the manuscript are NOT permission to add references to this paragraph. Keep ordinary prose paragraphs between 120 and 220 words; this limit does not apply to tables or figure blocks. If no safe change is justified, return the original paragraph unchanged.',
    `Constraints:\n${instructions}\n\nFindings:\n${formatReviewBundle(reviews)}\n\nContext (read only):\n${buildReviewManuscript(sections)}\n\nExact protected token inventory: ${JSON.stringify(protectedTokens)}\n\nONLY editable paragraph: id=${section.id}\n${section.content}`,
    { task: 'writing', temperature: 0.1, maxTokens: 9000, timeoutMs: 120000, maxAttempts: 1, minOutputChars: 20 }
  );
  (section as RevisionSection).reviewRevisionResponse = { reviewHash, originalHash: digest(section.content), raw: response };
  save?.();
  return parseSingleRevision(response, section.id);
}

/** Validate the entire parsed replacement before allowing any source write. */
function parseSingleRevision(response: string, id: string): string {
  const parsed = parseRevision(response);
  if (parsed.sections.length !== 1 || parsed.sections[0].id !== id || typeof parsed.sections[0].content !== 'string' || !parsed.sections[0].content.trim()) {
    throw new Error(`Expected exactly one nonempty revision for ${id}`);
  }
  return parsed.sections[0].content.trim();
}

function formatReviewBundle(reviews: ScientificReview[]): string {
  return reviews.map((review, index) => `Reviewer ${index + 1}\n${formatScientificReview(review)}`).join('\n');
}

function parseReview(raw: string): ScientificReview {
  const parsed = parseModelObject(raw) as ScientificReview;
  if (!['pass', 'revise'].includes(parsed.verdict) || !Array.isArray(parsed.findings)) throw new Error('模型返回的质量审查 JSON 结构无效');
  for (const finding of parsed.findings) {
    if (!['theory', 'methods', 'experiments', 'presentation', 'reproducibility', 'consistency', 'references'].includes(finding.category)) {
      finding.category = 'consistency';
    }
  }
  return parsed;
}

function parseRevision(raw: string): { summary: string; sections: Array<{ id: string; content: string }> } {
  const parsed = parseModelObject(raw) as { summary: string; sections: Array<{ id: string; content: string }> };
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.sections)) throw new Error('模型返回的改稿 JSON 结构无效');
  return parsed;
}

/** Parse complete JSON, tolerating prose wrappers but never repairing malformed or truncated data. */
function parseModelObject(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch (error) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) throw error;
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function countWords(content: string): number {
  const englishWords = content.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g)?.length || 0;
  const cjkChars = content.match(/[\u3400-\u9FFF]/g)?.length || 0;
  return englishWords + cjkChars;
}
