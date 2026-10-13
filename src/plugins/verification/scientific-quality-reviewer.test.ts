import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getModelClient } from '../../lib/model-client.js';
import type { Section } from '../../types.js';
import { manuscriptReviewBlocked, reviewScientificQuality, reviseSectionsFromReviews, type ScientificReview } from './scientific-quality-reviewer.js';
import { parseCanonicalSections } from '../../workflows/canonical-draft.js';

const REVIEWS: ScientificReview[] = [{ verdict: 'revise', findings: [{ category: 'presentation',
  severity: 'minor', section: 'I01', issue: 'Unclear scope', requiredAction: 'Clarify existing scope' }] }];

test('only explicit noncritical submission requirements may permit local draft delivery', () => {
  const source: ScientificReview = { verdict: 'revise', findings: [{ category: 'reproducibility',
    severity: 'major', section: 'Availability', issue: 'Disclosed source rights pending', requiredAction: 'Obtain lawful access',
    blockingStage: 'submission', submissionRequirement: 'source-access' }] };
  assert.equal(manuscriptReviewBlocked(source), false);
  assert.equal(source.verdict, 'revise');
  assert.equal(manuscriptReviewBlocked({ verdict: 'revise', findings: [] }), true);
  assert.equal(manuscriptReviewBlocked({ verdict: 'revise', findings: [{ ...source.findings[0], blockingStage: undefined }] }), true);
  assert.equal(manuscriptReviewBlocked({ verdict: 'pass', findings: [{ ...source.findings[0], severity: 'critical' }] }), true);
  assert.equal(manuscriptReviewBlocked({ verdict: 'pass', findings: [{ ...source.findings[0], category: 'methods' }] }), true);
  assert.equal(manuscriptReviewBlocked({ verdict: 'pass', findings: [{ ...source.findings[0], category: 'references' }] }), true);
  assert.equal(manuscriptReviewBlocked({ verdict: 'pass', findings: [{ ...source.findings[0], submissionRequirement: undefined }] }), true);
});

test('ordinary draft corrections use validated evidence without changing citation identity', async (context) => {
  const sections = manuscript();
  sections[0].content = 'Held-out regret is 552 [1].';
  sections[0].citations = [{ marker: '[1]', paperId: 'source-1', rawText: sections[0].content, verified: true }];
  context.mock.method(getModelClient(), 'generate', async (system: string) => {
    if (system.startsWith('Plan targeted')) return JSON.stringify({ summary: 'Correct verified count', ids: ['I01'] });
    assert.match(system, /ONLY from the supplied validated experiment evidence/);
    assert.match(system, /Preserve every citation marker/);
    assert.doesNotMatch(system, /Preserve every number and formula/);
    return JSON.stringify({ summary: 'Corrected from supplied evidence', sections: [{ id: 'I01', content: 'Held-out regret is 796.446 [1].' }] });
  });
  const result = await reviseSectionsFromReviews(sections, REVIEWS, 'Validated held-out regret: 796.446');
  assert.equal(result.success, true);
  assert.match(result.data!.sections[0].content, /796.446/);
  assert.equal(result.data!.sections[0].citations[0].paperId, 'source-1');
});

/** Create paragraphs without any external model or filesystem dependency. */
function manuscript(): Section[] {
  return ['I01', 'I02', 'M01'].map((id) => ({ id, nodeId: id, title: id,
    content: 'A supplied finite demonstration.', citations: [], wordCount: 5, status: 'completed' }));
}

test('unbound ordinary-draft citations retain source and allow other planned sections to continue', async (context) => {
  const sections = manuscript();
  const original = sections[0].content;
  let requests = 0;
  context.mock.method(getModelClient(), 'generate', async (system: string, prompt: string) => {
    requests++;
    if (system.startsWith('Plan targeted')) return JSON.stringify({ summary: 'Clarify scope', ids: ['I01', 'I02'] });
    const id = prompt.includes('ONLY editable paragraph: id=I01') ? 'I01' : 'I02';
    return JSON.stringify({ summary: 'Revision', sections: [{ id, content: id === 'I01' ? 'Unsupported [27].' : 'A conditional finite comparison.' }] });
  });
  const first = await reviseSectionsFromReviews(sections, REVIEWS, 'Evidence');
  assert.equal(first.success, true);
  assert.equal(first.data!.sections[0].content, original);
  assert.equal(first.data!.sections[1].content, 'A conditional finite comparison.');
  assert.match(first.data!.summary, /UNRESOLVED/);
  const count = requests;
  const second = await reviseSectionsFromReviews(first.data!.sections, REVIEWS, 'Evidence');
  assert.equal(second.success, true);
  assert.equal(requests, count);
});

