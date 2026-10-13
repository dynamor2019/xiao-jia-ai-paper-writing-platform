import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRINCIPLES = [
  'Answer the approved research question using actual results, not a desired positive outcome.',
  'Preserve the original hypothesis and report supported, unsupported, conditional or inconclusive findings separately.',
  'Negative, null and unknown results are legitimate outcomes; implementation failure is not scientific disconfirmation.',
  'A post-result hypothesis or mechanism is exploratory, not independently confirmed by the data that suggested it.',
  'Do not silently retrofit hypotheses, discard adverse cases, or expand scope. Record protocol amendments and their reasons.',
  'Use supporting, conflicting and alternative literature. Distinguish model assumptions from measured inputs and calculated results.',
].join('\n');

/** Bind optional interpretation decisions to the current result without inventing a conclusion. */
export function resultInterpretationInstructions(projectDir: string, resultsFile?: string): string {
  const path = join(projectDir, 'milestones', 'reproducibility', 'result-interpretation.json');
  if (!existsSync(path)) return PRINCIPLES;
  const decision = JSON.parse(readFileSync(path, 'utf8')) as {
    resultSha256?: string; originalHypothesis?: string; outcome?: string;
    explanation?: string; exploratoryHypothesis?: string;
  };
  const hash = resultsFile && existsSync(resultsFile)
    ? createHash('sha256').update(readFileSync(resultsFile)).digest('hex') : undefined;
  if (!hash || decision.resultSha256 !== hash || !decision.originalHypothesis?.trim()
    || !['supported', 'unsupported', 'conditional', 'inconclusive'].includes(decision.outcome || '')
    || !decision.explanation?.trim()) {
    throw new Error('Result interpretation is incomplete or bound results changed; retain original hypothesis and revalidate the decision.');
  }
  return `${PRINCIPLES}\nRecorded interpretation (not proof of validity):\n${JSON.stringify(decision)}\nAny new hypothesis remains exploratory until an independent validation is documented.`;
}
