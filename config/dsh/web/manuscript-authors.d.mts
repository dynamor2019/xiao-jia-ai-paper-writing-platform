export interface ManuscriptAuthor {
  name: string;
  rank: string;
  email: string;
  affiliation: string;
}

export interface ManuscriptAuthorRank {
  id: string;
  label: string;
  order: number;
  corresponding: boolean;
}

export const MANUSCRIPT_AUTHOR_RANKS: ManuscriptAuthorRank[];
export function blankManuscriptAuthor(rank?: string): ManuscriptAuthor;
export function sanitizeAuthorForm(input: unknown): ManuscriptAuthor[];
export function renderAuthorBlock(input: unknown): string;
