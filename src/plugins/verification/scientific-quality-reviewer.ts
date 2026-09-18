import { getModelClient } from '../../lib/model-client.js';
import type { TaskType } from '../../config/model-routing.js';
import type { Section, ToolResult } from '../../types.js';

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
      SYSTEM_PROMPT,
      `Target journal constraints:\n${journalInstructions || 'General scientific journal'}\n\nManuscript:\n${buildReviewManuscript(sections)}`,
      { task, temperature: 0, maxTokens: 5000, timeoutMs: 120000, maxAttempts: 1, minOutputChars: 600 }
    );
    return { success: true, data: parseReview(response) };
  } catch (error) {
    return { success: false, error: `独立科技审查失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function reviseSectionsFromReviews(
  sections: Section[],
  reviews: ScientificReview[],
  journalInstructions: string
): Promise<ToolResult<{ sections: Section[]; summary: string }>> {
  try {
    const response = await getModelClient().generate(
      'You are the original manuscript writing model. Revise the manuscript conservatively according to reviewer findings. Do not add new data, citations, methods, or results. If evidence is missing, narrow or qualify the claim. Return strict JSON only with {"summary":"...","sections":[{"id":"...","content":"..."}]}.',
      `Target journal constraints:\n${journalInstructions || 'General scientific journal'}\n\nReviewer findings:\n${formatReviewBundle(reviews)}\n\nManuscript:\n${buildRevisionManuscript(sections)}`,
      { task: 'writing', temperature: 0.1, maxTokens: 9000, timeoutMs: 120000, maxAttempts: 1, minOutputChars: 300 }
    );
    const parsed = parseRevision(response);
    const revisedSections = sections.map((section) => {
      const revision = parsed.sections.find((item) => item.id === section.id);
      if (!revision?.content?.trim()) return section;
      return {
        ...section,
        content: revision.content.trim(),
        wordCount: countWords(revision.content),
        status: 'completed' as const,
      };
    });
    return { success: true, data: { sections: revisedSections, summary: parsed.summary } };
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

function buildRevisionManuscript(sections: Section[]): string {
  return sections.map((section) => `## id=${section.id} title=${section.title}\n\n${section.content.trim()}`).join('\n\n');
}

function formatReviewBundle(reviews: ScientificReview[]): string {
  return reviews.map((review, index) => `Reviewer ${index + 1}\n${formatScientificReview(review)}`).join('\n');
}

function parseReview(raw: string): ScientificReview {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned) as ScientificReview;
  if (!['pass', 'revise'].includes(parsed.verdict) || !Array.isArray(parsed.findings)) throw new Error('模型返回的质量审查 JSON 结构无效');
  for (const finding of parsed.findings) {
    if (!['theory', 'methods', 'experiments', 'presentation', 'reproducibility', 'consistency', 'references'].includes(finding.category)) {
      finding.category = 'consistency';
    }
  }
  return parsed;
}

function parseRevision(raw: string): { summary: string; sections: Array<{ id: string; content: string }> } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned) as { summary: string; sections: Array<{ id: string; content: string }> };
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.sections)) throw new Error('模型返回的改稿 JSON 结构无效');
  return parsed;
}

function countWords(content: string): number {
  const englishWords = content.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g)?.length || 0;
  const cjkChars = content.match(/[\u3400-\u9FFF]/g)?.length || 0;
  return englishWords + cjkChars;
}
