import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModelClient } from '../lib/model-client.js';
import { getRoute } from '../config/model-routing.js';

/** Enforce deletion-only repair: a model may select original sentences, never invent replacements. */
export function selectedOriginalSentences(original: string, keep: unknown): string {
  const sentences = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(original), item => item.segment);
  if (!Array.isArray(keep) || keep.some((index, position) => !Number.isInteger(index) || index < 0
    || index >= sentences.length || (position > 0 && index <= keep[position - 1]))) {
    throw new Error('Invalid original-sentence selection');
  }
  return keep.map(index => sentences[index]).join('').trim();
}

/** Permit one cached evidence selection after bounded free-form repair has exhausted its budget. */
export async function selectEvidenceBoundSentences(original: string, evidence: string, directory: string): Promise<string | undefined> {
  const sentences = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(original), (item, index) => ({ index, text: item.segment }));
  const system = 'Select ONLY original sentences supported by the supplied evidence. Return one JSON object {"keep":[0,2],"reason":"brief source-specific explanation"}. Keep indices in ascending order. Use an empty keep array when none is fully supported. Never retain an entire sentence with partly unsupported numbers, asserted literature gaps, field validation or source attribution. Current-study facts require current-study evidence, not another paper method. This is deletion-only editing; do not write replacement prose.';
  const prompt = JSON.stringify({ sentences, evidence });
  const key = createHash('sha256').update(JSON.stringify({ version: 1, system, prompt, route: getRoute('citation') })).digest('hex');
  const path = join(directory, `${key}.json`);
  let response: string;
  if (existsSync(path)) response = JSON.parse(readFileSync(path, 'utf8')).response;
  else {
    response = await getModelClient().generate(system, prompt, { task: 'citation', temperature: 0, maxTokens: 2048, maxAttempts: 1 });
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, JSON.stringify({ key, response }, null, 2) + '\n');
  }
  try {
    const parsed = JSON.parse(response.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
    if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) return undefined;
    return selectedOriginalSentences(original, parsed.keep);
  } catch {
    console.warn('[Citation extraction] Invalid selection retained in cache; no edit approved');
    return undefined;
  }
}
