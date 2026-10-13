import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInitialState } from '../config/dsh.config.js';
import { PaperPipeline } from './paper-pipeline.js';

test('pipeline pilot/formal adapter executes project-local code and copies the final numeric-ID log', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-plan-adapter-')));
  try {
    const milestones = join(root, 'milestones');
    const stateDir = join(root, '.dsh-state');
    const logs = join(milestones, 'reproducibility', 'logs');
    for (const path of [milestones, stateDir, logs, join(root, 'code')]) mkdirSync(path, { recursive: true });
    writeFileSync(join(milestones, 'analysis-plan.md'), '# Frozen plan\nA bounded negative-result fixture.');
    writeFileSync(join(root, 'code', 'fixture.mjs'), "import{mkdirSync,writeFileSync}from'node:fs';import{dirname}from'node:path';const p=process.argv[2];mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify([{id:1,value:-1},{id:2,value:-2},{id:3,value:-3}]));");
    const command = (path: string) => `"${process.execPath}" code/fixture.mjs ${path}`;
    const result = 'experiments/results/formal.json';
    writeFileSync(join(milestones, 'experiment-plan.json'), JSON.stringify({ schemaVersion: 1,
      researchQuestion: 'Bounded question', originalHypothesis: 'Positive result',
      pilot: { command: command('experiments/results/pilot.json'), resultsFile: 'experiments/results/pilot.json' },
      batches: [{ id: '1', command: command(result), resultsFile: result, question: 'Test bounded question' }] }));
    const state = createInitialState('Bounded question');
    const pipeline = Object.assign(Object.create(PaperPipeline.prototype), {
      outputDir: root, milestoneDir: milestones, stateDir, logsDir: logs, state,
      loadSelectedTopic: () => ({ researchQuestion: 'Bounded question' }), saveState: () => {},
    }) as { runPlannedExperiments(phase: 'pilot' | 'formal'): Promise<boolean> };
    assert.equal(await pipeline.runPlannedExperiments('pilot'), true);
    assert.equal(await pipeline.runPlannedExperiments('formal'), true);
    assert.equal(state.metadata.resultsFile, join(root, result));
    const log = readFileSync(join(logs, 'experiment-run.log'), 'utf8');
    assert.ok(log.includes(`results_file=${join(root, result)}`));
    assert.ok(!log.includes('results_file=' + join(root, 'experiments/results/pilot.json')));
    const checkpoint = readFileSync(join(stateDir, 'experiment-plan-state.json'), 'utf8');
    await pipeline.runPlannedExperiments('formal');
    assert.equal(readFileSync(join(stateDir, 'experiment-plan-state.json'), 'utf8'), checkpoint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
