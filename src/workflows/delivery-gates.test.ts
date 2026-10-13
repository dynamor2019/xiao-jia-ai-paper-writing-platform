import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryGateStatuses } from './delivery-gates.js';

test('report existence and PASS words outside a status line cannot clear delivery', () => {
  const statuses = deliveryGateStatuses({ data: 'We hope to PASS', citations: '', quality: 'Status: BLOCKED\nPASS appears in a rule',
    scientific: 'Verdict: PASS\nManuscript gate: BLOCKED', docx: '', finalCitations: '', finalScientific: '' });
  assert.ok(Object.values(statuses).every((passed) => !passed));
});

test('all actual gate reports must be clear, including final citations and final review', () => {
  const citations = '- 总引用数: 18\n- 已验证: 18\n';
  const reports = { data: '- Status: PASS', citations, quality: 'Status: PASS', scientific: 'Manuscript gate: CLEAR',
    docx: 'Status: PASS', finalCitations: `${citations}\nStatus: PASS`, finalScientific: 'Manuscript gate: CLEAR' };
  assert.ok(Object.values(deliveryGateStatuses(reports)).every(Boolean));
  reports.finalScientific = 'Manuscript gate: BLOCKED';
  assert.equal(deliveryGateStatuses(reports).finalScientific, false);
});
