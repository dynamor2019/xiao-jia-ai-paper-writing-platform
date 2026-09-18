import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_DESCRIPTION = 'description: "Execute Univer Facade JavaScript and commit mutations to a draft agent worktree. Use code only for small snippets; prefer codeFile for multi-line or reusable programs. Provide exactly one of code or codeFile.",';
const PATCHED_DESCRIPTION = 'description: "Execute a saved Univer Facade JavaScript file and commit mutations to a draft agent worktree. Save the program first, then provide codeFile.",';
const ORIGINAL_PARAMETERS = `      code: { type: "string", description: "Small Facade API JavaScript snippet. Mutually exclusive with codeFile." },
      codeFile: { type: "string", description: "Workspace-relative or absolute JavaScript body file to execute. Preferred for multi-line code; mutually exclusive with code." },`;
const PATCHED_PARAMETERS = '      codeFile: { type: "string", required: true, description: "Workspace-relative or absolute JavaScript body file to execute." },';
const ORIGINAL_INSPECT_RANGE = '        ...args.range === void 0 ? {} : { range: args.range },';
const PATCHED_INSPECT_RANGE = '        ...typeof args.range !== "string" || args.range.trim().length === 0 ? {} : { range: args.range },';

const REPLACEMENTS = [
  [ORIGINAL_DESCRIPTION, PATCHED_DESCRIPTION],
  [ORIGINAL_PARAMETERS, PATCHED_PARAMETERS],
  [ORIGINAL_INSPECT_RANGE, PATCHED_INSPECT_RANGE],
];

function patchRuntime(filePath) {
  const source = readFileSync(filePath, 'utf8');
  let patched = source;
  for (const [original, replacement] of REPLACEMENTS) {
    if (patched.includes(replacement)) {
      continue;
    }
    if (!patched.includes(original)) {
      throw new Error(`Univer schema changed; compatibility patch cannot be applied: ${filePath}`);
    }
    patched = patched.replace(original, replacement);
  }
  if (patched === source) {
    return false;
  }
  writeFileSync(filePath, patched, 'utf8');
  return true;
}

export function patchUniverExecuteSchema() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const targets = [
    join(process.cwd(), 'node_modules', 'dsh-univer-office', 'lib', 'index.js'),
    join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-univer-office', 'lib', 'index.js'),
  ];
  return targets.filter((target) => existsSync(target) && patchRuntime(target)).length;
}