test('review retains validated evidence and budgets reasoning without transport retries', async (context) => {
  context.mock.method(getModelClient(), 'generate', async (system: string, prompt: string, options: Record<string, unknown>) => {
    assert.match(system, /entire JSON object at most 3500 characters/);
    assert.match(system, /each issue at most 200 characters/);
    assert.match(prompt, /Result SHA256: bound-result/);
    assert.equal(options.maxTokens, 12000);
    assert.equal(options.maxAttempts, 1);
    return JSON.stringify({ verdict: 'revise', findings: REVIEWS[0].findings });
  });
  const result = await reviewScientificQuality(manuscript(), 'Result SHA256: bound-result');
  assert.equal(result.success, true);
  assert.equal(result.data?.verdict, 'revise');
});

test('conditional scope does not waive evidence integrity or force approval', async (context) => {
  context.mock.method(getModelClient(), 'generate', async (system: string) => {
    assert.match(system, /explicitly author-approved claim scope/);
    assert.match(system, /exact offending manuscript assertion/);
    assert.match(system, /Undisclosed synthetic capacities.*remain critical/);
    assert.match(system, /contradictions, invalid calculations, unbound citations, hidden failures and overclaims remain blocking/);
    assert.match(system, /Missing public access is a blocker for claimed external reproducibility/);
    return JSON.stringify({ verdict: 'revise', findings: [{ category: 'consistency', severity: 'critical',
      section: 'Results', issue: 'Claimed measured data is model-generated', requiredAction: 'Remove the unsupported measurement claim' }] });
  });
  const result = await reviewScientificQuality(manuscript(), 'Approved conditional case scope');
  assert.equal(result.data?.verdict, 'revise');
  assert.equal(result.data?.findings[0].severity, 'critical');
});

test('invalid review is archived before parsing and cannot cause repeated paid calls', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'scientific-review-cache-'));
  try {
    const raw = '{"verdict":"revise","findings":[';
    const generate = context.mock.method(getModelClient(), 'generate', async () => raw);
    assert.equal((await reviewScientificQuality(manuscript(), 'Evidence', 'quality', directory)).success, false);
    assert.equal((await reviewScientificQuality(manuscript(), 'Evidence', 'quality', directory)).success, false);
    assert.equal(generate.mock.callCount(), 1);
    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(readFileSync(join(directory, files[0]), 'utf8')).response, raw);
    await reviewScientificQuality(manuscript(), 'Changed evidence', 'quality', directory);
    assert.equal(generate.mock.callCount(), 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an explicit abstract-key defect keeps its exact meaning and critical severity', async (context) => {
  const issue = 'No sequential baseline; superiority is untested.';
  context.mock.method(getModelClient(), 'generate', async () => JSON.stringify({ verdict: 'revise',
    findings: [{ category: 'experiments', severity: 'critical', section: 'Results', abstract: issue,
      requiredAction: 'Remove unsupported superiority claim' }] }));
  const result = await reviewScientificQuality(manuscript(), 'Evidence');
  assert.equal(result.success, true);
  assert.equal(result.data?.verdict, 'revise');
  assert.equal(result.data?.findings[0].severity, 'critical');
  assert.equal(result.data?.findings[0].issue, issue);
});

