import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLiteratureRevisionIntegrity, authorizeLiteratureBillingResume, literatureSections, prepareLiteratureRevision, requestLiteratureRevision, runLiteratureRevision, validateLiteratureParagraph, validateSelections } from './literature-revision.js';
import { PaperPipeline, PIPELINE_STAGES } from './paper-pipeline.js';
import { getModelClient } from '../lib/model-client.js';
import type { LiteratureRevisionState } from './literature-revision.js';
import { researchFixture } from './literature-test-fixtures.js';

/** Use isolated state to test safeguards without writing or making paid model calls. */
function fixture(): LiteratureRevisionState {
  const state = researchFixture();
  return { ...state, topic: 'Conditional case', stage: 'submission-readiness', notes: new Map(),
    metadata: { startTime: '', currentStageStartTime: '', modelCalls: 0, totalTokens: 0, awaitingApproval: 'submission-readiness' },
    sections: [...state.sections, { ...state.sections[0], id: '4.1', title: 'Results', content: '128 pass, 241 fail, 36 unknown.' }] };
}

test('request preserves existing evidence and refuses resets or protected result changes', () => {
  const state = Object.assign(fixture(), { deliveryEvidencePrepared: true, reviewHistory: ['old-review'] });
  requestLiteratureRevision(state, 'Author requested literature improvement');
  assert.equal(state.stage, 'literature-search');
  assert.equal(state.metadata.awaitingApproval, undefined);
  assert.equal(state.deliveryEvidencePrepared, true);
  assert.deepEqual(state.reviewHistory, ['old-review']);
  assert.throws(() => requestLiteratureRevision(state, 'Reset'), /not reset/);
  assertLiteratureRevisionIntegrity(state);
  state.sections[1].content = 'All pass.';
  assert.throws(() => assertLiteratureRevisionIntegrity(state), /Protected/);
});

test('actual section IDs, not display-title prefixes, identify safe related-work sections', () => {
  const state = fixture();
  state.sections[0].title = 'BIM-based duct routing';
  assert.deepEqual(literatureSections(state).map((section) => section.id), ['2.1']);
});

test('confirmed recharge permits one extra call without erasing attempts, caches or review history', async () => {
  const state = Object.assign(fixture(), { reviewHistory: ['retained'], deliveryEvidencePrepared: true });
  requestLiteratureRevision(state, 'Native repair');
  const revision = state.literatureRevision!;
  revision.status = 'blocked';
  revision.error = 'Responses stream ended without a completed result';
  revision.queries = ['saved query'];
  revision.searches['saved query'] = state.papers.map((paper) => ({ ...paper, abstract: 'This study evaluates conditional duct network performance and carbon accounting under explicit scenario assumptions. '.repeat(2) }));
  revision.attempts = { 'search-plan': 1, 'screen-0': 3 };
  revision.responses['search-plan'] = 'cached plan';
  assert.throws(() => authorizeLiteratureBillingResume(state, 'Restored account', false), /confirmation/);
  const before = JSON.stringify({ attempts: revision.attempts, responses: revision.responses, searches: revision.searches, protectedHashes: revision.protectedHashes });
  authorizeLiteratureBillingResume(state, 'Author confirmed recharge', true);
  assert.equal(JSON.stringify({ attempts: revision.attempts, responses: revision.responses, searches: revision.searches, protectedHashes: revision.protectedHashes }), before);
  assert.deepEqual(state.reviewHistory, ['retained']);
  assert.equal(state.deliveryEvidencePrepared, true);
  revision.status = 'blocked';
  assert.throws(() => authorizeLiteratureBillingResume(state, 'Replay confirmation', true), /already pending/);
  revision.status = 'requested';
  const client = getModelClient(), original = client.generate;
  let calls = 0;
  client.generate = async () => { calls++; throw new Error('Responses stream ended without a completed result'); };
  try {
    const options = { instructions: 'Conditional scope', evidence: 'Results retained', save: () => {} };
    await assert.rejects(prepareLiteratureRevision(state, options), /stream ended/);
    assert.equal(calls, 1);
    assert.equal(revision.attempts['screen-0'], 4);
    assert.equal(revision.status, 'blocked');
    await assert.rejects(prepareLiteratureRevision(state, options), /stream ended/);
    assert.equal(calls, 1);
  } finally { client.generate = original; }
});

