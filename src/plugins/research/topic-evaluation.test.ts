import assert from 'node:assert/strict';
import test from 'node:test';

import type { Paper } from '../../types.js';
import { validateResearchDirection, validateTopicReview, type ResearchDirection } from './topic-evaluation.js';

const targetWorks = [1, 2].map((number) => ({ id: `target-${number}`, title: `Home work ${number}`, abstract: 'Relevant target-domain abstract.' })) as Paper[];
const sourceWorks = [1, 2].map((number) => ({ id: `source-${number}`, title: `Method work ${number}`, abstract: 'Relevant method abstract.' })) as Paper[];

function direction(): ResearchDirection {
  return {
    title: 'Transfer a method to a bounded home-field problem',
    researchQuestion: 'Does the transfer improve a measurable home-field outcome?',
    novelty: 'A testable integration hypothesis, not a wholly new method.',
    method: 'Compare transferred method with a home-field baseline.',
    requiredData: 'Home-field observations and method inputs.',
    feasibility: 'A public benchmark is identified for preliminary testing.',
    risks: ['Domain shift may invalidate the source assumptions.'],
    sourceIds: ['target-1', 'target-2', 'source-1', 'source-2'],
    baseline: 'Current home-field practice',
    falsification: 'No improvement on held-out home-field data',
    dataAccess: 'Public benchmark with documented access',
    transfer: {
      homeDiscipline: 'Civil engineering', sourceDiscipline: 'Operations research',
      borrowedMethod: 'Robust optimization', targetProblem: 'Infrastructure planning',
      transferMechanism: 'Uncertain-demand constraints map onto capacity planning.',
      assumptions: ['Demand distributions are measurable.'],
      boundaries: ['Only comparable infrastructure layouts.'],
      failureConditions: ['Unobserved demand invalidates the model.'],
      validationPlan: 'Compare with a home-field baseline on held-out layouts.',
      sourceIds: ['source-1', 'source-2'], targetIds: ['target-1', 'target-2'],
    },
    evidenceClaims: [
      { role: 'target-need', claim: 'The target problem matters.', sourceIds: ['target-1'], limitation: 'Abstract only.' },
      { role: 'source-method', claim: 'The method exists in the source field.', sourceIds: ['source-1'], limitation: 'Transfer is unproven.' },
      { role: 'gap', claim: 'The exact transfer may be underexplored.', sourceIds: ['target-2'], limitation: 'Search is not exhaustive.' },
    ],
  };
}

test('requires separate target and source evidence plus bounded transfer', () => {
  assert.doesNotThrow(() => validateResearchDirection(direction(), targetWorks, sourceWorks));
  const wrong = direction();
  wrong.transfer.sourceIds = ['target-1', 'target-2'];
  assert.throws(() => validateResearchDirection(wrong, targetWorks, sourceWorks), /证据不足/);
  const unbounded = direction();
  unbounded.transfer.boundaries = [];
  assert.throws(() => validateResearchDirection(unbounded, targetWorks, sourceWorks), /boundaries/);
  const unsupported = direction();
  unsupported.evidenceClaims[1].sourceIds = ['invented-id'];
  assert.throws(() => validateResearchDirection(unsupported, targetWorks, sourceWorks), /证据不足/);
});

test('blocks transfer when abstracts are missing or disciplines coincide', () => {
  const sameField = direction();
  sameField.transfer.sourceDiscipline = sameField.transfer.homeDiscipline;
  assert.throws(() => validateResearchDirection(sameField, targetWorks, sourceWorks), /相同/);
  assert.throws(() => validateResearchDirection(direction(), targetWorks, sourceWorks.map((work) => ({ ...work, abstract: '' }))), /摘要/);
});

test('independent review must pass every scientific check', () => {
  const review = {
    approved: true,
    checks: { homeDisciplineFit: true, crossDisciplineMechanism: true, evidenceAndGap: true, feasibilityAndData: true, falsifiabilityAndBoundaries: true },
    issues: [], limitations: ['Read source full texts.'],
  };
  assert.doesNotThrow(() => validateTopicReview(review));
  assert.throws(() => validateTopicReview({ ...review, checks: { ...review.checks, evidenceAndGap: false } }), /未通过/);
  assert.throws(() => validateTopicReview({ ...review, approved: false, issues: ['No real data access'] }), /No real data access/);
});
