import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultDataRoot() {
  return join(process.env.USERPROFILE || homedir(), 'Documents', 'XiaoJiaAI Data');
}

export function resolveDataRoot() {
  return resolve(process.env.PAPER_DATA_ROOT || defaultDataRoot());
}
