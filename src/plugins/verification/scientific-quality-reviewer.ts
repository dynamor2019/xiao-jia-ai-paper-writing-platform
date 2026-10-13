import { getModelClient } from '../../lib/model-client.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRoute, type TaskType } from '../../config/model-routing.js';
import type { Section, ToolResult } from '../../types.js';
import { canonicalRevisionIsSafe, renderCanonicalMarkdown } from '../../workflows/canonical-draft.js';
import { assert_consistent_review } from './review-consistency.js';

export interface ScientificReviewFinding {
  category: 'theory' | 'methods' | 'experiments' | 'presentation' | 'reproducibility' | 'consistency' | 'references';
  severity: 'critical' | 'major' | 'minor';
  section: string;
  issue: string;
  requiredAction: string;
  blockingStage?: 'manuscript' | 'submission';
  submissionRequirement?: 'source-access' | 'author-declaration' | 'journal-format';
  claimQuote?: string;
  evidenceQuote?: string;
  evidenceSource?: 'manuscript' | 'validated-evidence' | 'missing';
  requiredEvidence?: string;
}

export interface ScientificReview {
  verdict: 'pass' | 'revise';
  findings: ScientificReviewFinding[];
}

export type ScientificReviewResult = ToolResult<ScientificReview> & {
  failureKind?: 'review-response' | 'request';
};

export interface CrossReviewRound {
  round: number;
  primary: ScientificReview;
  secondary: ScientificReview;
  revisionSummary: string;
}

