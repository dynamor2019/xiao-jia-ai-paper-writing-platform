/**
 * 本地打包入口：把 electron-builder 输出目录放到仓库外部的数据根，
 * 避免每次打包往项目目录里堆 1GB 的 win-unpacked 中间产物。
 *
 * 用法：
 *   node scripts/package-desktop.mjs [--dir] [--dry-run]
 *   DESKTOP_OUTPUT_DIR=<自定义目录> node scripts/package-desktop.mjs
 *
 * 默认输出：<数据根>/release（数据根由 PAPER_DATA_ROOT 或 scripts/project-paths.mjs 解析）
 * GitHub Actions 仍使用 npm run desktop:pack:github，保持仓库内 release 目录语义不变。
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot } from './project-paths.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER_CLI = join(PROJECT_ROOT, 'node_modules', 'electron-builder', 'cli.js');

function parseArgs(argv) {
  return {
    dirOnly: argv.includes('--dir'),
    dryRun: argv.includes('--dry-run'),
  };
}

function resolveOutputDir() {
  const fromEnv = process.env.DESKTOP_OUTPUT_DIR?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : join(resolveDataRoot(), 'release');
  return resolve(base);
}

async function main() {
  const { dirOnly, dryRun } = parseArgs(process.argv.slice(2));
  const outputDir = resolveOutputDir();

  const args = [BUILDER_CLI];
  if (dirOnly) {
    args.push('--dir', '--win', '--x64');
  } else {
    args.push('--win', 'portable', '--x64');
  }
  args.push(`-c.directories.output=${outputDir}`);

  console.log(`[打包输出] ${outputDir}`);
  if (dryRun) {
    console.log(`[dry-run] node ${args.join(' ')}`);
    return;
  }

  mkdirSync(outputDir, { recursive: true });

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: 'inherit' });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`electron-builder 退出码 ${code}`));
    });
  });

  console.log(`\n打包完成，文件在 ${outputDir}`);
}

main().catch((error) => {
  console.error(`打包失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
