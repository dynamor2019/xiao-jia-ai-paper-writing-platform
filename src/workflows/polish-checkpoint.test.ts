import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCanonicalSections } from './canonical-draft.js';
import { polishWithCheckpoints } from './polish-checkpoint.js';

/** Create two paragraphs and a framed asset without network requests. */
function sections() {
  return parseCanonicalSections('# Source\n\n## Method\n<!-- PARAGRAPH: M01 -->\nA supplied score is 2.0 [1].\n<!-- PARAGRAPH: M02 -->\nA finite test.\n### Table 1. Score\n| Score |\n|---|\n| 2.0 |\n## References\n[1] Source\n');
}

test('unsafe cosmetic changes retain scientific values and assets, then continue', async () => {
  const items = sections();
  let calls = 0;
  let saves = 0;
  await polishWithCheckpoints(items, async (item) => {
    calls++;
    return item.content.replace('2.0', '1.0').replace('finite', 'bounded');
  }, () => { saves++; });
  assert.match(items[0].content, /2\.0/);
  assert.match(items[1].content, /bounded/);
  assert.equal(calls, 2);
  assert.equal(saves, 3);
  await polishWithCheckpoints(items, async () => { throw new Error('Already saved'); }, () => {});
});

test('interrupted polishing resumes only unsaved paragraphs', async () => {
  const items = sections();
  await assert.rejects(polishWithCheckpoints(items, async (item) => {
    if (item.id === 'M02') throw new Error('Interrupted');
    return item.content.replace('supplied', 'declared');
  }, () => {}), /Interrupted/);
  const retried: string[] = [];
  await polishWithCheckpoints(items, async (item) => {
    retried.push(item.id);
    return item.content;
  }, () => {});
  assert.deepEqual(retried, ['M02']);
});

test('checkpoint write failures do not mark a paragraph completed', async () => {
  const items = sections();
  const original = items[0].content;
  await assert.rejects(polishWithCheckpoints(items, async (item) => item.content.replace('supplied', 'declared'),
    () => { throw new Error('Disk failure'); }), /Disk failure/);
  assert.equal(items[0].content, original);
});
