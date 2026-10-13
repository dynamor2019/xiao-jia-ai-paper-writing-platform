import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getModelClient } from '../../lib/model-client.js';
import { polishSection } from './polish-editor.js';
import { PaperPipeline } from '../../workflows/paper-pipeline.js';
import { ACADEMIC_STYLE_INSTRUCTIONS, auditAcademicStyle, formatAcademicStyleReport, polishIntegrityIssues } from './academic-style.js';

test('editorial audit is advisory, bilingual and does not blacklist technical vocabulary', () => {
  assert.deepEqual(auditAcademicStyle('Agents leverage a conditional model.'), []);
  assert.deepEqual(auditAcademicStyle('It is worth noting that the test failed.\n值得注意的是，结果未知。')
    .map(({ line, rule }) => ({ line, rule })), [
    { line: 1, rule: 'stock-opening' }, { line: 2, rule: 'stock-opening' },
  ]);
  assert.match(ACADEMIC_STYLE_INSTRUCTIONS, /not.*scientific PASS/);
});

test('conservative edit keeps numbers, units and citation identities', () => {
  const source = 'It is worth noting that the conditional score is -1.2e-3 Pa [1, 2] (Smith, 2024).';
  assert.deepEqual(polishIntegrityIssues(source, source.replace('It is worth noting that the', 'The')), []);
  for (const [before, after, field] of [
    ['-1.2e-3', '1.2e-3', 'quantities'], ['Pa', 'Hz', 'quantities'],
    ['Smith', 'Jones', 'citations'], ['[1, 2]', '[1, 3]', 'citations'],
  ]) assert.ok(polishIntegrityIssues(source, source.replace(before, after)).includes(field));
  assert.ok(polishIntegrityIssues('Smith (2024) reported a failure.', 'Jones (2024) reported a failure.').includes('citations'));
});

test('math, comparison operators, LaTeX references and tables/code are protected', () => {
  for (const source of ['$x = 2$', '\\(x = 2\\)', '\\[x = 2\\]', '$$x = 2$$',
    '```python\nx = 2\n```', '| value |\n|---|\n| 2 |']) {
    const changed = source.replace('x', 'y').replace('value', 'score');
    if (changed !== source) assert.ok(polishIntegrityIssues(source, changed).length > 0);
  }
  assert.ok(polishIntegrityIssues('p < 0.05', 'p > 0.05').includes('comparisons'));
  assert.ok(polishIntegrityIssues('Reference \\cite{smith}', 'Reference \\cite{jones}').includes('citations'));
});

test('paragraph deletion, blank output and removal of important qualifiers are rejected', () => {
  assert.ok(polishIntegrityIssues('Method.\n\nResults.', 'Method. Results.').includes('paragraph-coverage'));
  assert.deepEqual(polishIntegrityIssues('Text.', ' '), ['empty-output']);
  for (const [before, after] of [
    ['The result may improve.', 'The result improves.'],
    ['The conditional result is unknown.', 'The conditional result is established.'],
    ['The generated input is an assumption.', 'The observed input is an assumption.'],
    ['结果未知，数据是生成的。', '结果可靠，数据是生成的。'],
  ]) assert.ok(polishIntegrityIssues(before, after).some((issue) => issue.startsWith('qualification-')));
  assert.deepEqual(polishIntegrityIssues('It may potentially improve.', 'It may improve.'), []);
});

test('public polish uses one existing request and retains unsafe output without paid retries', async () => {
  const client = getModelClient();
  const generate = client.generate;
  let calls = 0;
  client.generate = async (system, _user, options) => {
    calls++;
    assert.match(system, /Academic voice/);
    assert.equal(options?.task, 'polish');
    return 'A score is 9.0 [1].';
  };
  try {
    const result = await polishSection('M01', 'Result', 'A score is 2.0 [1].', 'Topic');
    assert.equal(result.polishedContent, 'A score is 2.0 [1].');
    assert.deepEqual(result.changes, []);
    assert.ok(result.integrityIssues?.includes('quantities'));
    assert.equal(calls, 1);
  } finally { client.generate = generate; }
});

test('unchanged polish does not claim improvements, and request errors retain the source', async () => {
  const client = getModelClient();
  const generate = client.generate;
  try {
    client.generate = async () => 'Original prose.';
    assert.deepEqual((await polishSection('M01', 'Title', 'Original prose.', 'Topic')).changes, []);
    client.generate = async () => { throw new Error('mock unavailable'); };
    assert.equal((await polishSection('M01', 'Title', 'Original prose.', 'Topic')).polishedContent, 'Original prose.');
  } finally { client.generate = generate; }
});

test('pipeline and agent routes integrate style without disabling targeted repair or science review', () => {
  const pipeline = readFileSync(new URL('../../workflows/paper-pipeline.ts', import.meta.url), 'utf8');
  const preset = readFileSync(new URL('../../../config/dsh/presets/paper/agent.cordis.yml', import.meta.url), 'utf8');
  assert.match(pipeline, /formatAcademicStyleReport\(this.state.sections, 'Targeted literature repair; audit only, no rewriting'\)/);
  assert.match(pipeline, /integrityIssues: polished.integrityIssues/);
  assert.match(preset, /load academic-humanizer during writing and polishing/);
  const report = formatAcademicStyleReport([{ id: 'M01', title: 'Result', content: 'Furthermore, the result failed.' }], 'Audit only');
  assert.match(report, /not-polished/);
  assert.match(report, /not recorded/);
  assert.match(report, /line 1: transition-review/);
  assert.match(report, /No AI-detector score or scientific PASS/);
});

/** Exercise the real polishing stage with isolated state and a mocked existing client. */
function pipelineFixture(repaired = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-academic-style-'));
  const state = { topic: 'Topic', papers: [], sections: [{ id: 'S01', title: 'Result',
    content: 'It is worth noting that the conditional score is 2.0 [1].' }],
    literatureRevision: repaired ? { status: 'completed' } : undefined };
  const pipeline = Object.assign(Object.create(PaperPipeline.prototype), {
    state, reportsDir: root, researchInstructions: () => 'Supplied evidence only', saveState: () => {},
  }) as { stagePolishing(): Promise<void> };
  const cleanup = () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  };
  return { root, state, pipeline, cleanup };
}

test('real DSH polishing stage writes audit and does not repeat cached requests', async (context) => {
  context.mock.method(console, 'log', () => {});
  const { root, state, pipeline, cleanup } = pipelineFixture();
  const client = getModelClient();
  const generate = client.generate;
  let calls = 0;
  client.generate = async () => { calls++; return 'The conditional score is 2.0 [1].'; };
  try {
    await pipeline.stagePolishing();
    assert.equal(state.sections[0].content, 'The conditional score is 2.0 [1].');
    const report = readFileSync(join(root, 'academic-style-audit.md'), 'utf8');
    assert.match(report, /S01 \| completed \| 1 \| 0/);
    await pipeline.stagePolishing();
    assert.equal(calls, 1);
  } finally { client.generate = generate; cleanup(); }
});

test('completed targeted literature repair writes advisory audit without another writer', async (context) => {
  context.mock.method(console, 'log', () => {});
  const { root, state, pipeline, cleanup } = pipelineFixture(true);
  const original = JSON.stringify(state);
  const client = getModelClient();
  const generate = client.generate;
  client.generate = async () => { throw new Error('Unexpected paid rewrite'); };
  try {
    await pipeline.stagePolishing();
    assert.equal(JSON.stringify(state), original);
    assert.match(readFileSync(join(root, 'academic-style-audit.md'), 'utf8'), /audit only, no rewriting/);
  } finally { client.generate = generate; cleanup(); }
});
