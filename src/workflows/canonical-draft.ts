import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Paper, PipelineState, Section } from '../types.js';

interface SourceRange { id: string; start: number; end: number }
interface SourceBinding { path: string; sha256: string; template: string; ranges: SourceRange[]; resultSha256?: string }
type BoundSection = Section & { canonicalSource?: SourceBinding };
const WRITING_STAGES = new Set(['introduction-writing', 'methods-writing', 'results-writing', 'discussion-writing', 'manuscript-completion']);

/** Hash the exact saved source, including its original line endings. */
function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Return the binding carried by the first imported section. */
function binding(sections: Section[]): SourceBinding | undefined {
  return (sections[0] as BoundSection | undefined)?.canonicalSource;
}

/** Parse durable paragraph markers and separately framed tables/figures. */
export function parseCanonicalSections(source: string): Section[] {
  const events = [...source.matchAll(/^(#{1,3})[ \t]+([^\r\n]+)|<!--[\s\S]*?-->/gm)];
  const sections: Section[] = [];
  const ranges: SourceRange[] = [];
  let heading = '';
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event[1]) heading = event[2].trim();
    if (/^References$/i.test(heading)) break;
    const paragraph = event[0].match(/^<!--\s*PARAGRAPH:\s*([\w-]+)/);
    const asset = event[1] === '###' && /^(?:Table|Figure)\s+\d/i.test(heading);
    if (!paragraph && !asset) continue;
    const start = (event.index ?? 0) + event[0].length;
    const end = events[index + 1]?.index ?? source.length;
    const raw = source.slice(start, end);
    const content = raw.trim();
    if (!content) throw new Error('Canonical manuscript has an empty paragraph or asset');
    const offset = raw.indexOf(content);
    const id = paragraph?.[1] || `asset-${sections.length}`;
    if (ranges.some((range) => range.id === id)) throw new Error('Duplicate canonical paragraph marker');
    ranges.push({ id, start: start + offset, end: start + offset + content.length });
    sections.push({ id, nodeId: id, title: `${heading} (${id})`, content, citations: [],
      wordCount: content.split(/\s+/).length, status: 'completed', paragraphsCompleted: 1, paragraphsPlanned: 1 });
  }
  if (!sections.length) throw new Error('No durable manuscript paragraphs found');
  (sections[0] as BoundSection).canonicalSource = { path: '', sha256: hash(source), template: source, ranges };
  return sections;
}

/** Render edits into their original source spans; never regenerate the chapter structure. */
export function renderCanonicalSource(sections: Section[]): string | undefined {
  const source = binding(sections);
  if (!source) return undefined;
  if (sections.length !== source.ranges.length) throw new Error('Canonical sections cannot be added or dropped silently');
  let rendered = source.template;
  for (const range of [...source.ranges].reverse()) {
    const section = sections.find((item) => item.id === range.id);
    if (!section || !section.content.trim()) throw new Error('Canonical section missing or empty');
    const newline = source.template.includes('\r\n') ? '\r\n' : '\n';
    rendered = rendered.slice(0, range.start) + section.content.replace(/\r?\n/g, newline) + rendered.slice(range.end);
  }
  return rendered;
}

/** Keep private workflow comments out of reader-facing reviews and exports. */
export function renderCanonicalMarkdown(sections: Section[]): string | undefined {
  return renderCanonicalSource(sections)?.replace(/<!--[\s\S]*?-->/g, '');
}

/** Preserve scientific values and citation identities, allowing cited sentences to move. */
export function canonicalRevisionIsSafe(before: string, after: string): boolean {
  const tokens = (text: string) => text.match(/\$[^$]*\$|\[[0-9]+\]|\b\d+(?:\.\d+)?\b|!\[[^\]]*\]\([^)]*\)/g) || [];
  const scientific = (text: string) => tokens(text).filter((token) => !/^\[\d+\]$/.test(token));
  const citations = (text: string) => tokens(text).filter((token) => /^\[\d+\]$/.test(token)).sort();
  return Boolean(after.trim()) && JSON.stringify(scientific(before)) === JSON.stringify(scientific(after))
    && JSON.stringify(citations(before)) === JSON.stringify(citations(after));
}