const SYSTEM_PROMPT = `You are an independent senior reviewer auditing scientific validity and submission requirements separately, not searching for a quota of objections.
Check mathematical definitions and derivations, theorem assumptions and proofs, method-result consistency, experimental validity, missing controls or ablations, tables/figures, and reproducibility.
Explicitly treat as critical: synthetic or reconstructed observations presented as real experiments; statistics or significance not traceable to machine outputs; hidden negative/null/failed results; causal language based only on correlation or regression; and contradictions among plotted values, captions, Results, Abstract, and Conclusion.
Treat figure/table numbering disorder, misleading chart types, dual-axis ambiguity, inaccessible colors, and conclusions embedded as artwork titles as major presentation defects.
For column-generation papers, block submission unless reduced-cost pricing is theoretically standard or explicitly justified: identify the commodity assignment dual, check whether all commodities are priced, and verify that lower-bound, LP-optimum, or pool-optimal claims follow from the implemented algorithm.
For BIM/IFC/MEP routing papers, block claims of engineering feasibility, deployment readiness or authenticated physical connectivity unless supported. A source-anchored conditional numerical case may use disclosed inferred connectivity, idealized boundaries and assumed inputs; assess its internal equations, provenance, status accounting and claim limits, not field certification it explicitly does not claim. Undisclosed synthetic capacities or random terminals presented as source facts remain critical.
For target-journal positioning, block unsupported superiority, novelty or practical-advantage claims when matched strong baselines are missing. In an explicitly descriptive finite-candidate case, require relevant verified positioning and disclosure of unexecuted baselines, but do not infer a superiority claim from a comparison of named policies within the same supplied set. Journal competitiveness is not itself proof of a false scientific claim.
For references, block citation-position errors: the cited paper must support the sentence where it appears; bibliography padding and DOI-only existence are not sufficient.
For reproducibility, block unsupported "preregistered", "all data/code provided", or repository-upon-acceptance claims. Distinguish internal replay of supplied derived inputs from independent reconstruction of the original source. Missing public access is a blocker for claimed external reproducibility; if explicitly restricted, assess the actual local evidence and retain the restriction, without inventing access permissions. Author signatures, public-release permissions, submission confirmation and live journal compliance belong to submission readiness, not automatic evidence approval.
Use the explicitly author-approved claim scope when supplied; it supersedes historical project ambitions, never immutable results or integrity requirements. For each critical or major finding, identify the exact offending manuscript assertion and why the supplied evidence fails to support it. A limitation already accurately disclosed is not an unsupported affirmative claim. Do not force PASS: contradictions, invalid calculations, unbound citations, hidden failures and overclaims remain blocking under any scope.
Before alleging a numerical contradiction, compare the same candidate, scenario, demand, grid factor, split and metric. Different scenario-specific values are not contradictory, and a regret is not an absolute objective. Quote both conflicting assertions and identify the matching machine record. Read equations and tables across the entire manuscript; do not allege that a definition is absent merely because it appears in another subsection. Distinguish a misleading literature comparison from an explicitly descriptive precedent with no claimed reproduction or superiority.
Use critical for demonstrated invalidity, fabricated evidence, hidden outcomes or unsupported scientific conclusions; major for material missing evidence or an ambiguity preventing interpretation or replication; minor for local phrasing, redundant disclosures or a request to repeat an already supplied definition. A hypothetical journal rejection or missing field certification of an explicitly conditional numerical case does not itself establish critical scientific invalidity. Do not downgrade actual integrity or method defects.
For causal or econometric papers, treat as critical: unnamed or outdated identification strategy (staggered TWFE, IV without first-stage F, RD with high-order polynomials), missing assumption or pre-trend tests, and coefficients reported only by sign and significance with no economic magnitude.
Never estimate acceptance probability, predict editor decisions, or reassure with scores.
Do not praise, rewrite prose, or invent missing evidence. Return strict JSON only with this schema:
{"verdict":"pass|revise","findings":[{"category":"theory|methods|experiments|presentation|reproducibility|consistency|references","severity":"critical|major|minor","section":"...","issue":"...","requiredAction":"...","blockingStage":"manuscript|submission","submissionRequirement":"source-access|author-declaration|journal-format","claimQuote":"literal contiguous manuscript excerpt","evidenceSource":"manuscript|validated-evidence|missing","evidenceQuote":"literal contiguous source excerpt or empty for missing","requiredEvidence":"specific obligation, only when evidenceSource is missing"}]}
For material manuscript findings, copy short contiguous excerpts exactly; never insert ellipses, paraphrases, bracketed descriptions or reviewer summaries into quote fields. Editorial repetition, requests to bold a correctly reported maximum, and an accurate statement that an unimplemented rule is not used are not scientific contradictions. Classify them as minor unless a separate demonstrated error prevents interpretation. An acknowledged equivalent code/prose rule cannot support a contradiction finding. For absent author declarations use category=presentation and blockingStage=submission, never a scientific methods or reproducibility defect. Report only unresolved defects; an empty findings array with verdict=pass is valid when the supplied evidence supports the scoped manuscript.
Use blockingStage=manuscript for scientific defects or unsupported assertions, including misleading reproducibility claims. Use submission ONLY for explicitly disclosed access/rights restrictions, unsigned author declarations or unverified current journal formatting, and specify the matching submissionRequirement. Submission findings remain unresolved and must block submission; they do not prohibit a local clearly unapproved draft export. Never classify invalid methods, unbound citations, hidden results, false source claims, misleading figures or any critical defect as submission-only. Omit submissionRequirement for manuscript findings.
Report only demonstrated, unresolved defects. Perform verification yourself against the supplied manuscript and evidence before returning a finding. Do not return checklist questions such as "verify no residual claim", "confirm no replacement" or "ensure the values match" as defects when the supplied text and records already satisfy them. If a requested correction is already explicitly present, do not list it again. Critical or major findings require a quoted offending assertion and a concrete missing or conflicting fact; potential reader confusion alone is not critical invalidity. Missing permissions remain submission requirements only when accurately disclosed. Do not force a pass or suppress an actual unsupported claim.`;

