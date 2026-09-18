import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOL_FS_TARGET = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-tool-fs',
  'lib',
  'index.js',
);

const FS_LOCAL_TARGET = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-fs-local',
  'lib',
  'index.js',
);

const PATCH_MARKER = 'FS_EDIT_NOT_FOUND: "read the current file content, copy an exact old_string from it, then retry the edit"';
const FUZZY_PATCH_MARKER = 'function applyWhitespaceTolerantEdit(content, oldNorm, newNorm, replaceAll, displayPath) {';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`无法定位 DSH 编辑恢复补丁 ${label} 插入点`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`DSH 编辑恢复补丁 ${label} 插入点不唯一`);
  }
  return source.replace(needle, replacement);
}

function patchToolFs() {
  let source = readFileSync(TOOL_FS_TARGET, 'utf8');
  if (source.includes(PATCH_MARKER)) return false;

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const remediesAnchor = [
    'const REMEDIES = {',
    '\tFS_STALE_VERSION: "re-read the file, then retry",',
    '\tFS_NOT_OBSERVED: "read the file, then retry"',
    '};',
  ].join(eol);
  const remediesReplacement = [
    'const REMEDIES = {',
    '\tFS_STALE_VERSION: "re-read the file, then retry",',
    '\tFS_NOT_OBSERVED: "read the file, then retry",',
    `\t${PATCH_MARKER}`,
    '};',
  ].join(eol);
  source = replaceOnce(source, remediesAnchor, remediesReplacement, '错误恢复映射');

  const promptAnchor = 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.';
  const promptReplacement = `${promptAnchor} If an edit reports old_string was not found, do not guess from memory: immediately read the current target file, copy the smallest exact current block that contains the intended change, and retry once with that exact old_string.`;
  source = replaceOnce(source, promptAnchor, promptReplacement, '系统提示');

  const descriptionAnchor = 'Literal text to replace. Must match exactly.';
  const descriptionReplacement = 'Literal text to replace. Must match exactly; after an old_string-not-found error, read the current file and copy an exact current block before retrying.';
  source = replaceOnce(source, descriptionAnchor, descriptionReplacement, '参数说明');

  writeFileSync(TOOL_FS_TARGET, source, 'utf8');
  return true;
}

function patchFsLocal() {
  let source = readFileSync(FS_LOCAL_TARGET, 'utf8');
  if (source.includes(FUZZY_PATCH_MARKER)) return false;

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const helperAnchor = 'function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {';
  const helper = [
    'function foldWhitespaceForEdit(text) {',
    '\tconst chars = [];',
    '\tconst spans = [];',
    '\tlet index = 0;',
    '\twhile (index < text.length) {',
    '\t\tif (/\\s/.test(text[index])) {',
    '\t\t\tconst start = index;',
    '\t\t\twhile (index < text.length && /\\s/.test(text[index])) index += 1;',
    '\t\t\tchars.push(" ");',
    '\t\t\tspans.push([start, index]);',
    '\t\t} else {',
    '\t\t\tchars.push(text[index]);',
    '\t\t\tspans.push([index, index + 1]);',
    '\t\t\tindex += 1;',
    '\t\t}',
    '\t}',
    '\treturn { text: chars.join(""), spans };',
    '}',
    'function applyWhitespaceTolerantEdit(content, oldNorm, newNorm, replaceAll, displayPath) {',
    '\tconst foldedContent = foldWhitespaceForEdit(content);',
    '\tconst foldedOld = foldWhitespaceForEdit(oldNorm).text;',
    '\tif (foldedOld.trim().length === 0) return void 0;',
    '\tconst matches = [];',
    '\tlet searchFrom = 0;',
    '\twhile (true) {',
    '\t\tconst found = foldedContent.text.indexOf(foldedOld, searchFrom);',
    '\t\tif (found < 0) break;',
    '\t\tmatches.push(found);',
    '\t\tsearchFrom = found + Math.max(1, foldedOld.length);',
    '\t}',
    '\tif (matches.length === 0) return void 0;',
    '\tif (!replaceAll && matches.length > 1) throw new FsError(`old_string matched ${matches.length} whitespace-normalized times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, "FS_AMBIGUOUS_EDIT");',
    '\tlet edited = "";',
    '\tlet cursor = 0;',
    '\tfor (const match of matches) {',
    '\t\tconst start = foldedContent.spans[match][0];',
    '\t\tconst end = foldedContent.spans[match + foldedOld.length - 1][1];',
    '\t\tedited += content.slice(cursor, start) + newNorm;',
    '\t\tcursor = end;',
    '\t}',
    '\tedited += content.slice(cursor);',
    '\treturn { content: edited, replacements: matches.length };',
    '}',
    helperAnchor,
  ].join(eol);
  source = replaceOnce(source, helperAnchor, helper, '空白容错函数');

  const editAnchor = 'if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, "FS_EDIT_NOT_FOUND");';
  const editReplacement = 'if (replacements === 0) {' + eol
    + '\t\tconst fuzzy = applyWhitespaceTolerantEdit(content, oldNorm, newNorm, replaceAll, displayPath);' + eol
    + '\t\tif (fuzzy) return fuzzy;' + eol
    + '\t\tthrow new FsError(`old_string was not found in "${displayPath}"`, "FS_EDIT_NOT_FOUND");' + eol
    + '\t}';
  source = replaceOnce(source, editAnchor, editReplacement, '严格替换失败分支');

  writeFileSync(FS_LOCAL_TARGET, source, 'utf8');
  return true;
}

export function patchEditRecovery() {
  const patchedToolFs = patchToolFs();
  const patchedFsLocal = patchFsLocal();
  return patchedToolFs || patchedFsLocal;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  console.log(patchEditRecovery() ? 'DSH 编辑恢复补丁已安装。' : 'DSH 编辑恢复补丁已存在。');
}
