import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { searchScholarlyWorks, validateExperimentResults } from './research-lifecycle.js';

test('uses Crossref when OpenAlex returns no works', async () => {
  const originalFetch = globalThis.fetch;
  let crossrefCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('api.openalex.org')) {
      return Response.json({ results: [] });
    }
    crossrefCalls += 1;
    return Response.json({
      message: {
        items: Array.from({ length: 6 }, (_, index) => ({
          DOI: `10.1000/test-${index}`,
          URL: `https://doi.org/10.1000/test-${index}`,
          title: [`Paper ${index}`],
          author: [{ given: 'Test', family: 'Author' }],
          published: { 'date-parts': [[2026]] },
          'is-referenced-by-count': index,
        })),
      },
    });
  };

  try {
    const works = await searchScholarlyWorks('data center cooling', 6);
    assert.equal(works.length, 6);
    assert.equal(works[0].id, 'https://doi.org/10.1000/test-0');
    assert.equal(crossrefCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('records hash and schema for machine-readable results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-results-'));
  try {
    const results = join(directory, 'results.csv');
    await writeFile(results, 'instance_id,score\n1,0.5\n2,0.7\n3,0.9\n', 'utf8');
    const validation = await validateExperimentResults(results, directory);
    assert.equal(validation.success, true);
    const report = await readFile(validation.data!, 'utf8');
    assert.match(report, /SHA256: [a-f0-9]{64}/);
    assert.match(report, /Columns: instance_id, score/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects duplicate or untraceable result rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-results-'));
  try {
    const results = join(directory, 'results.csv');
    await writeFile(results, 'method,score\na,0.5\na,0.5\nb,NaN\n', 'utf8');
    const validation = await validateExperimentResults(results, directory);
    assert.equal(validation.success, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires matching successful execution evidence when enabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-results-'));
  try {
    const results = join(directory, 'results.csv');
    const plan = join(directory, 'analysis-plan.md');
    const log = join(directory, 'experiment-run.log');
    const statisticalAudit = join(directory, 'statistical-audit.json');
    const reproductionCheck = join(directory, 'reproduction-check.json');
    const content = 'run_id,score\n1,0.5\n2,0.7\n3,0.9\n';
    await writeFile(plan, '# Frozen Research Protocol\n', 'utf8');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    await writeFile(results, content, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(log, `started=${new Date().toISOString()}\nstatus=SUCCESS\ncommand=test\nresults_file=${results}\nresult_sha256=${sha256}\n`, 'utf8');
    const audit = JSON.stringify({
      status: 'PASS',
      resultSha256: sha256,
      command: 'node audit.js',
      sourceHashes: { 'audit.js': 'a'.repeat(64) },
      checks: [{ name: 'range', status: 'PASS', evidence: 'all values in frozen range' }],
    });
    await writeFile(statisticalAudit, audit, 'utf8');
    await writeFile(reproductionCheck, audit, 'utf8');
    const validation = await validateExperimentResults(results, directory, {
      analysisPlanFile: plan,
      experimentLogFile: log,
      reproductionCheckFile: reproductionCheck,
      requireExecutionEvidence: true,
      statisticalAuditFile: statisticalAudit,
    });
    assert.equal(validation.success, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects prose files as experiment results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-results-'));
  try {
    const results = join(directory, 'results.txt');
    await writeFile(results, 'summary\nvalue\n', 'utf8');
    const validation = await validateExperimentResults(results, directory);
    assert.equal(validation.success, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
