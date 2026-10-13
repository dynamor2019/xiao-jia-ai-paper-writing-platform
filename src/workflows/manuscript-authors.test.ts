import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAuthorBlock, sanitizeAuthorForm } from '../../config/dsh/web/manuscript-authors.mjs';

test('a blank author form stays blank and does not invent a person', () => {
  assert.deepEqual(sanitizeAuthorForm(undefined), [{ name: '', rank: '1', email: '', affiliation: '' }]);
  assert.equal(renderAuthorBlock([{ name: '   ', rank: '1c', email: 'not-an-email', affiliation: '' }]), '');
});

test('named authors enter the draft in rank order with affiliation and corresponding email', () => {
  const block = renderAuthorBlock([
    { name: 'Second Author', rank: '2', email: 'second@example.edu', affiliation: 'School of Engineering, Example University' },
    { name: 'Lead Author', rank: '1c', email: 'lead@example.edu', affiliation: 'School of Engineering, Example University' },
    { name: '  ', rank: '3', email: 'ignored@example.edu', affiliation: 'Should not appear' },
  ]);
  assert.match(block, /^Lead Author a,\*, Second Author a$/m);
  assert.match(block, /^a School of Engineering, Example University$/m);
  assert.match(block, /^Lead Author: lead@example\.edu$/m);
  assert.match(block, /^Second Author: second@example\.edu$/m);
  assert.match(block, /^\* Corresponding author: Lead Author$/m);
  assert.doesNotMatch(block, /Should not appear|ignored@example\.edu/);
});
