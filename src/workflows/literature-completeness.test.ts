import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLiteratureCompleteness, literatureIdentity } from './literature-completeness.js';
import { researchFixture } from './literature-test-fixtures.js';

test('15 distinct typed, recent research sources meet the count gate only', () => {
  assert.equal(auditLiteratureCompleteness(researchFixture()).passed, true);
  assert.equal(auditLiteratureCompleteness(researchFixture(14)).passed, false);
});

test('repeated citations and duplicate DOI identities do not inflate counts', () => {
  const state = researchFixture();
  state.papers[14].url = state.papers[0].url?.toUpperCase();
  state.sections[0].citations.push(...state.sections[0].citations);
  assert.equal(auditLiteratureCompleteness(state).researchCount, 14);
  assert.equal(literatureIdentity(state.papers[0]), literatureIdentity(state.papers[14]));
});

test('manuals, software docs and unclassified works do not satisfy research count', () => {
  const state = researchFixture(30);
  for (const paper of state.papers) paper.tags = ['publication:book', 'metadata:crossref'];
  assert.equal(auditLiteratureCompleteness(state).researchCount, 0);
  state.papers[0].tags = [];
  assert.equal(auditLiteratureCompleteness(state).passed, false);
});

test('uncited library entries cannot satisfy delivery completeness', () => {
  const state = researchFixture(30);
  state.sections[0].citations = state.sections[0].citations.slice(0, 8);
  assert.equal(auditLiteratureCompleteness(state).researchCount, 8);
});

test('old research and concentrated recent sources fail separate recency checks', () => {
  const state = researchFixture();
  for (const paper of state.papers.slice(5)) paper.year = 2000;
  const main = state.sections[0];
  state.sections = Array.from({ length: 5 }, (_, index) => ({ ...main, id: String(index),
    citations: index === 0 ? main.citations.slice(0, 5) : main.citations.slice(5) }));
  assert.equal(auditLiteratureCompleteness(state).passed, false);
  for (const paper of state.papers) paper.year = 2000;
  assert.equal(auditLiteratureCompleteness(state).recent.share, 0);
});
