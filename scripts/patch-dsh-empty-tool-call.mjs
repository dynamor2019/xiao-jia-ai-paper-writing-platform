import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TARGET = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-llm-pi-ai',
  'lib',
  'index.js',
);
const PATCH_MARKER = 'const REQUIRED_ARGUMENT_TOOLS = /* @__PURE__ */ new Set(["pwsh", "bash", "write", "edit", "read"]);';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`无法定位 DSH 空工具调用 ${label} 插入点`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`DSH 空工具调用 ${label} 插入点不唯一`);
  }
  return source.replace(needle, replacement);
}

export function patchEmptyToolCallRetry() {
  let source = readFileSync(TARGET, 'utf8');
  if (source.includes(PATCH_MARKER)) return false;

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const helperAnchor = 'function mapStopReason(message, contextWindow) {';
  const helper = [
    PATCH_MARKER,
    'function emptyRequiredToolCall(message) {',
    '\tif (message.stopReason !== "toolUse") return void 0;',
    '\treturn message.content.find((block) => block.type === "toolCall" && REQUIRED_ARGUMENT_TOOLS.has(block.name) && (typeof block.arguments !== "object" || block.arguments === null || Object.keys(block.arguments).length === 0));',
    '}',
    helperAnchor,
  ].join(eol);
  source = replaceOnce(source, helperAnchor, helper, '检测函数');

  const reasonAnchor = [
    '\tif (piAiOverflow || harnessOverflow) return {',
    '\t\tkind: "error",',
    '\t\tfailure: {',
    '\t\t\tmessage: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,',
    '\t\t\tcode: CONTEXT_WINDOW_EXCEEDED_CODE',
    '\t\t}',
    '\t};',
  ].join(eol);
  const reasonReplacement = [
    reasonAnchor,
    '\tconst emptyToolCall = emptyRequiredToolCall(message);',
    '\tif (emptyToolCall !== void 0) return {',
    '\t\tkind: "error",',
    '\t\tfailure: {',
    '\t\t\tmessage: `model "${message.model}" returned empty arguments for required tool "${emptyToolCall.name}"`,',
    '\t\t\tcode: EMPTY_RESPONSE_CODE',
    '\t\t}',
    '\t};',
  ].join(eol);
  source = replaceOnce(source, reasonAnchor, reasonReplacement, '重试分类');

  writeFileSync(TARGET, source, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  console.log(patchEmptyToolCallRetry() ? 'DSH 空工具调用重试补丁已安装。' : 'DSH 空工具调用重试补丁已存在。');
}
