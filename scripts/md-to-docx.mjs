import 'dotenv/config';

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, extname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function usage() {
  console.error('用法: npm run word -- <input.md> [output.docx]');
}

function pandocPath() {
  const configured = process.env.PANDOC_PATH?.trim();
  if (!configured) return 'pandoc';
  if (!existsSync(configured)) throw new Error(`PANDOC_PATH 不存在: ${configured}`);
  return configured;
}

async function main() {
  const input = process.argv[2] ? resolve(process.argv[2]) : '';
  if (!input || !existsSync(input) || extname(input).toLowerCase() !== '.md') {
    usage();
    process.exitCode = 1;
    return;
  }

  const output = resolve(process.argv[3] || input.replace(/\.md$/i, '.docx'));
  await mkdir(dirname(output), { recursive: true });
  const resourcePath = [dirname(input), process.cwd()].join(delimiter);
  const args = [
    input,
    '--from=markdown+tex_math_dollars+tex_math_single_backslash+raw_tex',
    '--to=docx',
    '--standalone',
    '--wrap=none',
    `--resource-path=${resourcePath}`,
    '--output',
    output,
  ];
  const referenceDoc = process.env.PANDOC_REFERENCE_DOC?.trim();
  if (referenceDoc) {
    if (!existsSync(referenceDoc)) throw new Error(`PANDOC_REFERENCE_DOC 不存在: ${referenceDoc}`);
    args.push(`--reference-doc=${referenceDoc}`);
  }

  await execFileAsync(pandocPath(), args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  const result = await stat(output);
  if (result.size === 0) throw new Error('Pandoc 生成了空的 DOCX 文件');
  const { formatPaperQualityReport, validateDocxFile, validateMarkdownPaper } = await import('../dist/plugins/verification/paper-quality-validator.js');
  const sourceReport = validateMarkdownPaper(await readFile(input, 'utf-8'));
  const docxReport = await validateDocxFile(output, sourceReport.metrics);
  const reportPath = output.replace(/\.docx$/i, '.docx-quality-report.md');
  await writeFile(reportPath, formatPaperQualityReport('DOCX Quality Gate', docxReport), 'utf-8');
  if (!docxReport.passed) throw new Error(`DOCX 质量门禁未通过，请查看 ${reportPath}`);
  console.log(`Word 文档已生成: ${output}`);
}

main().catch((error) => {
  console.error(`Word 导出失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
