import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKBENCH_ROOT = resolve(
  process.env.DSH_HOME || 'C:\\Users\\Administrator\\.dsh',
  'profiles',
  'web',
  'node_modules',
  'dsh-workbench',
);
const ENTRY_PATH = join(
  WORKBENCH_ROOT,
  'lib',
  'client',
  'entry.js',
);
const SLOTS_PATH = join(WORKBENCH_ROOT, 'lib', 'client', 'workbench', 'slots.js');
const BUNDLE_PATH = join(WORKBENCH_ROOT, 'lib', 'client.js');

const MARKER = 'data-dsh-workbench-floating';
const HEADER_SLOT = 'conversation.session.header.utilities';

function replaceOnce(source, needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error('无法定位 dsh-workbench 悬浮入口插入点');
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error('dsh-workbench 悬浮入口插入点不唯一');
  }
  return source.replace(needle, replacement);
}

function patchFile(filePath) {
  if (!existsSync(filePath)) return false;
  let source = readFileSync(filePath, 'utf8');
  let changed = false;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  const sourceSlot = `    ctx.slots.inject("${HEADER_SLOT}", () => ctx.slots.register({ name: "${HEADER_SLOT}", id: "dsh-workbench", order: 10 }, components.WorkbenchToggle));`;
  const bundleSlot = `\t\tctx.slots.inject("${HEADER_SLOT}", () => ctx.slots.register({${eol}\t\t\tname: "${HEADER_SLOT}",${eol}\t\t\tid: "dsh-workbench",${eol}\t\t\torder: 10${eol}\t\t}, components.WorkbenchToggle));`;
  const disabledSlot = '    void components.WorkbenchToggle;';
  const disabledBundleSlot = '\t\tvoid components.WorkbenchToggle;';
  if (source.includes(disabledSlot)) {
    source = replaceOnce(source, disabledSlot, sourceSlot);
    changed = true;
  }
  if (source.includes(disabledBundleSlot)) {
    source = replaceOnce(source, disabledBundleSlot, bundleSlot);
    changed = true;
  }

  if (source.includes(MARKER)) {
    const helperPattern = new RegExp(`const FLOATING_ATTR = "${MARKER}";[\\s\\S]*?createRoot\\(host\\)\\.render\\(React\\.createElement\\(Toggle\\)\\);\\r?\\n}\\r?\\n`);
    source = source.replace(helperPattern, '');
    source = source.replace(`${eol}    mountWorkbenchFloating(React, ReactDOMClient.createRoot, ui.WorkbenchToggle, document.body);`, '');
    source = source.replace(`${eol}\t\tmountWorkbenchFloating(React, ReactDOMClient.createRoot, ui.WorkbenchToggle, document.body);`, '');
    changed = true;
  }

  if (changed) writeFileSync(filePath, source, 'utf8');
  return changed;
}

export function patchWorkbenchFloating() {
  return [ENTRY_PATH, SLOTS_PATH, BUNDLE_PATH].filter((filePath) => patchFile(filePath)).length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changed = patchWorkbenchFloating();
  console.log(changed > 0 ? `dsh-workbench 右上角入口已安装（${changed} 个文件）。` : 'dsh-workbench 右上角入口已存在或未安装。');
}