test('run-local timeout is honored without adding paid retries', async (context) => {
  const previous = process.env.MODEL_TIMEOUT_MS;
  try {
    process.env.MODEL_TIMEOUT_MS = '300000';
    context.mock.method(getModelClient(), 'generate', async (_system: string, _prompt: string, options: Record<string, unknown>) => {
      assert.equal(options.timeoutMs, 300000);
      assert.equal(options.maxAttempts, 1);
      return JSON.stringify({ verdict: 'revise', findings: REVIEWS[0].findings });
    });
    assert.equal((await reviewScientificQuality(manuscript(), 'Evidence')).success, true);
  } finally {
    if (previous === undefined) delete process.env.MODEL_TIMEOUT_MS;
    else process.env.MODEL_TIMEOUT_MS = previous;
  }
});

test('a finding without a severity cannot silently pass scientific review', async (context) => {
  context.mock.method(getModelClient(), 'generate', async () => JSON.stringify({ verdict: 'pass',
    findings: [{ category: 'methods', issue: 'Unknown outcome', section: 'Methods', requiredAction: 'Verify' }] }));
  assert.equal((await reviewScientificQuality(manuscript(), 'Evidence')).success, false);
});

test('review includes section tails and the whole manuscript beyond the old clipping limit', async (context) => {
  const sections = Array.from({ length: 6 }, (_, index) => ({ ...manuscript()[0], id: `S${index}`,
    content: 'Complete section content. '.repeat(500) + `SECTION_END_${index}` }));
  context.mock.method(getModelClient(), 'generate', async (_system: string, prompt: string) => {
    for (let index = 0; index < 6; index++) assert.ok(prompt.includes(`SECTION_END_${index}`));
    return JSON.stringify({ verdict: 'revise', findings: REVIEWS[0].findings });
  });
  assert.equal((await reviewScientificQuality(sections, 'Full review')).success, true);
});

test('targeted revisions change only planned paragraphs and require one-section outputs', async (context) => {
  let calls = 0;
  context.mock.method(getModelClient(), 'generate', async (_system: string, _prompt: string, options: Record<string, unknown>) => {
    calls++;
    if (calls === 1) {
      assert.equal(options.maxTokens, 6000);
      assert.equal(options.maxAttempts, 1);
    }
    return calls === 1 ? JSON.stringify({ summary: 'Clarify scope', ids: ['I01'] })
      : JSON.stringify({ summary: 'Clarified', sections: [{ id: 'I01', content: 'A declared finite demonstration.' }] });
  });
  const result = await reviseSectionsFromReviews(manuscript(), REVIEWS, 'Keep synthetic scope');
  assert.equal(result.success, true);
  assert.equal(calls, 2);
  assert.equal(result.data?.sections.length, 3);
  assert.equal(result.data?.sections[1].content, 'A supplied finite demonstration.');
});

test('truncated output resumes only the unsaved paragraph, retaining the saved plan', async (context) => {
  let calls = 0;
  let saved = manuscript();
  context.mock.method(getModelClient(), 'generate', async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ summary: 'Clarify', ids: ['I01', 'I02'] });
    if (calls === 3) return '{"summary":"Truncated';
    const id = calls === 2 ? 'I01' : 'I02';
    return JSON.stringify({ summary: 'Clarified', sections: [{ id, content: 'A declared finite demonstration.' }] });
  });
  const checkpoint = (sections: Section[]) => { saved = structuredClone(sections); };
  const failed = await reviseSectionsFromReviews(saved, REVIEWS, 'Scope', checkpoint);
  assert.equal(failed.success, false);
  assert.equal(saved[0].content, 'A declared finite demonstration.');
  assert.equal(saved[1].content, 'A supplied finite demonstration.');
  const resumed = await reviseSectionsFromReviews(saved, REVIEWS, 'Scope', checkpoint);
  assert.equal(resumed.success, true);
  assert.equal(calls, 4);
});

test('invalid plan ids are rejected before any prose request', async (context) => {
  const generate = context.mock.method(getModelClient(), 'generate', async () => JSON.stringify({ summary: 'Invalid', ids: ['UNKNOWN'] }));
  const result = await reviseSectionsFromReviews(manuscript(), REVIEWS, 'Scope');
  assert.equal(result.success, false);
  assert.equal(generate.mock.callCount(), 1);
});

test('reviews with no findings do not trigger paid revisions', async (context) => {
  const generate = context.mock.method(getModelClient(), 'generate', async () => '');
  const result = await reviseSectionsFromReviews(manuscript(), [{ verdict: 'pass', findings: [] }], 'Scope');
  assert.equal(result.success, true);
  assert.equal(generate.mock.callCount(), 0);
});

