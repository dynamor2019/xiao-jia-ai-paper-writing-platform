import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PATCH_FILE = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'profiles',
  'web',
  'node_modules',
  '@linxin666',
  'dsh-web-all',
  'cordis.patch.yml',
);

const DISABLED_ROWS = new Set([
  'web-ui-task-board',
  'web-ui-better-sidebar',
  'web-ui-doctor',
  'web-ui-dsh-perf',
  'web-ui-remote-web-ui',
  'web-ui-ssh',
  'web-ui-desktop-launcher',
  'web-ui-git-graph',
  'web-ui-archive-manager',
  'web-ui-pet',
  'web-ui-describe-image',
  'web-ui-skin-center',
]);

function disableRows(source, eol) {
  const lines = source.split(/\r?\n/);
  const output = [];
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output.push(line);
    const match = line.match(/^(\s*)-\s+id:\s+(.+?)\s*$/);
    if (!match) continue;

    const indent = match[1];
    const id = match[2].replace(/^['"]|['"]$/g, '');
    if (!DISABLED_ROWS.has(id)) continue;

    const nextLine = lines[index + 1] ?? '';
    if (nextLine.trim() === 'disabled: true') continue;

    output.push(`${indent}  disabled: true`);
    changed = true;
  }

  return { changed, source: output.join(eol) };
}

export function patchWebAllLite() {
  if (!existsSync(PATCH_FILE)) return false;
  const source = readFileSync(PATCH_FILE, 'utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const result = disableRows(source, eol);
  if (!result.changed) return false;
  writeFileSync(PATCH_FILE, result.source, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(patchWebAllLite() ? 'DSH 全家桶轻量兼容模式已启用。' : 'DSH 全家桶轻量兼容模式无需更新。');
}
