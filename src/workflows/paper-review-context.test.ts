import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PaperPipeline } from './paper-pipeline.js';

test('scientific context includes validated experiment and propagates integrity failures', async (t) => {
  const pipeline = Object.create(PaperPipeline.prototype) as {
    researchInstructions: () => string;
    loadValidatedResultEvidence: () => Promise<string>;
    scientificReviewInstructions: () => Promise<string>;
    outputDir: string;
  };
  pipeline.outputDir = mkdtempSync(join(tmpdir(), 'dsh-review-context-'));
  t.after(() => rmSync(pipeline.outputDir, { recursive: true, force: true }));
  pipeline.researchInstructions = () => 'Conditional scope; no field measurements';
  pipeline.loadValidatedResultEvidence = async () => 'Result SHA256: bound-result\nFailed outcomes remain null';
  const result = await pipeline.scientificReviewInstructions();
  assert.match(result, /Conditional scope/);
  assert.match(result, /Result SHA256: bound-result/);
  assert.match(result, /Failed outcomes remain null/);
  pipeline.loadValidatedResultEvidence = async () => { throw new Error('Result hash changed'); };
  await assert.rejects(pipeline.scientificReviewInstructions(), /Result hash changed/);
});
