import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PipelineState } from '../types.js';
import { citationClaimContext, readVerifiedCitationCache, recoverDraftCitations, refreshDraftCitations, verifyDraftCitations } from './citation-recovery.js';
import { getModelClient } from '../lib/model-client.js';
import { getRoute } from '../config/model-routing.js';

test('refresh preserves paragraph context including decimal quantities', () => {
  const state = { sections: [{ content: 'A factor of 1.5 is not verified [1].', citations: [] }],
    papers: [{ id: 'source-1' }], notes: new Map() } as unknown as PipelineState;
  refreshDraftCitations(state);
  assert.equal(state.sections[0].citations[0].rawText, state.sections[0].content);
});

test('narrative table references send the actual attributed row instead of an empty claim', () => {
  const rawText = '| Source | Evidence |\n|---|---|\n| Chen et al. (2022) | Duct routing. |\n| Other | Other claim. |';
  assert.equal(citationClaimContext({ marker: 'Chen et al. (2022)', rawText, paperId: 'chen', verified: false }),
    '| Chen et al. (2022) | Duct routing. |');
});

test('legacy approval migration requires the exact route and source evidence fingerprint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-legacy-proof-'));
  const previous = process.env.ROUTE_CITATION_MODEL;
  try {
    const papers = [{ id: 'source', title: 'Original source', abstract: 'Original evidence' }] as PipelineState['papers'];
    const citation = { paperId: 'source', marker: '[1]', verified: false, rawText: 'Claim [1].' };
    const key = createHash('sha256').update(JSON.stringify({ version: 4, route: getRoute('citation'), citations: [citation], papers, notes: [] })).digest('hex');
    writeFileSync(join(directory, `${key}.json`), JSON.stringify([{ citation, paper: papers[0], status: 'verified', reason: 'Source supports claim' }]));
    assert.equal(readVerifiedCitationCache(directory, papers).length, 1);
    assert.equal(readVerifiedCitationCache(directory, [{ ...papers[0], abstract: 'Different evidence' }]).length, 0);
    process.env.ROUTE_CITATION_MODEL = 'different-cache-reviewer';
    assert.equal(readVerifiedCitationCache(directory, papers).length, 0);
  } finally {
    if (previous === undefined) delete process.env.ROUTE_CITATION_MODEL;
    else process.env.ROUTE_CITATION_MODEL = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('extractive-only recovery may omit unsupported background but never a methods paragraph', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-extractive-policy-'));
  try {
    const generate = context.mock.method(getModelClient(), 'generate', async (system: string) => {
      assert.ok(!system.startsWith('Repair'));
      return JSON.stringify({ keep: [], reason: 'No source supports this assertion' });
    });
    for (const title of ['Introduction', 'Methods']) {
      const state = { sections: [{ id: title, title, content: 'Unsupported claim [1].\n\nRetained context.\n\nRetained scope.', citations: [] }],
        papers: [{ id: 'source', abstract: 'Unrelated source' }], notes: new Map() } as unknown as PipelineState;
      refreshDraftCitations(state);
      const failures = [{ citation: state.sections[0].citations[0], status: 'mismatch' as const, reason: 'No support' }];
      const repaired = await recoverDraftCitations(state, failures, { evidence: '', cacheDir: directory, extractiveOnly: true }, () => {});
      assert.equal(repaired, title === 'Introduction' ? 1 : 0);
      assert.equal(state.sections[0].content.includes('Unsupported'), title === 'Methods');
    }
    assert.equal(generate.mock.callCount(), 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a changed reviewer model cannot reuse a previous model assessment', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-model-cache-'));
  const previous = process.env.ROUTE_CITATION_MODEL;
  try {
    const state = { sections: [{ content: 'Unsupported attribution [1].', citations: [] }],
      papers: [{ id: 'one', abstract: 'Spatial routing' }], notes: new Map() } as unknown as PipelineState;
    refreshDraftCitations(state);
    const failures = [{ citation: state.sections[0].citations[0], status: 'mismatch' as const, reason: 'Wrong attribution' }];
    const generate = context.mock.method(getModelClient(), 'generate', async (system: string) =>
      system.startsWith('Repair') ? JSON.stringify({ content: 'Spatial routing is addressed [1].' })
        : JSON.stringify({ supported: true, reason: 'Source passage supports spatial routing' }));
    const options = { evidence: '', cacheDir: directory };
    process.env.ROUTE_CITATION_MODEL = 'reviewer-a';
    assert.equal(await recoverDraftCitations(state, failures, options, () => {}), 1);
    state.sections[0].content = 'Unsupported attribution [1].';
    process.env.ROUTE_CITATION_MODEL = 'reviewer-b';
    assert.equal(await recoverDraftCitations(state, failures, options, () => {}), 1);
    assert.equal(generate.mock.callCount(), 3);
  } finally {
    if (previous === undefined) delete process.env.ROUTE_CITATION_MODEL;
    else process.env.ROUTE_CITATION_MODEL = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('current-study evidence is distinct from literature and still independently audited', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-study-scope-'));
  try {
    const state = { sections: [{ content: 'The cited paper evaluated 27 candidates [1].', citations: [] }],
      papers: [{ id: 'source', abstract: 'Spatial routing only' }], notes: new Map() } as unknown as PipelineState;
    refreshDraftCitations(state);
    const failures = [{ citation: state.sections[0].citations[0], status: 'mismatch' as const, reason: 'Wrong attribution' }];
    context.mock.method(getModelClient(), 'generate', async (system: string, prompt: string) => {
      assert.match(prompt, /This study evaluated 27 candidates/);
      if (system.startsWith('Repair')) return JSON.stringify({ content: 'This study evaluated 27 candidates under disclosed assumptions.' });
      assert.match(system, /do NOT require literature attribution/);
      return JSON.stringify({ supported: true, reason: 'Current-study experiment explicitly records 27 candidates' });
    });
    let saves = 0;
    assert.equal(await recoverDraftCitations(state, failures,
      { evidence: 'This study evaluated 27 candidates', cacheDir: directory }, () => { saves++; }), 1);
    assert.equal(saves, 1);
    assert.equal(state.sections[0].citations.length, 0);
    assert.equal(state.sections[0].content, 'This study evaluated 27 candidates under disclosed assumptions.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('marker context excludes claims attributed to different papers and keeps decimal quantities', () => {
  const rawText = 'Source A reports a 1.5 factor [1]. Source B reports geometry [2].';
  assert.equal(citationClaimContext({ marker: '[2]', rawText, paperId: 'B', verified: false }),
    'Source B reports geometry [2].');
  assert.equal(citationClaimContext({ marker: '[1]', rawText, paperId: 'A', verified: false }),
    'Source A reports a 1.5 factor [1].');
});

test('audit rejection guides one bounded revision and cached resume never repeats paid calls', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-feedback-'));
  try {
    const state = { sections: [{ content: 'Invented saving [1].', citations: [] }],
      papers: [{ id: 'source', title: 'Routing', abstract: 'Spatial routing only' }], notes: new Map() } as unknown as PipelineState;
    refreshDraftCitations(state);
    const failures = [{ citation: state.sections[0].citations[0], status: 'mismatch' as const, reason: 'No savings evidence' }];
    const replies = [JSON.stringify({ content: 'Still an invented saving [1].' }),
      JSON.stringify({ supported: false, reason: 'Saving remains invented' }),
      JSON.stringify({ content: 'The source concerns spatial routing [1].' }),
      JSON.stringify({ supported: true, reason: 'Explicit source support' })];
    const generate = context.mock.method(getModelClient(), 'generate', async (_system: string, prompt: string) => {
      if (replies.length === 2) assert.match(prompt, /Saving remains invented/);
      return replies.shift()!;
    });
    let saves = 0;
    const options = { evidence: 'Conditional experiment', cacheDir: directory };
    assert.equal(await recoverDraftCitations(state, failures, options, () => { saves++; }), 1);
    assert.equal(saves, 1);
    assert.equal(state.sections[0].content, 'The source concerns spatial routing [1].');
    state.sections[0].content = 'Invented saving [1].';
    assert.equal(await recoverDraftCitations(state, failures, options, () => {}), 1);
    assert.equal(generate.mock.callCount(), 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('third revision receives the last rejection and all failed attempts stay cached', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-third-feedback-'));
  try {
    const state = { sections: [{ content: 'Unsupported claim [1].', citations: [] }],
      papers: [{ id: 'source', abstract: 'Spatial routing only' }], notes: new Map() } as unknown as PipelineState;
    refreshDraftCitations(state);
    const failures = [{ citation: state.sections[0].citations[0], status: 'mismatch' as const, reason: 'Wrong attribution' }];
    let revisions = 0;
    const generate = context.mock.method(getModelClient(), 'generate', async (system: string, prompt: string) => {
      if (system.startsWith('Repair')) {
        revisions++;
        if (revisions === 3) assert.match(prompt, /Unsupported schedule/);
        return JSON.stringify({ content: `Unsupported revision ${revisions} [1].` });
      }
      return JSON.stringify({ supported: false, reason: 'Unsupported schedule' });
    });
    const options = { evidence: 'Annual hours only', cacheDir: directory };
    const save = () => assert.fail('Rejected assertions must never be saved');
    assert.equal(await recoverDraftCitations(state, failures, options, save), 0);
    assert.equal(revisions, 3);
    assert.equal(generate.mock.callCount(), 7);
    assert.equal(await recoverDraftCitations(state, failures, options, save), 0);
    assert.equal(generate.mock.callCount(), 7);
    assert.equal(state.sections[0].content, 'Unsupported claim [1].');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('exhausted optional discussion is archived, while methods and sole paragraphs are retained', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-optional-discussion-'));
  try {
    let revisions = 0;
    context.mock.method(getModelClient(), 'generate', async (system: string) => system.startsWith('Repair')
      ? JSON.stringify({ content: `Unsupported revision ${++revisions} [1].` })
      : JSON.stringify({ supported: false, reason: 'No supporting evidence' }));
    for (const [title, second, expected] of [
      ['Implications for BIM design', '\n\nRetained model limitation.', 1],
      ['Methods', '\n\nRetained model limitation.', 0],
      ['Future work', '', 0],
    ] as const) {
      const original = `Unsupported ${title} assertion [1].${second}`;
      const state = { sections: [{ id: title, title, content: original, citations: [] }],
        papers: [{ id: 'source', abstract: 'Spatial routing only' }], notes: new Map() } as unknown as PipelineState;
      refreshDraftCitations(state);
      const failures = [{ citation: state.sections[0].citations[0], status: 'mismatch' as const, reason: 'Wrong attribution' }];
      assert.equal(await recoverDraftCitations(state, failures, { evidence: '', cacheDir: directory }, () => {}), expected);
      assert.equal(state.sections[0].content, expected ? 'Retained model limitation.' : original);
    }
    assert.equal(readdirSync(join(directory, 'omitted-discussion')).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unbound references remain failures, including cached resume', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-recovery-'));
  try {
    const state = { sections: [{ content: 'Unsupported claim [1].', citations: [] }],
      papers: [], notes: new Map() } as unknown as PipelineState;
    const first = await verifyDraftCitations(state, directory);
    assert.equal(first[0].status, 'not-found');
    assert.deepEqual(await verifyDraftCitations(state, directory), JSON.parse(JSON.stringify(first)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repair may cite another supplied source but never saves invented references', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-library-'));
  try {
    const state = { sections: [{ content: 'Wrong attribution [1].', citations: [] }],
      papers: [{ id: 'one' }, { id: 'two' }], notes: new Map() } as unknown as PipelineState;
    refreshDraftCitations(state);
    const failures = [{ citation: state.sections[0].citations[0], status: 'mismatch' as const, reason: 'Wrong source' }];
    const replies = [JSON.stringify({ content: 'Invented source [99].' }),
      JSON.stringify({ content: 'Supported by the other source [2].' }),
      JSON.stringify({ supported: true, reason: 'Provided source two supports this' })];
    const generate = context.mock.method(getModelClient(), 'generate', async () => replies.shift()!);
    let saves = 0;
    assert.equal(await recoverDraftCitations(state, failures, { evidence: '', cacheDir: directory }, () => { saves++; }), 1);
    assert.equal(saves, 1);
    assert.equal(state.sections[0].citations[0].paperId, 'two');
    assert.equal(generate.mock.callCount(), 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('batch ordering cannot change manuscript source identities', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-identity-'));
  try {
    const state = { sections: [{ content: 'Chen describes routing [2]. Calixto describes CP [1].', citations: [] }],
      papers: [{ id: 'CP', title: 'Calixto', abstract: 'CP evidence' },
        { id: 'graph', title: 'Chen', abstract: 'Graph evidence' }], notes: new Map() } as unknown as PipelineState;
    context.mock.method(getModelClient(), 'generate', async (_system: string, prompt: string) => {
      assert.match(prompt, /"marker":"\[1\]","paperId":"CP"/);
      assert.match(prompt, /"marker":"\[2\]","paperId":"graph"/);
      return JSON.stringify({ results: [{ index: 1, status: 'verified', reason: 'Graph source supports Chen' },
        { index: 2, status: 'mismatch', reason: 'Claim not supported by CP source' }] });
    });
    const result = await verifyDraftCitations(state, directory);
    assert.equal(result[0].citation.paperId, 'graph');
    assert.equal(result[0].status, 'verified');
    assert.equal(result[1].citation.paperId, 'CP');
    assert.equal(result[1].status, 'mismatch');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('contradictory JSON does not crash the pipeline or falsely approve a citation', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-conflict-'));
  try {
    const state = { sections: [{ content: 'Uncertain claim [1].', citations: [] }],
      papers: [{ id: 'one', abstract: 'Limited evidence' }], notes: new Map() } as unknown as PipelineState;
    context.mock.method(getModelClient(), 'generate', async () =>
      '```json\n{"results":[{"index":1,"status":"verified","reason":"yes"}]}\n```\n' +
      '```json\n{"results":[{"index":1,"status":"mismatch","reason":"no"}]}\n```');
    const result = await verifyDraftCitations(state, directory);
    assert.equal(result[0].status, 'needs-review');
    assert.equal(state.sections[0].content, 'Uncertain claim [1].');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
