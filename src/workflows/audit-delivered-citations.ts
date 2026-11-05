import '../../scripts/project-env.mjs';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readVerifiedCitationCache, verifyDraftCitations } from './citation-recovery.js';
import { asReviewSections } from './validate-paper.js';
import type { Paper, PipelineState } from '../types.js';
import { getRoute } from '../config/model-routing.js';
import { narrativeCitationCandidates } from '../plugins/writing/section-writer.js';

const normalized = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Bind current bibliography entries only to existing source excerpts, never metadata alone. */
export function bindDeliveredSources(markdown: string, sources: Paper[]): Paper[] {
  const bibliography = markdown.split(/^## References\s*$/m)[1] || '';
  const entries = bibliography.split(/\n\s*\n/).filter(entry => entry.trim());
  const body = markdown.slice(0, markdown.indexOf('## References'));
  const labels = [...body.matchAll(/\([A-Za-z][^()\n]*,\s*(?:19|20)\d{2}[a-z]?\)/g)]
    .flatMap(match => match[0].slice(1, -1).split(/;\s*/));
  labels.push(...narrativeCitationCandidates(body).map(candidate => candidate.label.slice(1, -1)));
  for (const source of sources) {
    const label = (source as Paper & { citationLabel?: string }).citationLabel;
    if (label && body.includes(label.slice(1, -1).replace(/,\s*((?:19|20)\d{2}[a-z]?)$/, ' ($1)'))) {
      labels.push(label.slice(1, -1));
    }
  }
  return [...new Set(labels)].flatMap(label => {
    const author = label.split(/ et al\.| and |,/)[0].trim();
    const year = label.match(/(?:19|20)\d{2}/)?.[0];
    const candidates = entries.filter(entry => (entry.trim().startsWith(`${author},`) || entry.trim().startsWith(`${author} (`))
      && entry.match(/\((\d{4})\)/)?.[1] === year);
    if (candidates.length !== 1) return [];
    const entry = candidates[0];
    const doi = entry.match(/10\.\d{4,9}\/[^\s]+/)?.[0].replace(/\.$/, '').toLowerCase();
    const source = sources.find(item => item.abstract?.trim() && (
      (doi && `${item.id} ${item.url || ''} ${item.title}`.toLowerCase().includes(doi))
      || (normalized(item.title).length > 12 && normalized(entry).includes(normalized(item.title)))));
    if (!source) return [];
    return [{ ...source, id: `delivered-${normalized(label)}`, citationLabel: `(${label})` }];
  });
}

/** Load archived source evidence without converting metadata into an invented abstract. */
export async function loadDeliveredLibrary(libraryArgs: string[]) {
  const sources: Paper[] = [];
  const inputs: Array<{ path: string; sha256: string }> = [];
  for (const file of libraryArgs) {
    const content = await readFile(resolve(file), 'utf8');
    inputs.push({ path: resolve(file), sha256: createHash('sha256').update(content).digest('hex') });
    const data = JSON.parse(content);
    for (const item of (Array.isArray(data) ? data : [...(data.papers || []), ...(data.selected || []), ...(data.extra || [])])) {
      if (!item.title) continue;
      sources.push({ ...item, id: item.id || item.doi, source: item.source || 'manual' });
    }
  }
  return { sources, inputs };
}

/** Recover evidence-bound approvals from a preserved manuscript, never by inventing a route label. */
async function previousAssessments(directory: string, previous: Record<string, any> | undefined) {
  if (!previous) return undefined;
  if (previous.reviewRoute) return { results: previous.results, route: previous.reviewRoute };
  const original = await readFile(join(directory, `manuscript-before-${previous.sha256}.md`), 'utf8').catch(() => undefined);
  if (!original || createHash('sha256').update(original).digest('hex') !== previous.sha256 || !previous.inputs) return undefined;
  const { sources, inputs } = await loadDeliveredLibrary(previous.inputs.map((input: { path: string }) => input.path));
  if (JSON.stringify(inputs) !== JSON.stringify(previous.inputs)) return undefined;
  return { results: readVerifiedCitationCache(directory, bindDeliveredSources(original, sources)), route: getRoute('citation') };
}

/** Run the existing DSH evidence verifier with exact-input caches and one fixed report. */
async function main(): Promise<void> {
  const [manuscriptArg, ...libraryArgs] = process.argv.slice(2);
  if (!manuscriptArg || !libraryArgs.length) throw new Error('Expected manuscript.md and existing source JSON files');
  const manuscript = resolve(manuscriptArg);
  const markdown = await readFile(manuscript, 'utf8');
  const sha256 = createHash('sha256').update(markdown).digest('hex');
  const { sources, inputs } = await loadDeliveredLibrary(libraryArgs);
  const sections = asReviewSections(markdown).filter(section => section.title !== 'References');
  const state = { sections, papers: bindDeliveredSources(markdown, sources), notes: new Map() } as PipelineState;
  const directory = join(dirname(manuscript), '.dsh-state', 'citation-support');
  await mkdir(directory, { recursive: true });
  const projectDirectory = dirname(dirname(manuscript));
  const lockPath = join(projectDirectory, '.dsh-state', 'paper-pipeline.lock.json');
  const lock = await open(lockPath, 'wx');
  try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), task: 'citation-support' }));
  const previous = await readFile(join(directory, 'current.json'), 'utf8').then(value => JSON.parse(value)).catch(() => undefined);
  const results = await verifyDraftCitations(state, directory, await previousAssessments(directory, previous));
  if (createHash('sha256').update(await readFile(manuscript)).digest('hex') !== sha256) {
    throw new Error('Manuscript changed during citation audit; refusing a mismatched verdict');
  }
  const verified = results.filter(result => result.status === 'verified').length;
  const report = { manuscript, sha256, inputs, reviewRoute: getRoute('citation'), verified, total: results.length,
    nextAction: results.some(result => result.status === 'not-found') ? 'retrieve-source-evidence'
      : verified < results.length ? 'repair-citation-claims' : 'export-and-package',
    status: results.length > 0 && verified === results.length ? 'clear' : 'needs-repair', results };
  await writeFile(join(directory, 'current.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, verified, total: results.length,
    report: join(directory, 'current.json') }));
  if (report.status !== 'clear') process.exitCode = 2;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