/** Use an independent model pass to catch semantic defects deterministic checks cannot prove. */
export async function reviewScientificQuality(
  sections: Section[],
  journalInstructions: string,
  task: TaskType = 'quality',
  cacheDir?: string
): Promise<ScientificReviewResult> {
  let responseReceived = false;
  try {
    const system = `${SYSTEM_PROMPT}\nOUTPUT LIMITS: at most five highest-priority actionable findings; each issue at most 200 characters, requiredAction at most 240 characters, section at most 100 characters; the entire JSON object at most 3500 characters. Give an evidence-specific defect and action, not an essay or restatement of the manuscript. Finish every string, object and array. Do not certify source verification or visual inspection you did not perform. Return one JSON object without prose or code fences; escape all quotation marks, backslashes and newlines inside string values. CLASSIFICATION IS REQUIRED: every finding MUST include blockingStage. For submission-only findings ALSO include submissionRequirement. Keep category within the declared schema; do not use submission as a category. Missing classification remains manuscript-blocking. Correctly disclosed access restrictions, missing real author approval and unverified live submission formatting must remain explicit submission requirements, not assertions that a local unapproved draft is scientifically false. Scientific overclaims remain manuscript-blocking.`;
    const evidenceContract = '\nEVIDENCE CONTRACT: every critical or major MANUSCRIPT finding must include claimQuote copied verbatim from the manuscript, evidenceSource (manuscript|validated-evidence|missing), and evidenceQuote copied verbatim from that source. For a missing-evidence finding use evidenceSource=missing, evidenceQuote="", and requiredEvidence naming the specific missing evidence required by the quoted affirmative claim. A disclosed limitation alone is not such a claim. Quotes are separate fields, not subject to the issue character limit. Every finding must include blockingStage. Minor editorial suggestions and disclosed submission requirements may accompany verdict=pass; verdict=revise is for material scientific defects only. Return no critical or major finding without a demonstrated basis. This contract does not waive actual defects.';
    const prompt = `Target journal constraints and validated evidence (NOT manuscript text):\n${journalInstructions || 'General scientific journal'}${evidenceContract}\n\nManuscript to audit:\n${buildReviewManuscript(sections)}`;
    const key = digest(JSON.stringify({ task, route: getRoute(task), system, prompt }));
    const path = cacheDir ? join(cacheDir, `${key}.json`) : undefined;
    let response: string;
    if (path && existsSync(path)) {
      response = JSON.parse(readFileSync(path, 'utf8')).response;
    } else {
      response = await getModelClient().generate(system, prompt,
        { task, temperature: 0, maxTokens: 12000, timeoutMs: reviewTimeout(), maxAttempts: 1, minOutputChars: 20 });
      if (path) {
        mkdirSync(cacheDir!, { recursive: true });
        writeFileSync(path, JSON.stringify({ key, response }, null, 2) + '\n', 'utf8');
      }
    }
    responseReceived = true;
    return { success: true, data: parseReview(response) };
  } catch (error) {
    return { success: false, failureKind: responseReceived ? 'review-response' : 'request',
      error: `独立科技审查失败: ${error instanceof Error ? error.message : String(error)}` };
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
    const reviewHash = digest(JSON.stringify({ reviews, journalInstructions, revisionPolicy: 3 }));
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
      if (cached?.reviewHash === reviewHash && cached.originalHash === digest(section.content) && !canReuse) {
        unresolved.push(id);
        console.warn(`[评审保护] ${id}: 保留原文，未解决意见留给最终科学审查`);
        continue;
      }
      const content = canReuse ? cached!.content : await reviseSingleSection(section, revised, reviews, journalInstructions, () => saveProgress?.(revised));
      const knownMarkers = new Set(section.citations.map((citation) => citation.marker));
      const hasUnboundCitation = [...content.matchAll(/\[(\d+)\]/g)].some((match) => !knownMarkers.has(match[0]));
      if (hasUnboundCitation || (canonical && !canonicalRevisionIsSafe(section.content, content))) {
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
  lines.push(`Manuscript gate: ${manuscriptReviewBlocked(review) ? 'BLOCKED' : 'CLEAR'}`);
  lines.push(`Submission requirements: ${review.findings.some(submissionOnly) ? 'UNRESOLVED' : 'Not assessed by this verdict'}`, '');
  if (review.findings.length === 0) lines.push('- No blocking findings.');
  for (const finding of review.findings) {
    lines.push(`- [${finding.severity.toUpperCase()}]${submissionOnly(finding) ? ' [SUBMISSION]' : ''} ${finding.category} / ${finding.section}: ${finding.issue}`);
    lines.push(`  Required action: ${finding.requiredAction}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Defer only explicit author/access/format requirements; unknown and scientific defects fail closed. */
export function submissionOnly(finding: ScientificReviewFinding): boolean {
  if (finding.blockingStage !== 'submission' || finding.severity === 'critical') return false;
  return (finding.category === 'reproducibility' && finding.submissionRequirement === 'source-access')
    || (finding.category === 'presentation' && ['author-declaration', 'journal-format'].includes(finding.submissionRequirement || ''));
}

/** Draft delivery never certifies unresolved submission requirements as scientifically approved. */
export function manuscriptReviewBlocked(review: ScientificReview): boolean {
  if (review.findings.some((finding) => !submissionOnly(finding) && ['critical', 'major'].includes(finding.severity))) return true;
  return review.verdict !== 'pass' && !review.findings.length;
}

/** Keep editorial and author-only requirements out of paid scientific rewriting. */
export function manuscriptRevisionReview(review: ScientificReview): ScientificReview {
  return { ...review, findings: review.findings.filter(finding =>
    !submissionOnly(finding) && ['critical', 'major'].includes(finding.severity)) };
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

/** Submission-blocking audits must include every section, never silently clipped prose. */
function buildReviewManuscript(sections: Section[]): string {
  return renderCanonicalMarkdown(sections)
    ?? sections.map((section) => `## ${section.title}\n\n${section.content}`).join('\n\n');
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
    { task: 'writing', temperature: 0, maxTokens: 6000, timeoutMs: reviewTimeout(), maxAttempts: 1, minOutputChars: 20 }
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
  const reviewHash = digest(JSON.stringify({ reviews, journalInstructions: instructions, revisionPolicy: 3 }));
  const saved = (section as RevisionSection).reviewRevisionResponse;
  if (saved?.reviewHash === reviewHash && saved.originalHash === digest(section.content)) {
    try { return parseSingleRevision(saved.raw, section.id); } catch { /* An incomplete response needs a fresh bounded request. */ }
  }
  const protectedTokens = section.content.match(/\$[^$]*\$|\[[0-9]+\]|\b\d+(?:\.\d+)?\b|!\[[^\]]*\]\([^)]*\)/g) || [];
  const numericPolicy = renderCanonicalMarkdown(sections) !== undefined
    ? 'Preserve every number and formula and their order exactly.'
    : 'Correct erroneous numbers and decision-rule definitions ONLY from the supplied validated experiment evidence, including explicitly supplied derived summaries. Never invent or alter source results. Keep design selection separate from held-out evaluation. If a value cannot be verified, remove the unsupported claim or explicitly leave it unresolved.';
  const response = await getModelClient().generate(
    `Conservatively revise ONLY the specified paragraph. Return strict JSON {"summary":"...","sections":[{"id":"the-specified-id","content":"complete replacement paragraph"}]}. Return exactly one section, never the whole paper. Do not invent facts, citations, methods or results. Narrow unsupported claims instead. Preserve every citation marker and image/table token and their order exactly. ${numericPolicy} References elsewhere in the manuscript are NOT permission to add references to this paragraph. Keep ordinary prose paragraphs between 120 and 220 words; this limit does not apply to tables or figure blocks. If no safe change is justified, return the original paragraph unchanged.`,
    `Constraints:\n${instructions}\n\nFindings:\n${formatReviewBundle(reviews)}\n\nContext (read only):\n${buildReviewManuscript(sections)}\n\nExact protected token inventory: ${JSON.stringify(protectedTokens)}\n\nONLY editable paragraph: id=${section.id}\n${section.content}`,
    { task: 'writing', temperature: 0.1, maxTokens: 9000, timeoutMs: reviewTimeout(), maxAttempts: 1, minOutputChars: 20 }
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
    const alias = finding as ScientificReviewFinding & { abstract?: unknown };
    if (finding && finding.issue === undefined && typeof alias.abstract === 'string') finding.issue = alias.abstract;
    if (!finding || !['critical', 'major', 'minor'].includes(finding.severity)
      || (['section', 'issue', 'requiredAction'] as const).some((field) => typeof finding[field] !== 'string'
        || !finding[field].trim())) throw new Error('质量审查意见缺少有效严重级别或证据说明');
    if (!['theory', 'methods', 'experiments', 'presentation', 'reproducibility', 'consistency', 'references'].includes(finding.category)) {
      finding.category = 'consistency';
    }
  }
  assert_consistent_review(parsed.findings);
  return parsed;
}

function parseRevision(raw: string): { summary: string; sections: Array<{ id: string; content: string }> } {
  const parsed = parseModelObject(raw) as { summary: string; sections: Array<{ id: string; content: string }> };
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.sections)) throw new Error('模型返回的改稿 JSON 结构无效');
  return parsed;
}

/** Decode only the non-JSON apostrophe escape inside strings; preserve all valid escapes. */
function decodeApostropheEscape(text: string): string {
  let quoted = false;
  let decoded = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted && character === '\\' && index + 1 < text.length) {
      const next = text[++index];
      decoded += next === "'" ? next : character + next;
    } else {
      if (character === '"') quoted = !quoted;
      decoded += character;
    }
  }
  return decoded;
}

/** Parse complete JSON, tolerating wrappers and apostrophe escapes, never truncated data. */
function parseModelObject(raw: string): unknown {
  const cleaned = decodeApostropheEscape(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  try { return JSON.parse(cleaned); } catch (error) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) throw error;
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

/** Respect a run-local timeout override while keeping each paid request bounded. */
function reviewTimeout(): number {
  const requested = Number(process.env.MODEL_TIMEOUT_MS || 120000);
  return Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 300000) : 120000;
}

function countWords(content: string): number {
  const englishWords = content.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g)?.length || 0;
  const cjkChars = content.match(/[\u3400-\u9FFF]/g)?.length || 0;
  return englishWords + cjkChars;
}