test('recharge confirmation cannot bypass a scientific or citation validation block', () => {
  const state = fixture();
  requestLiteratureRevision(state, 'Native repair');
  state.literatureRevision!.status = 'blocked';
  state.literatureRevision!.error = 'Fewer than 15 relevant sources';
  assert.throws(() => authorizeLiteratureBillingResume(state, 'Recharge', true), /Only a stopped/);
});

test('relevance screening rejects fabricated quotes, irrelevant scores and unknown identities', () => {
  const state = fixture();
  state.papers[0].abstract = 'This study investigates carbon accounting in duct networks using explicit uncertainty scenarios.';
  const valid = { paperId: 'p0', sectionId: '2.1', score: 9,
    quote: state.papers[0].abstract, reason: 'Relevant carbon accounting with scenario limitations.' };
  assert.equal(validateSelections([valid], state.papers, state.sections).length, 1);
  for (const change of [{ quote: 'Invented robust performance is universally certified.' }, { score: 7 }, { paperId: 'invented' }, { sectionId: 'missing' }]) {
    assert.equal(validateSelections([{ ...valid, ...change }], state.papers, state.sections).length, 0);
  }
});

test('a citation mismatch remains a draft marker and does not freeze the revision', async () => {
  const state = fixture();
  requestLiteratureRevision(state, 'Marker path');
  state.literatureRevision!.status = 'blocked';
  state.literatureRevision!.error = 'Literature paragraph contains missing or unassigned citation indices';
  state.literatureRevision!.prepared = true;
  const before = state.sections.map((section) => section.content).join('\n');
  const options = { instructions: 'Finite conditional case only.', evidence: '128 pass, 241 fail, 36 unknown.', save: () => {} };
  await runLiteratureRevision(state, options);
  assert.equal(state.literatureRevision?.status, 'marked');
  assert.match(state.literatureRevision?.markers?.join('\n') || '', /unassigned citation/);
  assert.equal(state.sections.map((section) => section.content).join('\n'), before);
  await runLiteratureRevision(state, options);
  assert.equal(state.literatureRevision?.status, 'marked');
});

test('targeted writer must cite all assigned evidence and no invented or unassigned sources', () => {
  const { papers } = fixture();
  validateLiteratureParagraph('One method [1] contrasts with another [2].', papers, ['p0', 'p1']);
  for (const paragraph of ['No citations.', 'Unknown [99].', 'Unassigned [3].', 'Only one [1].', '# References\n[1] [2]']) {
    assert.throws(() => validateLiteratureParagraph(paragraph, papers, ['p0', 'p1']));
  }
});

test('DSH repair resumes a interrupted paragraph without repeating discovery or completed writing', async () => {
  const state = fixture();
  state.papers = [];
  state.sections[0].content = 'Existing related work.';
  for (const section of state.sections) section.citations = [];
  state.sections.push(...['2.2', '2.3'].map((id) => ({ ...state.sections[0], id, nodeId: id })));
  const client = getModelClient(), originalGenerate = client.generate, originalFetch = globalThis.fetch;
  const abstract = 'This research compares uncertainty scenarios and carbon accounting methods in duct networks, with explicit boundaries for conditional computational assessment.';
  const words = abstract.split(' ');
  const index: Record<string, number[]> = {};
  words.forEach((word, position) => { (index[word] ||= []).push(position); });
  let discoveryCalls = 0, writingCalls = 0;
  client.generate = async (_system, prompt, options) => {
    if (options?.task === 'writing') {
      writingCalls++;
      if (writingCalls === 2) throw new Error('Responses stream ended without a completed result');
      return 'Comparative abstract-level evidence: ' + [...new Set(prompt.match(/\[\d+\]/g))].join(' ') + '. These methods do not certify this project.';
    }
    discoveryCalls++;
    assert.equal(options?.minOutputChars, 30);
    const task = JSON.parse(prompt);
    if (!task.sources) return JSON.stringify({ queries: ['duct networks carbon', 'uncertainty duct sizing', 'MEP lifecycle carbon', 'BIM duct optimization', 'scenario robustness duct'] });
    return JSON.stringify({ selections: task.sources.map((paper: { id: string }, offset: number) => ({
      paperId: paper.id, sectionId: ['2.1', '2.2', '2.3'][offset % 3], score: 9,
      quote: abstract, reason: 'Directly relevant scenario and carbon method evidence.' })) });
  };
  globalThis.fetch = async (input) => String(input).includes('openalex') ? Response.json({ results: Array.from({ length: 24 }, (_, offset) => ({
    id: `source-${offset}`, doi: `https://doi.org/10.1000/source-${offset}`, display_name: `Source ${offset}`,
    type: 'article', publication_year: new Date().getFullYear(), authorships: [{ author: { display_name: 'Author' } }], abstract_inverted_index: index,
  })) }) : Response.json({ message: { items: [] } });
  try {
    requestLiteratureRevision(state, 'Test native literature repair');
    const options = { instructions: 'Finite conditional case only.', evidence: '128 pass, 241 fail, 36 unknown.', save: () => {} };
    await prepareLiteratureRevision(state, options);
    assert.equal(writingCalls, 0);
    assert.equal(state.literatureRevision?.prepared, true);
    await assert.rejects(runLiteratureRevision(state, options), /stream ended/);
    assert.equal(state.literatureRevision?.completedSections.length, 1);
    const callsBeforeResume = discoveryCalls;
    await runLiteratureRevision(state, options);
    assert.equal(discoveryCalls, callsBeforeResume);
    assert.equal(writingCalls, 4);
    assert.equal(state.literatureRevision?.status, 'completed');
    assertLiteratureRevisionIntegrity(state);
    await runLiteratureRevision(state, options);
    assert.equal(writingCalls, 4);
  } finally { client.generate = originalGenerate; globalThis.fetch = originalFetch; }
});

