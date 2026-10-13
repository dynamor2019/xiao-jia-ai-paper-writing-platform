import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deliveryReviewEvidence } from './delivery-review-evidence.js';

/** Prepare hash-bound local evidence without invoking converters or models. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delivery-evidence-'));
  mkdirSync(join(root, 'delivery'));
  const bind = (path: string, content: string) => {
    writeFileSync(join(root, path), content);
    return { path, sha256: createHash('sha256').update(content).digest('hex') };
  };
  const binding = {
    archive: bind('delivery/support.zip', 'already verified archive'),
    manifest: bind('delivery/manifest.json', JSON.stringify({ files: [{}], result_sha256: 'original', replay_result_sha256: 'original' })),
    tests: bind('delivery/tests.log', 'Ran 15 tests\nOK'),
    verifiedArchiveFiles: 1,
  };
  const save = () => writeFileSync(join(root, 'delivery/review-evidence-binding.json'), JSON.stringify(binding));
  save();
  return { root, binding, save };
}

test('optional delivery evidence is absent without a binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evidence-absent-'));
  try { assert.equal(deliveryReviewEvidence(root), ''); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('bound delivery log is evidence, not scientific or submission approval', () => {
  const { root } = fixture();
  try {
    const evidence = deliveryReviewEvidence(root);
    assert.ok(evidence.includes('Ran 15 tests\nOK'));
    assert.ok(evidence.includes('Archive entries verified against manifest: 1'));
    assert.ok(evidence.includes('submission approval remain unresolved'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changed delivery artifacts fail closed', () => {
  const { root } = fixture();
  try {
    writeFileSync(join(root, 'delivery/tests.log'), 'unverified replacement');
    assert.throws(() => deliveryReviewEvidence(root), /hash changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manifest count mismatches fail closed', () => {
  const { root, binding, save } = fixture();
  try {
    binding.verifiedArchiveFiles = 2;
    save();
    assert.throws(() => deliveryReviewEvidence(root), /count changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('evidence paths cannot escape the project', () => {
  const { root, binding, save } = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-evidence-'));
  try {
    const path = join(outside, 'external.zip');
    writeFileSync(path, 'external');
    binding.archive.path = path;
    save();
    assert.throws(() => deliveryReviewEvidence(root), /escapes the project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
