import '../../scripts/project-env.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recoverDraftCitations } from './citation-recovery.js';
import { bindDeliveredSources, loadDeliveredLibrary } from './audit-delivered-citations.js';
import { asReviewSections } from './validate-paper.js';
import { consolidateDeliveredDeclarations } from './delivered-declarations.js';
import { pruneDeliveredBibliography } from './delivered-bibliography.js';
import type { PipelineState, Section } from '../types.js';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Replace only DSH-revised, uniquely located spans; retain all other bytes. */
export function applyDeliveredRevisions(original: string, before: Section[], after: Section[]): string {
  let output = original;
  for (const section of before) {
    const replacement = after.find(item => item.id === section.id);
    if (!replacement || replacement.content === section.content) continue;
    if (!section.content || output.indexOf(section.content) < 0
      || output.indexOf(section.content) !== output.lastIndexOf(section.content)) {
      throw new Error(`Ambiguous manuscript replacement: ${section.id}`);
    }
    const content = original.includes('\r\n') ? replacement.content.replace(/\r?\n/g, '\r\n') : replacement.content;
    output = output.replace(section.content, () => content);
  }
  return output;
}

/** Apply bounded DSH-native citation repairs only against a matching current audit. */
async function main(): Promise<void> {
  const extractiveOnly = process.argv.includes('--extractive-only');
  const consolidate = process.argv.includes('--consolidate-declarations');
  const prune = process.argv.includes('--prune-unused');
  const [manuscriptArg, evidenceArg, ...libraries] = process.argv.slice(2).filter(arg => !['--extractive-only', '--consolidate-declarations', '--prune-unused'].includes(arg));
  if (!manuscriptArg || !evidenceArg || !libraries.length) throw new Error('Expected manuscript, experiment evidence and source libraries');
  const manuscript = resolve(manuscriptArg), original = readFileSync(manuscript, 'utf8');
  const directory = join(dirname(manuscript), '.dsh-state', 'citation-support');
  const report = JSON.parse(readFileSync(join(directory, 'current.json'), 'utf8'));
  if (report.sha256 !== digest(original)) throw new Error('Audit is stale; refusing manuscript repair');
  const { sources, inputs } = await loadDeliveredLibrary(libraries);
  if (JSON.stringify(inputs) !== JSON.stringify(report.inputs)) throw new Error('Source evidence changed; rerun the audit first');
  const sections = asReviewSections(original).filter(section => section.title !== 'References');
  const before = structuredClone(sections);
  const state = { sections, papers: bindDeliveredSources(original, sources), notes: new Map() } as PipelineState;
  const lockPath = join(dirname(dirname(manuscript)), '.dsh-state', 'paper-pipeline.lock.json');
  const lock = await open(lockPath, 'wx');
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, task: 'citation-repair', startedAt: new Date().toISOString() }));
    const proposal = join(directory, 'repair-proposal.json');
    const save = () => writeFileSync(proposal, JSON.stringify({ sourceSha256: report.sha256, sections }, null, 2) + '\n');
    const repaired = await recoverDraftCitations(state, report.results.filter((item: { status: string }) => item.status !== 'verified'),
      { evidence: readFileSync(resolve(evidenceArg), 'utf8'), cacheDir: join(directory, 'repairs'), extractiveOnly }, save);
    const revised = applyDeliveredRevisions(original, before, sections);
    const consolidated = consolidate ? consolidateDeliveredDeclarations(revised) : revised;
    const updated = prune ? pruneDeliveredBibliography(consolidated, bindDeliveredSources(consolidated, sources)) : consolidated;
    if (digest(readFileSync(manuscript, 'utf8')) !== report.sha256) throw new Error('Manuscript changed while DSH repaired it');
    const backup = join(directory, `manuscript-before-${report.sha256}.md`);
    if (!existsSync(backup)) writeFileSync(backup, original);
    if (updated !== original) writeFileSync(manuscript, updated);
    console.log(JSON.stringify({ repaired, sha256: digest(updated), status: 'requires-independent-recheck' }));
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