test('review requires matched scenario evidence for numerical contradictions without waiving integrity', async (context) => {
  context.mock.method(getModelClient(), 'generate', async (system: string) => {
    assert.match(system, /compare the same candidate, scenario, demand, grid factor, split and metric/);
    assert.match(system, /Quote both conflicting assertions/);
    assert.match(system, /Do not downgrade actual integrity or method defects/);
    assert.match(system, /Report only demonstrated, unresolved defects/);
    assert.match(system, /Perform verification yourself/);
    return JSON.stringify({ verdict: 'revise', findings: [{ category: 'experiments', severity: 'critical',
      section: 'Results', issue: 'Hidden failed outcomes', requiredAction: 'Restore failed results', blockingStage: 'manuscript' }] });
  });
  const result = await reviewScientificQuality(manuscript(), 'Scope');
  assert.equal(result.data?.verdict, 'revise');
  assert.equal(manuscriptReviewBlocked(result.data!), true);
});

test('apostrophe escapes are decoded without changing review verdict or literal backslashes', async (context) => {
  const expected = "Draft uses 'conditional' scope and a literal \\ path.";
  context.mock.method(getModelClient(), 'generate', async () => JSON.stringify({
    verdict: 'revise', findings: [{ category: 'methods', severity: 'critical', section: 'Methods',
      issue: expected, requiredAction: 'Verify evidence', blockingStage: 'manuscript' }],
  }).replaceAll("'", "\\'"));
  const result = await reviewScientificQuality(manuscript(), 'Scope');
  assert.equal(result.success, true);
  assert.equal(result.data?.verdict, 'revise');
  assert.equal(result.data?.findings[0].issue, expected);
  assert.equal(result.data?.findings[0].severity, 'critical');
});

test('complete JSON inside prose wrappers is parsed while incomplete JSON remains rejected', async (context) => {
  let calls = 0;
  context.mock.method(getModelClient(), 'generate', async () => {
    calls++;
    const data = calls === 1 ? { summary: 'Clarify', ids: ['I01'] }
      : { summary: 'Clarified', sections: [{ id: 'I01', content: 'A finite declared demonstration.' }] };
    return `I have read the paragraph.\n${JSON.stringify(data)}\nEnd of response.`;
  });
  const result = await reviseSectionsFromReviews(manuscript(), REVIEWS, 'Scope');
  assert.equal(result.success, true);
  assert.equal(result.data?.sections[0].content, 'A finite declared demonstration.');
});

test('unsafe added citations retain source and remain unresolved without repeated paid requests', async (context) => {
  let calls = 0;
  let saved = parseCanonicalSections('## Introduction\n<!-- PARAGRAPH: I01 -->\nA declared demonstration [1].\n## References\n');
  const checkpoint = (sections: Section[]) => { saved = structuredClone(sections); };
  context.mock.method(getModelClient(), 'generate', async (_system: string, prompt: string) => {
    calls++;
    if (calls === 1) return JSON.stringify({ summary: 'Clarify', ids: ['I01'] });
    if (calls === 2) return JSON.stringify({ summary: 'Unsafe', sections: [{ id: 'I01', content: 'A demonstration [1] with added support [2].' }] });
    throw new Error('A cached unsafe candidate must not cause another paid request');
  });
  const first = await reviseSectionsFromReviews(saved, REVIEWS, 'Scope', checkpoint);
  assert.equal(first.success, true);
  assert.match(first.data!.summary, /UNRESOLVED.*I01/);
  assert.equal(saved[0].content, 'A declared demonstration [1].');
  saved[0].citations = [{ marker: '[1]', paperId: 'source-1', rawText: saved[0].content, verified: true }];
  const result = await reviseSectionsFromReviews(saved, REVIEWS, 'Scope', checkpoint);
  assert.equal(result.success, true);
  assert.equal(calls, 2);
  assert.match(result.data!.summary, /UNRESOLVED.*I01/);
  assert.deepEqual(result.data?.sections[0].citations.map(item => item.marker), ['[1]']);
});
