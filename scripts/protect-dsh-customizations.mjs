import 'dotenv/config';

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = resolve(process.env.PAPER_DATA_ROOT || 'F:\\DSH data');
const VAULT_ROOT = resolve(process.env.DSH_CUSTOMIZATION_VAULT || join(DATA_ROOT, '.dsh-state', 'protected-customizations'));
const SNAPSHOT_ROOT = join(VAULT_ROOT, 'snapshot');
const MANIFEST_PATH = join(VAULT_ROOT, 'manifest.json');

const PROTECTED_PATHS = [
  '.env',
  '.env.example',
  'README.md',
  'package.json',
  'scripts/setup-dsh.ps1',
  'scripts/start-dsh-web.mjs',
  'scripts/sync-dsh-runtime.mjs',
  'scripts/install-figures4papers.mjs',
  'scripts/install-pylustrator.ps1',
  'scripts/figures4papers_style.py',
  'scripts/open_with_pylustrator.py',
  'scripts/cleanup-dsh-data.mjs',
  'scripts/install-dsh-cleanup-task.ps1',
  'scripts/protect-dsh-customizations.mjs',
  'scripts/update-dsh-safe.ps1',
  'scripts/patch-dsh-continue-button.mjs',
  'scripts/patch-dsh-edit-recovery.mjs',
  'scripts/patch-dsh-empty-tool-call.mjs',
  'scripts/patch-dsh-full-access-tools.mjs',
  'scripts/patch-dsh-incompatible-ui-bundles.mjs',
  'scripts/patch-dsh-journal-ui.mjs',
  'scripts/patch-dsh-todo-status.mjs',
  'scripts/patch-dsh-univer-execute.mjs',
  'scripts/patch-dsh-web-all-lite.mjs',
  'scripts/patch-dsh-branding.mjs',
  'scripts/patch-dsh-workbench-docx-preview.mjs',
  'scripts/patch-dsh-workbench-floating.mjs',
  'scripts/patch-dsh-workbench-pylustrator.mjs',
  'config/dsh',
  '.dsh/skills',
  'src/config',
  'src/lib/model-client.ts',
  'src/lib/literature-balance.ts',
  'src/plugins/export',
  'src/plugins/research/research-lifecycle.ts',
  'src/plugins/verification',
  'src/workflows/paper-pipeline.ts',
  'docs/dsh-customization-protection.md',
];

async function listFiles(inputPath) {
  const absolutePath = resolve(PROJECT_ROOT, inputPath);
  if (!existsSync(absolutePath)) return [];
  const pathStat = await stat(absolutePath);
  if (pathStat.isFile()) return [inputPath.replaceAll('\\', '/')];
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(inputPath, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      files.push(...await listFiles(child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

async function collectFiles() {
  const files = new Set();
  for (const item of PROTECTED_PATHS) {
    for (const file of await listFiles(item)) files.add(file);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function copyFileToSnapshot(file) {
  const source = resolve(PROJECT_ROOT, file);
  const target = resolve(SNAPSHOT_ROOT, file);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { force: true });
}

async function snapshot() {
  const files = await collectFiles();
  await rm(SNAPSHOT_ROOT, { recursive: true, force: true });
  await mkdir(SNAPSHOT_ROOT, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    snapshotRoot: SNAPSHOT_ROOT,
    files: [],
  };
  for (const file of files) {
    await copyFileToSnapshot(file);
    manifest.files.push({
      path: file,
      sha256: await sha256(resolve(PROJECT_ROOT, file)),
    });
  }
  await mkdir(VAULT_ROOT, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`已保护 ${manifest.files.length} 个定制文件 -> ${VAULT_ROOT}`);
}

async function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`没有保护快照，请先运行 npm run custom:protect。缺失: ${MANIFEST_PATH}`);
  }
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
}

async function verify() {
  const manifest = await readManifest();
  const changes = [];
  for (const item of manifest.files) {
    const current = resolve(PROJECT_ROOT, item.path);
    if (!existsSync(current)) {
      changes.push({ path: item.path, status: 'missing' });
      continue;
    }
    const currentHash = await sha256(current);
    if (currentHash !== item.sha256) changes.push({ path: item.path, status: 'changed' });
  }
  if (changes.length === 0) {
    console.log(`定制保护校验通过: ${manifest.files.length} 个文件未被篡改。`);
    return;
  }
  console.log(`发现 ${changes.length} 个定制文件与保护快照不一致:`);
  for (const change of changes) console.log(`- ${change.status}: ${change.path}`);
  process.exitCode = 1;
}

async function restore() {
  const manifest = await readManifest();
  let restored = 0;
  for (const item of manifest.files) {
    const source = resolve(SNAPSHOT_ROOT, item.path);
    if (!existsSync(source)) continue;
    const target = resolve(PROJECT_ROOT, item.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { force: true });
    restored += 1;
  }
  console.log(`已从保护快照恢复 ${restored} 个文件。`);
}

const command = process.argv[2] || 'snapshot';
if (command === 'snapshot') await snapshot();
else if (command === 'verify') await verify();
else if (command === 'restore') await restore();
else {
  console.error(`未知命令: ${command}`);
  console.error('用法: node scripts/protect-dsh-customizations.mjs [snapshot|verify|restore]');
  process.exit(2);
}
