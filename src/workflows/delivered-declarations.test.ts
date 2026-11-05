import assert from 'node:assert/strict';
import test from 'node:test';
import { consolidateDeliveredDeclarations } from './delivered-declarations.js';

test('consolidation preserves accurate disclosures and removes obsolete duplicate claims', () => {
  const source = '## Data and code availability\n\nLocal archive; rights pending.\n\n## Declaration of AI-assisted preparation\n\nDSH assisted; human approval pending.\n\n## Draft highlights\n\nOld headline.\n\n## Declarations\n\n### Data availability\n\nUnconfirmed public access.\n\n### Use of generative AI\n\nAll content was human validated.\n\n## Highlights\n\nCurrent headline.\n';
  const updated = consolidateDeliveredDeclarations(source);
  assert.match(updated, /### Data availability\n\nLocal archive; rights pending/);
  assert.match(updated, /### Use of generative AI\n\nDSH assisted; human approval pending/);
  assert.ok(!updated.includes('Unconfirmed public access'));
  assert.ok(!updated.includes('All content was human validated'));
  assert.ok(!updated.includes('Old headline'));
  assert.match(updated, /Current headline/);
});
