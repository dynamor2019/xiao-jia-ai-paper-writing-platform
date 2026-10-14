import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reconcileReproducibilityResult } from './result-artifact.js';

test('reproducibility manifest replaces only a byte-identical generated result copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-result-artifact-'));
  try {
    const source = join(root, 'experiments', 'results', 'result.csv');
    const directory = join(root, 'milestones', 'reproducibility', 'results');
    const copy = join(directory, 'result.csv');
    await mkdir(join(source, '..'), { recursive: true });
    await mkdir(directory, { recursive: true });
    await writeFile(source, 'id,value\n1,2\n');
    await writeFile(copy, 'id,value\n1,2\n');

    assert.equal(await reconcileReproducibilityResult(root, source), 'duplicate-removed');
    assert.equal(await stat(copy).catch(() => null), null);
    const manifest = JSON.parse(await readFile(join(directory, 'source-manifest.json'), 'utf8'));
    assert.equal(manifest.managedBy, 'dsh-paper-pipeline');
    assert.equal(manifest.sourcePath, 'experiments/results/result.csv');
    assert.equal(manifest.bytes, 13);
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/);

    await writeFile(copy, 'different historical content');
    assert.equal(await reconcileReproducibilityResult(root, source), 'different-copy-retained');
    assert.equal(await readFile(copy, 'utf8'), 'different historical content');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reproducibility reconciliation refuses outside sources and unmanaged manifest collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-result-artifact-'));
  const outside = await mkdtemp(join(tmpdir(), 'dsh-result-outside-'));
  try {
    const source = join(root, 'experiments', 'results', 'result.csv');
    const directory = join(root, 'milestones', 'reproducibility', 'results');
    const copy = join(directory, 'result.csv');
    await mkdir(join(source, '..'), { recursive: true });
    await mkdir(directory, { recursive: true });
    await writeFile(source, 'same bytes');
    await writeFile(copy, 'same bytes');
    await writeFile(join(outside, 'external.csv'), 'outside');
    await writeFile(join(directory, 'source-manifest.json'), '{"authorOwned":true}\n');

    await assert.rejects(reconcileReproducibilityResult(root, join(outside, 'external.csv')), /regular project file|outside the paper project/);
    await assert.rejects(reconcileReproducibilityResult(root, source), /non-pipeline/);
    assert.equal(await readFile(copy, 'utf8'), 'same bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('shared processed results are referenced by URI and hash without copying into the paper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-result-artifact-'));
  const sharedRoot = await mkdtemp(join(tmpdir(), 'dsh-shared-results-'));
  try {
    const source = join(sharedRoot, 'processed', 'paper-01', 'run-01', 'result.json');
    await mkdir(join(source, '..'), { recursive: true });
    await writeFile(source, '{"estimate":null}\n');
    const copy = join(root, 'milestones', 'reproducibility', 'results', 'result.json');
    await mkdir(join(copy, '..'), { recursive: true });
    await writeFile(copy, '{"estimate":null}\n');
    assert.equal(await reconcileReproducibilityResult(root, source, {
      sharedDataRoot: sharedRoot, sharedDataScope: 'paper-01',
    }), 'duplicate-removed');
    const manifestPath = join(root, 'milestones', 'reproducibility', 'results', 'source-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.sourcePath, '@shared/processed/paper-01/run-01/result.json');
    assert.equal(manifest.bytes, 18);
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(source, 'utf8'), '{"estimate":null}\n');
    assert.equal(await stat(copy).catch(() => null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sharedRoot, { recursive: true, force: true });
  }
});
