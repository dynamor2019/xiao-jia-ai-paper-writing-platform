export const ACADEMIC_STYLE_INSTRUCTIONS = `Academic voice: lead with the supported finding, then explain its evidence and scope. Remove stock openings, hype, empty intensifiers and mechanical transitions only where they add no meaning. Keep established technical terms, justified passive voice and legitimate uncertainty; do not blindly replace vocabulary or impose sentence-length quotas. Match author voice only from supplied examples, never claim a model edit was human-written. Preserve paragraph coverage, citations, quantities with units, formulas, tables, code, limitations, assumptions, generated-data disclosures and negative/unknown results. Use existing sources for synthesis, not a fixed citation cap. Language polish is not evidence verification or a scientific PASS; do not promise detector evasion or conceal AI assistance.`;

export interface StyleFinding {
  line: number;
  rule: string;
}

export interface PolishAudit {
  before: StyleFinding[];
  after: StyleFinding[];
  integrityIssues: string[];
}

const STYLE_PATTERNS: Array<[string, RegExp]> = [
  ['stock-opening', /\b(?:it is (?:important|worth) (?:to note|noting)|in today.s rapidly evolving)\b|值得注意的是|毋庸置疑/i],
  ['hype-review', /\b(?:groundbreaking|revolutionary|unprecedented)\b|革命性|颠覆性|史无前例/i],
  ['stacked-hedging', /\bmay potentially\b|\bsuggest the possibility\b|可能或许|或许可能/i],
  ['transition-review', /^\s*(?:Moreover|Furthermore|Additionally)\b|^\s*(?:此外|综上所述)[，,]/i],
];

/** Flag optional editorial improvements, not authorship or scientific validity. */
export function auditAcademicStyle(text: string): StyleFinding[] {
  return text.split(/\r?\n/).flatMap((line, index) => STYLE_PATTERNS
    .filter(([, pattern]) => pattern.test(line))
    .map(([rule]) => ({ line: index + 1, rule })));
}

/** Extract protected content without treating ordinary words as forbidden vocabulary. */
function protectedContent(text: string) {
  const ordered = (pattern: RegExp) => text.match(pattern) ?? [];
  const sorted = (pattern: RegExp) => ordered(pattern).sort();
  return {
    quantities: ordered(/(?<![\p{L}\d])[-+−]?\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?(?:\s*(?:%|‰|°[CF]|(?:[kmcmunµ]?)(?:Pa|Hz|W|J|N|V|A|s|m|g|L)(?:[²³]|\^[-+]?\d+)?)(?![\p{L}]))?/gu),
    formulas: ordered(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g),
    comparisons: ordered(/[<>≤≥]=?|±/g),
    citations: sorted(/\[\d+(?:\s*[,;–-]\s*\d+)*\]|\\cite\w*\{[^}]+\}|\b\p{Lu}[\p{L}'-]+(?:\s+(?:(?:and|&)\s+)?\p{Lu}[\p{L}'-]+|\s+et\s+al\.)*\s*\((?:19|20)\d{2}[a-z]?\)|\([^()\n]*\b(?:19|20)\d{2}[a-z]?[^()\n]*\)/gu),
    assets: ordered(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~|^\s*\|.*\|\s*$|!\[[^\]]*\]\([^)]*\)/gm),
  };
}

/** Reject measurable evidence drift; semantic equivalence still needs scientific review. */
export function polishIntegrityIssues(original: string, candidate: string): string[] {
  if (!candidate.trim()) return ['empty-output'];
  const before = protectedContent(original);
  const after = protectedContent(candidate);
  const issues = Object.keys(before).filter((key) => {
    const field = key as keyof typeof before;
    return JSON.stringify(before[field]) !== JSON.stringify(after[field]);
  });
  const paragraphs = (text: string) => text.trim().split(/\r?\n\s*\r?\n/).length;
  if (paragraphs(original) !== paragraphs(candidate)) issues.push('paragraph-coverage');
  const qualifications = [
    /\b(?:not|no|never|without)\b|未|不|无/gi,
    /\b(?:failed|failure|negative|null)\b|失败|负结果|零效应/gi,
    /\bunknown\b|未知/gi,
    /\b(?:assumed|assumption)\b|假设/gi,
    /\b(?:synthetic|generated|imputed)\b|生成|插补/gi,
    /\b(?:estimated|estimate)\b|估计/gi,
    /\b(?:may|might|could|conditional|limited|uncertain|uncertainty)\b|可能|条件|有限|不确定/gi,
  ];
  for (const [index, pattern] of qualifications.entries()) {
    if (original.match(pattern)?.length && !candidate.match(pattern)?.length) issues.push(`qualification-${index}`);
  }
  return issues;
}

/** Render an inspectable advisory report, including rejected edits and cached work. */
export function formatAcademicStyleReport(sections: Array<{
  id: string; title: string; content: string;
  polishCheckpoint?: { outcome: string; audit?: PolishAudit };
}>, mode: string): string {
  const lines = ['# Academic Style Audit', '', `Mode: ${mode}`, '',
    'Advisory style findings only. No AI-detector score or scientific PASS. Semantic review and citation verification remain required.', '',
    '| Section | Outcome | Before flags | Current flags | Rejected integrity changes |', '|---|---|---|---|---|'];
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  for (const section of sections) {
    const audit = section.polishCheckpoint?.audit;
    lines.push(`| ${cell(section.id)} | ${cell(section.polishCheckpoint?.outcome ?? 'not-polished')} | ${audit?.before.length ?? 'not recorded'} | ${auditAcademicStyle(section.content).length} | ${cell(audit?.integrityIssues.join(', ') || 'none recorded')} |`);
    for (const finding of auditAcademicStyle(section.content)) {
      lines.push(`\n- ${cell(section.id)} / ${cell(section.title)}, line ${finding.line}: ${finding.rule} (editorial suggestion).`);
    }
  }
  return `${lines.join('\n')}\n`;
}
