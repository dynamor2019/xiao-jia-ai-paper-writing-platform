import assert from 'node:assert/strict';
import test from 'node:test';

import { literatureRecencyStats, selectBalancedLiterature } from './literature-balance.js';
import type { Paper } from '../types.js';

function paper(id: string, year: number, citations = 0): Paper {
  return { id, title: id, authors: [], year, abstract: id, citations, source: 'manual' };
}

test('keeps at least thirty percent recent literature when candidates permit it', () => {
  const candidates = [
    ...Array.from({ length: 12 }, (_, index) => paper(`recent-${index}`, 2026 - (index % 5))),
    ...Array.from({ length: 24 }, (_, index) => paper(`classic-${index}`, 2010 + (index % 10), 100 - index)),
  ];
  const selected = selectBalancedLiterature(candidates, 30, 2026);
  const stats = literatureRecencyStats(selected, 2026);
  assert.equal(selected.length, 30);
  assert.ok(stats.share >= 0.3);
});

test('interleaves recent papers instead of placing them in one block', () => {
  const candidates = [
    ...Array.from({ length: 4 }, (_, index) => paper(`recent-${index}`, 2026)),
    ...Array.from({ length: 8 }, (_, index) => paper(`classic-${index}`, 2015)),
  ];
  const selected = selectBalancedLiterature(candidates, 12, 2026);
  assert.deepEqual(selected.slice(0, 6).map((item) => item.id), [
    'recent-0', 'classic-0', 'classic-1', 'recent-1', 'classic-2', 'classic-3',
  ]);
});
