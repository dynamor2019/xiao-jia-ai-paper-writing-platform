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

test('requires design-specific empirical manifest evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-results-'));
  try {
    const results = join(directory, 'results.csv');
    const plan = join(directory, 'analysis-plan.md');
    const log = join(directory, 'experiment-run.log');
    const statisticalAudit = join(directory, 'statistical-audit.json');
    const reproductionCheck = join(directory, 'reproduction-check.json');
    const manifest = join(directory, 'empirical-manifest.json');
    const strategy = join(directory, 'strategy.md');
    const pap = join(directory, 'pap.json');
    const table2 = join(directory, 'table2.csv');
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
    await writeEvidence(strategy, '# Strategy\n');
    await writeEvidence(pap, '{"design":"did"}\n');
    await writeEvidence(table2, 'model,estimate\nm1,0.5\n');
    await writeFile(manifest, JSON.stringify({
      design: 'did',
      resultSha256: sha256,
      evidence: {
        strategy: await evidenceRef(strategy),
        pap: await evidenceRef(pap),
      },
      tables: {
        table2_main: await evidenceRef(table2),
      },
      figures: {
        fig2_event_study: { status: 'not_applicable', reason: 'DID requires an event-study figure, so this should fail.' },
      },
    }), 'utf8');

    const validation = await validateExperimentResults(results, directory, {
      analysisPlanFile: plan,
      empiricalManifestFile: manifest,
      experimentLogFile: log,
      requireEmpiricalManifest: true,
      reproductionCheckFile: reproductionCheck,
      requireExecutionEvidence: true,
      statisticalAuditFile: statisticalAudit,
    });
    assert.equal(validation.success, false);
    assert.match(validation.error!, /empirical-figure2-event-study/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('allows documented not-applicable empirical exhibits for non-DID designs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-results-'));
  try {
    const results = join(directory, 'results.csv');
    const plan = join(directory, 'analysis-plan.md');
    const log = join(directory, 'experiment-run.log');
    const statisticalAudit = join(directory, 'statistical-audit.json');
    const reproductionCheck = join(directory, 'reproduction-check.json');
    const manifest = join(directory, 'empirical-manifest.json');
    const strategy = join(directory, 'strategy.md');
    const pap = join(directory, 'pap.json');
    const table2 = join(directory, 'table2.csv');
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
    await writeEvidence(strategy, '# IV Strategy\n');
    await writeEvidence(pap, '{"design":"iv"}\n');
    await writeEvidence(table2, 'model,estimate\n2sls,0.5\n');
    await writeFile(manifest, JSON.stringify({
      design: 'iv',
      resultSha256: sha256,
      evidence: {
        strategy: await evidenceRef(strategy),
        pap: await evidenceRef(pap),
      },
      tables: {
        table2_main: await evidenceRef(table2),
      },
      figures: {
        fig2_event_study: { status: 'not_applicable', reason: 'IV design has no treatment timing dimension.' },
      },
    }), 'utf8');

    const validation = await validateExperimentResults(results, directory, {
      analysisPlanFile: plan,
      empiricalManifestFile: manifest,
      experimentLogFile: log,
      requireEmpiricalManifest: true,
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

async function writeEvidence(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8');
}

async function evidenceRef(path: string): Promise<{ file: string; sha256: string }> {
  const content = await readFile(path);
  return {
    file: path,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}