test('formal literature stages follow validated results and precede all manuscript writing', () => {
  const order = ['protocol-design', 'experiment-execution', 'data-validation', 'literature-search',
    'literature-review', 'outline-generation', 'results-writing', 'methods-writing',
    'discussion-writing', 'introduction-writing', 'manuscript-completion', 'citation-verification', 'formatting', 'export'] as const;
  assert.equal(PIPELINE_STAGES.length, 20);
  order.forEach((stage, index) => {
    if (index) assert.ok(PIPELINE_STAGES.indexOf(stage) > PIPELINE_STAGES.indexOf(order[index - 1]));
  });
});

test('citation checking schedules a separate literature phase without researching or writing', async () => {
  const state = fixture();
  state.sections.forEach((section) => { section.citations = []; });
  const pipeline = Object.assign(Object.create(PaperPipeline.prototype), { state }) as { stageCitationVerification(): Promise<void> };
  await pipeline.stageCitationVerification();
  assert.equal(state.stage, 'literature-search');
  assert.equal(state.literatureRevision?.status, 'requested');
  assert.deepEqual(state.literatureRevision?.attempts, {});
});

test('formatting rechecks final citation existence, support and recency', async () => {
  let checked = 0;
  const pipeline = Object.assign(Object.create(PaperPipeline.prototype), {
    refreshFinalCitationEvidence: async () => { checked++; },
  }) as { stageFormatting(): Promise<void> };
  await pipeline.stageFormatting();
  assert.equal(checked, 1);
});

test('normal result-directed retrieval refuses unvalidated experiments before any discovery', async () => {
  const pipeline = Object.assign(Object.create(PaperPipeline.prototype), {
    loadValidatedResultEvidence: async () => { throw new Error('Result hash not validated'); },
  }) as { stageLiteratureSearch(): Promise<void> };
  await assert.rejects(pipeline.stageLiteratureSearch(), /Result hash not validated/);
});

test('workflow hands incomplete citations back to retrieval rather than advancing to polishing', async () => {
  const state = fixture();
  state.stage = 'citation-verification';
  delete state.metadata.awaitingApproval;
  const visited: string[] = [];
  const pipeline = Object.assign(Object.create(PaperPipeline.prototype), { state, outputDir: 'Isolated test',
    saveState: () => {}, cleanupRuntimeFiles: async () => {},
    executeStage: async (stage: string) => {
      visited.push(stage);
      if (stage === 'citation-verification') state.stage = 'literature-search';
      else state.metadata.awaitingApproval = 'literature-search';
    },
  }) as { runLocked(): Promise<unknown> };
  await pipeline.runLocked();
  assert.deepEqual(visited, ['citation-verification', 'literature-search']);
});
