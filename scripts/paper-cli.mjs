import 'dotenv/config';

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { PROJECT_ROOT } from './project-paths.mjs';
import { resolvePaperModelEnv } from './paper-model-env.mjs';

const cli = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const pipeline = join(PROJECT_ROOT, 'src', 'workflows', 'paper-pipeline.ts');
const child = spawn(process.execPath, [cli, pipeline, ...process.argv.slice(2)], {
  cwd: PROJECT_ROOT,
  env: resolvePaperModelEnv(),
  stdio: 'inherit',
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
