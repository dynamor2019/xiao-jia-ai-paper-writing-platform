import type { Paper } from '../types.js';

export const MIN_RECENT_REFERENCE_SHARE = 0.3;
export const RECENT_YEAR_WINDOW = 5;

export interface LiteratureRecencyStats {
  cutoffYear: number;
  recent: number;
  total: number;
  share: number;
}

export function isRecentPaper(paper: Paper, currentYear = new Date().getFullYear()): boolean {
  const cutoffYear = currentYear - RECENT_YEAR_WINDOW + 1;
  return paper.year >= cutoffYear && paper.year <= currentYear;
}

export function literatureRecencyStats(
  papers: Paper[],
  currentYear = new Date().getFullYear(),
): LiteratureRecencyStats {
  const unique = uniquePapers(papers);
  const recent = unique.filter((paper) => isRecentPaper(paper, currentYear)).length;
  return {
    cutoffYear: currentYear - RECENT_YEAR_WINDOW + 1,
    recent,
    total: unique.length,
    share: unique.length === 0 ? 0 : recent / unique.length,
  };
}

export function selectBalancedLiterature(
  papers: Paper[],
  limit: number,
  currentYear = new Date().getFullYear(),
): Paper[] {
  const unique = uniquePapers(papers);
  const total = Math.min(Math.max(0, limit), unique.length);
  const recent = unique
    .filter((paper) => isRecentPaper(paper, currentYear))
    .sort((left, right) => right.year - left.year || (right.citations || 0) - (left.citations || 0));
  const established = unique
    .filter((paper) => !isRecentPaper(paper, currentYear))
    .sort((left, right) => (right.citations || 0) - (left.citations || 0) || right.year - left.year);
  const requiredRecent = Math.min(recent.length, Math.ceil(total * MIN_RECENT_REFERENCE_SHARE));
  const selectedRecent = recent.slice(0, requiredRecent);
  const selectedEstablished = established.slice(0, total - selectedRecent.length);
  const remaining = total - selectedRecent.length - selectedEstablished.length;
  if (remaining > 0) selectedRecent.push(...recent.slice(selectedRecent.length, selectedRecent.length + remaining));
  return interleaveRecent(selectedRecent, selectedEstablished);
}

function uniquePapers(papers: Paper[]): Paper[] {
  return [...new Map(papers.map((paper) => [paper.id, paper])).values()];
}

function interleaveRecent(recent: Paper[], established: Paper[]): Paper[] {
  const output: Paper[] = [];
  let recentIndex = 0;
  let establishedIndex = 0;
  while (recentIndex < recent.length || establishedIndex < established.length) {
    if (recentIndex < recent.length) output.push(recent[recentIndex++]);
    for (let i = 0; i < 2 && establishedIndex < established.length; i++) {
      output.push(established[establishedIndex++]);
    }
  }
  return output;
}
