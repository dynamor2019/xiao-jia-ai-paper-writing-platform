import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT } from './project-paths.mjs';

const CLIENT_BUNDLE = join(PROJECT_ROOT, 'node_modules', '@deepseek-ai', 'dsh-client-ui-model-selection', 'lib', 'client.js');
const TIMEOUT_MARKER = 'model catalog request timed out';

function replaceOnce(source, needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`无法唯一定位模型列表修复点: ${needle}`);
  }
  return source.replace(needle, replacement);
}

export function patchModelCatalog(filePath = CLIENT_BUNDLE) {
  if (!existsSync(filePath)) return false;
  let source = readFileSync(filePath, 'utf8');
  if (source.includes(TIMEOUT_MARKER)) return false;

  source = replaceOnce(
    source,
    'const operation = this.ctx.remote.session.modelCatalog().then((response) => {',
    `const operation = Promise.race([this.ctx.remote.session.modelCatalog(), new Promise((_, reject) => setTimeout(() => reject(new Error("${TIMEOUT_MARKER}")), 10000))]).then((response) => {`,
  );
  source = replaceOnce(
    source,
    'if (catalog.status !== "ready" || catalog.value === null || projected === void 0) {',
    'if (catalog.status !== "ready" || catalog.value === null) {',
  );
  source = replaceOnce(source, 'const current = projected.next ?? catalog.value.default;', 'const current = projected?.next ?? catalog.value.default;');
  writeFileSync(filePath, source, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(patchModelCatalog() ? '模型列表加载修复已安装。' : '模型列表加载修复已存在或未安装。');
}
