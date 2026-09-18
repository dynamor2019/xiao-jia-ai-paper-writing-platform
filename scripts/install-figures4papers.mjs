import 'dotenv/config';

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const REPO_URL = 'https://github.com/ChenLiu-1996/figures4papers.git';

const dataRoot = resolve(process.env.PAPER_DATA_ROOT || 'F:\\DSH data');
const resourceRoot = resolve(process.env.DSH_RESOURCE_ROOT || join(dataRoot, 'resources'));
const targetDir = resolve(process.env.FIGURES4PAPERS_HOME || join(resourceRoot, 'figures4papers'));

await mkdir(resourceRoot, { recursive: true });

if (existsSync(join(targetDir, '.git'))) {
  await execFileAsync('git', ['-C', targetDir, 'pull', '--ff-only'], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  console.log(`figures4papers 已更新: ${targetDir}`);
} else {
  await execFileAsync('git', ['clone', '--depth', '1', REPO_URL, targetDir], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  console.log(`figures4papers 已安装: ${targetDir}`);
}

const skillPath = join(targetDir, 'scientific-figure-making', 'SKILL.md');
if (!existsSync(skillPath)) throw new Error(`figures4papers skill 不完整: ${skillPath}`);

console.log(`figures4papers skill: ${skillPath}`);
