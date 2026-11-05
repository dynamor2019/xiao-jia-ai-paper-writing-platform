import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'const completedWithText = message.stopReason === "stop"';

/** Keep completed answers when a gateway's effective capacity exceeds its local catalog entry. */
export function patchContextOverflowSource(source) {
  if (source.includes(MARKER)) return source;
  const anchor = 'const piAiOverflow = isContextOverflow(message, contextWindow);';
  if (source.split(anchor).length !== 2) throw new Error('Cannot uniquely locate DSH context overflow classification');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return source.replace(anchor, [
    `${MARKER} && !message.errorMessage`,
    '\t\t&& message.content.some(block => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);',
    '\tconst piAiOverflow = !completedWithText && isContextOverflow(message, contextWindow);',
  ].join(eol));
}

/** Apply the response-classification fix without changing requests, credentials or model capacities. */
export function patchContextOverflowClassification(root = process.cwd()) {
  const target = join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');
  const source = readFileSync(target, 'utf8');
  const patched = patchContextOverflowSource(source);
  if (patched === source) return false;
  writeFileSync(target, patched, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(patchContextOverflowClassification() ? 'Context overflow classification patched.' : 'Context overflow patch already present.');
}
