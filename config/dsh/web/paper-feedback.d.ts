export interface ResearchFeedback {
  id: string;
  status: 'open' | 'resolved';
  stage: string;
  claimId: string;
  issue: string;
  evidence: string;
  resolution?: string;
  verification?: string;
}
export function readFeedback(projectDir: string): ResearchFeedback[];
export function addFeedback(projectDir: string, stage: string, claimId: string, issue: string, evidence: string): ResearchFeedback;
export function resolveFeedback(projectDir: string, id: string, resolution: string, verification: string): ResearchFeedback;
export function findClaimEvidence(projectDir: string, claimId: string): { path: string; row: string } | null;