/** Recover bibliography identities without inventing abstracts or full-text access. */
function importReferences(source: string, evidence: string): Paper[] {
  const bibliography = source.split(/^##\s+References\s*$/m)[1];
  if (!bibliography) throw new Error('Canonical source has no References section');
  return [...bibliography.matchAll(/^\[(\d+)\]\s+(.+)$/gm)].map((row) => {
    const citation = row[2].trim();
    const year = citation.match(/\b(?:19|20)\d{2}\b/);
    const doi = citation.match(/https:\/\/doi\.org\/([^\s]+?)(?:\.$|\s|$)/);
    if (!year || !doi) throw new Error('Imported reference requires a year and DOI locator');
    return { id: `canonical-ref-${row[1]}`, title: citation, authors: [], year: Number(year[0]),
      abstract: `Prior source-verification evidence (not a new full-text read):\n${evidence}`,
      url: `https://doi.org/${doi[1]}`, source: 'manual' as const };
  });
}

/** Bind each literal reference marker to its actual source paragraph. */
function bindCitations(sections: Section[], papers: Paper[]): void {
  for (const section of sections) {
    section.citations = [...section.content.matchAll(/\[(\d+)\]/g)].map((match) => {
      const paperId = `canonical-ref-${match[1]}`;
      if (!papers.some((paper) => paper.id === paperId)) throw new Error(`Unresolved canonical citation ${match[0]}`);
      return { paperId, marker: match[0], rawText: section.content, verified: false };
    });
  }
}

/** Include audited local primary passages, not just a verification status label. */
function referenceEvidence(outputDir: string): string {
  const evidence = ['citation-audit.md', 'literature-verification.md'].map((file) => {
    const path = join(outputDir, 'milestones', file);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }).join('\n\n');
  const passages = [...evidence.matchAll(/([\w-]+\.txt):(\d+)[–-](\d+)/g)].map((match) => {
    const path = join(outputDir, '.dsh-state', 'literature-cache', 'core-routing', match[1]);
    if (!existsSync(path)) return '';
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    return `Local primary passage ${match[0]}:\n${lines.slice(Number(match[2]) - 1, Number(match[3])).join('\n')}`;
  });
  return [...new Set(passages), evidence].join('\n\n');
}

/** Adopt a complete, source-audited manuscript only after the experiment/data stages. */
export function adoptCanonicalDraft(outputDir: string, state: PipelineState): boolean {
  const previous = binding(state.sections);
  const path = join(outputDir, '.dsh-state', 'manuscript.md');
  if ((!previous && !WRITING_STAGES.has(state.stage)) || !existsSync(path)) return false;
  const source = readFileSync(path, 'utf8');
  if (previous?.sha256 === hash(source)) {
    const auditPath = join(outputDir, 'milestones', 'reproducibility', 'manuscript-consistency.json');
    const auditedResult = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')).resultSha256 : undefined;
    const expectedResult = previous.resultSha256 || auditedResult;
    const resultPath = state.metadata.resultsFile;
    if (!expectedResult || !resultPath || !existsSync(resultPath) || hash(readFileSync(resultPath)) !== expectedResult) {
      throw new Error('Bound manuscript belongs to a missing or different experiment; source retained. Revalidate results and revise affected manuscript before resume.');
    }
    previous.resultSha256 = expectedResult;
    const papers = importReferences(source, referenceEvidence(outputDir));
    state.papers = papers;
    bindCitations(state.sections, papers);
    return false;
  }
  if (!/NEXT_PARAGRAPH:\s*QUALITY_REVIEW\b/.test(source)) return false;
  const auditPath = join(outputDir, 'milestones', 'reproducibility', 'manuscript-consistency.json');
  if (!existsSync(auditPath)) throw new Error('Existing manuscript requires a current source-consistency audit before resume');
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  const result = state.metadata.resultsFile;
  if (!result || !audit.resultSha256 || audit.manuscriptSha256 !== hash(source)
    || audit.resultSha256 !== hash(readFileSync(resolve(result)))
    || audit.status !== 'PASS_SCOPED_SOURCE_CONSISTENCY' || !audit.checks?.length
    || audit.checks.some((check: { status: string }) => check.status !== 'PASS')) {
    throw new Error('Existing manuscript/result audit is stale or failed; refusing old-outline drafting');
  }
  const sections = parseCanonicalSections(source);
  const title = source.match(/^#\s+([^\r\n]+)/m)?.[1];
  if (!title) throw new Error('Canonical manuscript requires a title');
  const papers = importReferences(source, referenceEvidence(outputDir));
  bindCitations(sections, papers);
  const checkpoint = join(outputDir, '.dsh-state', 'paper-pipeline-state.json');
  if (existsSync(checkpoint)) copyFileSync(checkpoint, `${checkpoint}.before-canonical-${hash(readFileSync(checkpoint)).slice(0, 16)}.bak`);
  binding(sections)!.path = path;
  binding(sections)!.resultSha256 = audit.resultSha256;
  state.topic = title;
  state.sections = sections;
  state.papers = papers;
  state.notes = new Map();
  state.outline = { topic: title, totalEstimatedWords: sections.reduce((sum, item) => sum + item.wordCount, 0),
    nodes: sections.map((section) => ({ id: section.id, level: 1, title: section.title, supportingPapers: [], estimatedWords: section.wordCount })) };
  return true;
}

/** Use the amended scope instead of obsolete discovery controls for adopted drafts. */
export function canonicalScope(outputDir: string, sections: Section[]): string | undefined {
  if (!binding(sections)) return undefined;
  const path = join(outputDir, 'milestones', 'writing-scope-amendment.md');
  const amendment = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const scope = amendment.split(/^## Current draft delivery and concentrated author facts\s*$/m)[0];
  return `The current canonical manuscript, not the legacy discovery title, defines the research scope. Do not broaden its claims or invent data. Historical workflow/status appendices are not current manuscript evidence.\n${scope}\n${currentVisualEvidence(outputDir)}`;
}

/** Include scoped visual evidence only while every named image still matches its reviewed hash. */
function currentVisualEvidence(outputDir: string): string {
  const path = join(outputDir, 'milestones', 'supervisor-visual-review.md');
  if (!existsSync(path)) return '';
  const report = readFileSync(path, 'utf8');
  const images = [...report.matchAll(/^File: ([^\r\n]+)\r?\nSHA256: ([0-9a-f]{64})$/gm)];
  if (!images.length) return '';
  const root = resolve(outputDir) + sep;
  for (const image of images) {
    const asset = resolve(outputDir, image[1]);
    if (!asset.startsWith(root) || !existsSync(asset) || hash(readFileSync(asset)) !== image[2]) {
      return 'Prior supervisor visual report is stale or unverifiable; no current visual pass is asserted.';
    }
  }
  return `Current hash-matched supervisor visual evidence (assistant inspection, not human approval, print-layout verification or independent scientific review):\n${report}`;
}

/** Save minimal body replacements, preserving comments, numbers, references and source encoding. */
export function syncCanonicalDraft(sections: Section[]): void {
  const source = binding(sections);
  if (!source?.path) return;
  const original = readFileSync(source.path);
  if (hash(original) !== source.sha256) throw new Error('Canonical manuscript changed externally; refusing to overwrite it');
  const rendered = renderCanonicalSource(sections)!;
  if (rendered === original.toString('utf8')) return;
  for (const range of source.ranges) {
    const before = source.template.slice(range.start, range.end);
    const after = sections.find((item) => item.id === range.id)!.content;
    if (!canonicalRevisionIsSafe(before, after)) {
      throw new Error(`Revision changed protected math/numbers/citations/assets in ${range.id}; source retained`);
    }
  }
  copyFileSync(source.path, `${source.path}.before-${source.sha256.slice(0, 16)}.bak`);
  const temporary = `${source.path}.pipeline.tmp`;
  writeFileSync(temporary, rendered, 'utf8');
  renameSync(temporary, source.path);
  const refreshed = parseCanonicalSections(rendered);
  source.template = rendered;
  source.sha256 = hash(rendered);
  source.ranges = binding(refreshed)!.ranges;
}
