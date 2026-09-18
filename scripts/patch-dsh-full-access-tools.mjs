import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCHES = [
  {
    path: ['@deepseek-ai', 'dsh-tool-pwsh', 'lib', 'index.js'],
    original: 'const escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS;',
    legacy: 'const escalationModes = defaultMode === void 0 || process.env.DSH_PERMISSION_MODE === "danger-full-access" ? [] : ESCALATION_TARGETS;',
    patched: 'const escalationModes = [];',
  },
  {
    path: ['@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js'],
    original: 'const escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS;',
    legacy: 'const escalationModes = defaultMode === void 0 || process.env.DSH_PERMISSION_MODE === "danger-full-access" ? [] : ESCALATION_TARGETS;',
    patched: 'const escalationModes = [];',
  },
  {
    path: ['@deepseek-ai', 'dsh-tool-fs', 'lib', 'index.js'],
    original: 'this.escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS;',
    legacy: 'this.escalationModes = defaultMode === void 0 || process.env.DSH_PERMISSION_MODE === "danger-full-access" ? [] : ESCALATION_TARGETS;',
    patched: 'this.escalationModes = [];',
  },
];

export function patchFullAccessToolSchemas() {
  if (process.env.DSH_PERMISSION_MODE !== 'danger-full-access') {
    return 0;
  }

  let changed = 0;
  for (const patch of PATCHES) {
    const filePath = join(process.cwd(), 'node_modules', ...patch.path);
    const source = readFileSync(filePath, 'utf8');
    if (source.includes(patch.patched)) {
      continue;
    }
    const replaceable = [patch.original, patch.legacy].find((candidate) => source.includes(candidate));
    if (!replaceable) {
      throw new Error(`DSH tool schema changed; full-access patch cannot be applied: ${filePath}`);
    }
    writeFileSync(filePath, source.replace(replaceable, patch.patched), 'utf8');
    changed += 1;
  }
  return changed;
}
