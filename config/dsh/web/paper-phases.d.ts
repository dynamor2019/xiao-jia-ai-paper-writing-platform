export const PAPER_PHASES: Array<[string, string, string[]]>;
export function paperStages(): string[];
export function phaseForStage(stage: string): [string, string, string[]] | undefined;
export function groupPaperPhases(stages: Array<{ id: string; label: string; status: string; detail?: string }>): Array<{ id: string; label: string; status: string; passed: boolean; detail: string }>;
