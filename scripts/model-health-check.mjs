import 'dotenv/config';

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { getRoute } from '../dist/config/model-routing.js';
import { getModelClient } from '../dist/lib/model-client.js';

const TASKS = ['discovery', 'protocol', 'outline', 'writing', 'citation', 'quality', 'qualityCrossReview', 'polish'];

const PROMPT = `Return a concise JSON object with keys ok, diagnosis, and risk.
Task: evaluate whether a paper workflow should block an overclaimed BIM/IFC routing manuscript when references are mismatched, repository is not available, and column-generation pricing is underspecified.
Do not predict acceptance probability.`;

const results = [];

for (const task of TASKS) {
  const route = getRoute(task);
  const started = Date.now();
  console.log(`[check] ${task}: ${route.provider}/${route.model}`);
  try {
    const content = await getModelClient().generate(
      'You are a strict model health probe. Return useful, non-empty diagnostic content only.',
      PROMPT,
      {
        provider: route.provider,
        model: route.model,
        temperature: 0,
        maxTokens: 700,
        timeoutMs: Number(process.env.MODEL_HEALTH_TIMEOUT_MS || 20000),
        maxAttempts: 1,
        minOutputChars: 120,
      }
    );
    const row = {
      task,
      provider: route.provider,
      model: route.model,
      status: 'PASS',
      elapsedMs: Date.now() - started,
      chars: content.trim().length,
      preview: content.trim().slice(0, 220),
    };
    results.push(row);
    console.log(`[pass] ${task}: ${row.elapsedMs} ms, ${row.chars} chars`);
  } catch (error) {
    const row = {
      task,
      provider: route.provider,
      model: route.model,
      status: 'BLOCKED',
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
    results.push(row);
    console.log(`[blocked] ${task}: ${row.elapsedMs} ms, ${row.error}`);
  }
}

const report = [
  '# Model Health Check',
  '',
  `- Checked at: ${new Date().toISOString()}`,
  `- Strict output: ${process.env.MODEL_STRICT_OUTPUT || 'default'}`,
  '',
  '| Task | Route | Status | Latency | Chars | Finding |',
  '|---|---|---:|---:|---:|---|',
  ...results.map((result) => {
    const finding = result.status === 'PASS' ? result.preview : result.error;
    return `| ${result.task} | ${result.provider}/${result.model} | ${result.status} | ${result.elapsedMs} ms | ${result.chars ?? 0} | ${String(finding).replace(/\|/g, '\\|')} |`;
  }),
  '',
].join('\n');

const output = resolve(process.env.PAPER_DATA_ROOT || 'F:\\DSH data', process.env.PAPER_STATE_DIR || '.dsh-state', 'model-health-check.md');
await writeFile(output, report, 'utf8');
console.log(report);
console.log(`Report: ${output}`);
