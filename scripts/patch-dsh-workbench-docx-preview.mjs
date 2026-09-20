import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKBENCH_ROOT = resolve(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'profiles',
  'web',
  'node_modules',
  'dsh-workbench',
);
const HOST_WORKSPACE_PATH = join(WORKBENCH_ROOT, 'lib', 'host', 'workspace.js');
const CLIENT_KIND_PATH = join(WORKBENCH_ROOT, 'lib', 'client', 'preview', 'preview-kind.js');
const CLIENT_BUNDLE_PATH = join(WORKBENCH_ROOT, 'lib', 'client.js');

const MARKER = 'dsh-workbench-docx-preview';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`无法定位 ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`${label} 不唯一`);
  }
  return source.replace(needle, replacement);
}

function patchHostWorkspace() {
  if (!existsSync(HOST_WORKSPACE_PATH)) return false;
  let source = readFileSync(HOST_WORKSPACE_PATH, 'utf8');
  let changed = false;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  if (!source.includes('node:child_process')) {
    source = source.replace(
      'import { readdir, readFile, stat } from "node:fs/promises";',
      'import { spawn } from "node:child_process";\nimport { readdir, readFile, stat } from "node:fs/promises";',
    );
    changed = true;
  }

  if (!source.includes(MARKER)) {
    const helper = [
      `const DOCX_PREVIEW_MARKER = "${MARKER}";`,
      'const DOCX_PREVIEW_EXTENSIONS = new Set(["docx"]);',
      'const DOCX_PREVIEW_MAX_BYTES = 12_000_000;',
      'const PANDOC_BIN = process.env.PANDOC_PATH || "pandoc";',
      'function markdownError(title, message) {',
      '    return `# ${title}\\n\\n${message}`;',
      '}',
      'function convertDocxToMarkdown(absolute) {',
      '    void DOCX_PREVIEW_MARKER;',
      '    return new Promise((resolve) => {',
      '        const child = spawn(PANDOC_BIN, [absolute, "--from=docx", "--to=gfm"], { stdio: ["ignore", "pipe", "pipe"] });',
      '        let stdout = "";',
      '        let stderr = "";',
      '        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });',
      '        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });',
      '        child.on("error", (error) => {',
      '            resolve(markdownError("Word preview unavailable", `Pandoc failed to start: ${error.message}`));',
      '        });',
      '        child.on("close", (code) => {',
      '            if (code !== 0) {',
      '                resolve(markdownError("Word preview unavailable", stderr.trim() || `Pandoc exited with code ${code}`));',
      '                return;',
      '            }',
      '            resolve(stdout.trim() || "(Word document is empty.)");',
      '        });',
      '    });',
      '}',
      '',
    ].join(eol);
    source = source.replace('const nodeReader = {', `${helper}const nodeReader = {`);
    changed = true;
  }

  const oldReadFile = [
    '    readFile(absolute) {',
    '        return readFile(absolute, "utf8");',
    '    },',
  ].join(eol);
  const newReadFile = [
    '    async readFile(absolute) {',
    '        if (absolute.toLowerCase().endsWith(".docx"))',
    '            return convertDocxToMarkdown(absolute);',
    '        return readFile(absolute, "utf8");',
    '    },',
  ].join(eol);
  if (source.includes(oldReadFile)) {
    source = replaceOnce(source, oldReadFile, newReadFile, 'Word 读取逻辑');
    changed = true;
  }

  const oldPreviewLimit = [
    '                const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"].includes(extension);',
    '                if (!info.isFile || info.size > (isImage ? imageMaxBytes : maxBytes)) {',
  ].join(eol);
  const newPreviewLimit = [
    '                const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"].includes(extension);',
    '                const isDocx = DOCX_PREVIEW_EXTENSIONS.has(extension);',
    '                const previewLimit = isImage ? imageMaxBytes : isDocx ? Math.max(maxBytes, DOCX_PREVIEW_MAX_BYTES) : maxBytes;',
    '                if (!info.isFile || info.size > previewLimit) {',
  ].join(eol);
  if (source.includes(oldPreviewLimit)) {
    source = replaceOnce(source, oldPreviewLimit, newPreviewLimit, 'Word 预览大小限制');
    changed = true;
  }

  if (changed) writeFileSync(HOST_WORKSPACE_PATH, source, 'utf8');
  return changed;
}

function patchMarkdownExtensions(filePath) {
  if (!existsSync(filePath)) return false;
  let source = readFileSync(filePath, 'utf8');
  if (source.includes('"docx"')) return false;

  const next = source.replace(
    /const MARKDOWN_EXTENSIONS = (?:\/\* @__PURE__ \*\/ )?new Set\(\[\s*"md",\s*"markdown",\s*"mdx"\s*\]\);/g,
    (match) => match.replace('"mdx"', '"mdx", "docx"'),
  );
  if (next === source) throw new Error(`无法定位 ${filePath} 的 Markdown 扩展列表`);
  writeFileSync(filePath, next, 'utf8');
  return true;
}

export function patchWorkbenchDocxPreview() {
  return [
    patchHostWorkspace(),
    patchMarkdownExtensions(CLIENT_KIND_PATH),
    patchMarkdownExtensions(CLIENT_BUNDLE_PATH),
  ].filter(Boolean).length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changed = patchWorkbenchDocxPreview();
  console.log(changed > 0 ? `dsh-workbench Word 预览已安装（${changed} 个文件）。` : 'dsh-workbench Word 预览已存在或未安装。');
}
