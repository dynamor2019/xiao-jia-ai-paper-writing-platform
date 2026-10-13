import { literatureRecencyStats, MIN_RECENT_REFERENCE_SHARE } from '../lib/literature-balance.js';
import type { Paper, PipelineState } from '../types.js';

export const MIN_RESEARCH_PAPERS = 15;
const RESEARCH_TYPES = new Set(['journal-article', 'proceedings-article', 'article', 'review', 'preprint', 'posted-content']);

/** Normalize source identities independently of library IDs and citation frequency. */
export function literatureIdentity(paper: Paper): string {
  const locator = paper.url || paper.id;
  const doi = locator.match(/(?:doi\.org\/|^doi:)(10\.[^\s?#]+)/i);
  return doi ? doi[1].replace(/\.$/, '').toLowerCase() : paper.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Count research publications only when the discovery provider supplied their type. */
export function isResearchPublication(paper: Paper): boolean {
  return Boolean(paper.url && paper.title.trim() && paper.authors.length && paper.year > 1900
    && paper.year <= new Date().getFullYear() && paper.tags?.some((tag) => ['metadata:openalex', 'metadata:crossref'].includes(tag))
    && paper.tags?.some((tag) => tag.startsWith('publication:') && RESEARCH_TYPES.has(tag.slice(12))));
}

/** Separate bibliography completeness from existence/attribution and scientific validity. */
export function auditLiteratureCompleteness(state: Pick<PipelineState, 'papers' | 'sections'>) {
  const cited = new Set(state.sections.flatMap((section) => section.citations
    .filter((citation) => section.content.includes(citation.marker)).map((citation) => citation.paperId)));
  const used = state.papers.filter((paper) => cited.has(paper.id));
  const research = [...new Map(used.filter(isResearchPublication).map((paper) => [literatureIdentity(paper), paper])).values()];
  const researchIds = new Set(used.filter(isResearchPublication).map((paper) => paper.id));
  const recent = literatureRecencyStats(research);
  const evidenceSections = state.sections.filter((section) => section.citations.some((citation) => researchIds.has(citation.paperId)));
  const recentSections = evidenceSections.filter((section) => section.citations.some((citation) => {
    const paper = state.papers.find((item) => item.id === citation.paperId);
    return paper && isResearchPublication(paper) && paper.year >= recent.cutoffYear && paper.year <= new Date().getFullYear();
  })).length;
  const requiredDistribution = Math.ceil(evidenceSections.length / 2);
  const issues = [];
  if (research.length < MIN_RESEARCH_PAPERS) issues.push(`Only ${research.length} distinct, publication-typed research sources are cited; project minimum is ${MIN_RESEARCH_PAPERS}.`);
  if (recent.share < MIN_RECENT_REFERENCE_SHARE) issues.push('Fewer than 30% of cited research sources are from the last five calendar years.');
  if (recentSections < requiredDistribution) issues.push('Recent research is concentrated in too few evidence-bearing sections.');
  return { passed: issues.length === 0, researchCount: research.length, otherSourceCount: used.length - used.filter(isResearchPublication).length,
    recent, recentSections, requiredDistribution, issues };
}

/** Render an inspectable delivery gate, never a claim of journal acceptance. */
export function formatLiteratureCompleteness(state: Pick<PipelineState, 'papers' | 'sections'>): string {
  const audit = auditLiteratureCompleteness(state);
  return ['# Literature Completeness Gate', '', `Status: ${audit.passed ? 'PASS' : 'BLOCKED'}`,
    `Distinct cited research publications: ${audit.researchCount}/${MIN_RESEARCH_PAPERS}`,
    `Other or unclassified cited sources: ${audit.otherSourceCount}`,
    `Recent research: ${audit.recent.recent}/${audit.recent.total}`,
    `Recent section coverage: ${audit.recentSections}/${audit.requiredDistribution} required`, '',
    ...audit.issues.map((issue) => `- ${issue}`), '',
    'Counts are a project completeness requirement, not scientific proof. Real source support, substantive synthesis and scientific review are separate gates.', ''].join('\n');
}
