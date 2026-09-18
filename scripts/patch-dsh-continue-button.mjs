import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENT_BUNDLE = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-conversation',
  'lib',
  'client.js',
);
const MARKER = 'data-dsh-quick-continue-v2';
const LEGACY_MARKER = 'aria-label": "继续上次任务"';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`无法定位 DSH 快捷继续按钮${label}插入点`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`DSH 快捷继续按钮${label}插入点不唯一`);
  }
  return source.replace(needle, replacement);
}

/** Inject an idle-session shortcut that submits a plain "继续" message. */
export function patchContinueButton() {
  let source = readFileSync(CLIENT_BUNDLE, 'utf8');
  if (source.includes(MARKER)) return false;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const hadLegacyPatch = source.includes(LEGACY_MARKER);
  source = source.replace(`${eol}\t\t\t\t\t\t\t\t\t\tquickContinue,`, '');

  const runningAnchor = '\t\t\tconst running = useSession((s) => s.running) ?? false;';
  if (!source.includes('const blank = useSession((s) => s.blank) ?? true;')) {
    source = replaceOnce(
      source,
      runningAnchor,
      `${runningAnchor}${eol}\t\t\tconst blank = useSession((s) => s.blank) ?? true;`,
      '会话状态',
    );
  }

  const componentAnchor = source.includes('\t\tfunction InputBar({ useSession')
    ? '\t\tfunction InputBar({ useSession'
    : '\t\tconst InputBar = (0, react.memo)(function InputBar({ useSession';
  if (!source.includes('function ensureQuickContinueLayoutStyles()')) {
    const styleHelper = [
      '\t\tfunction ensureQuickContinueLayoutStyles() {',
      '\t\t\tif (typeof document === "undefined" || document.querySelector("style[data-dsh-quick-continue-layout]")) return;',
      '\t\t\tconst style = document.createElement("style");',
      '\t\t\tstyle.setAttribute("data-dsh-quick-continue-layout", "true");',
      '\t\t\tstyle.textContent = `.${InputBar_module_css_default.row}{flex-wrap:nowrap!important;gap:8px!important;align-items:center!important}.${InputBar_module_css_default.tools}{flex:1 1 auto!important;gap:8px!important;min-width:0!important;overflow:hidden!important}.${InputBar_module_css_default.modes}{flex:1 1 auto!important;gap:6px!important;min-width:0!important;overflow:hidden!important;white-space:nowrap!important}.${InputBar_module_css_default.modes}>*{flex:0 1 auto!important;min-width:0!important}.${InputBar_module_css_default.trailing}{flex:0 0 auto!important;gap:8px!important;margin-left:6px!important;white-space:nowrap!important}.${InputBar_module_css_default.select}{max-width:170px!important;height:26px!important}.dsh-wb-trigger{height:26px!important;padding:0 8px!important;font-size:12px!important}@media(max-width:960px){.${InputBar_module_css_default.select}{max-width:132px!important}.dsh-wb-trigger{max-width:96px!important;overflow:hidden!important;text-overflow:ellipsis!important}}`;',
      '\t\t\tdocument.head.appendChild(style);',
      '\t\t}',
      componentAnchor,
    ].join(eol);
    source = replaceOnce(source, componentAnchor, styleHelper, '布局样式');
  }

  const inputAnchor = source.includes('\t\t\tconst input = useInput((s) => s);')
    ? '\t\t\tconst input = useInput((s) => s);'
    : '\t\t\tconst input = useInput();';
  if (!source.includes('ensureQuickContinueLayoutStyles();')) {
    source = replaceOnce(
      source,
      inputAnchor,
      `${inputAnchor}${eol}\t\t\tensureQuickContinueLayoutStyles();`,
      '布局启用',
    );
  }

  const accessAnchor = '\t\t\tconst accessSelect = command === void 0 ? null : (0, react_jsx_runtime.jsx)(PermissionSelect, {';
  const shortcut = [
    '\t\t\tconst submitQuickContinue = () => {',
    '\t\t\t\tif (inputActions === void 0) return;',
    '\t\t\t\tinputActions.setDraft("继续");',
    '\t\t\t\tconst submitWhenReady = (attempt = 0) => {',
    '\t\t\t\t\tif (inputActions.snapshot?.draft === "继续" || attempt >= 8) inputActions.submit();',
    '\t\t\t\t\telse setTimeout(() => submitWhenReady(attempt + 1), 25);',
    '\t\t\t\t};',
    '\t\t\t\tsetTimeout(() => submitWhenReady(), 0);',
    '\t\t\t};',
    '\t\t\tconst quickContinue = !blank && !running && empty && !disabled && !machineBusy && inputActions !== void 0 ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
    '\t\t\t\tlabel: "继续上次任务",',
    '\t\t\t\tside: "top",',
    '\t\t\t\tdelayMs: 300,',
    '\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {',
    '\t\t\t\t\ttype: "button",',
    '\t\t\t\t\t"aria-label": "继续上次任务",',
    '\t\t\t\t\t"data-dsh-quick-continue-v2": true,',
    '\t\t\t\t\ttitle: "继续上次任务",',
    '\t\t\t\t\tstyle: { width: "18px", height: "18px", minWidth: "18px", flex: "0 0 18px", border: "none", borderRadius: "50%", padding: 0, background: "var(--dsw-alias-state-business-primary)", cursor: "pointer", boxShadow: "0 0 0 3px var(--dsw-alias-state-business-tertiary)" },',
    '\t\t\t\t\tonMouseDown: (event) => event.preventDefault(),',
    '\t\t\t\t\tonClick: submitQuickContinue',
    '\t\t\t\t})',
    '\t\t\t}) : null;',
    accessAnchor,
  ].join(eol);
  if (hadLegacyPatch) {
    source = source.replace(
      /[\t ]*const quickContinue = !blank && !running && empty && !disabled && !machineBusy && inputActions !== void 0 \?[\s\S]*?\n[\t ]*const accessSelect = command === void 0 \? null : \(0, react_jsx_runtime\.jsx\)\(PermissionSelect, \{/,
      shortcut,
    );
  } else {
    source = replaceOnce(source, accessAnchor, shortcut, '组件');
  }

  const modesAnchor = 'children: [accessSelect,';
  source = replaceOnce(
    source,
    modesAnchor,
    'children: [quickContinue, accessSelect,',
    '位置',
  );

  writeFileSync(CLIENT_BUNDLE, source, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(patchContinueButton() ? 'DSH 快捷继续按钮已安装。' : 'DSH 快捷继续按钮已存在。');
}
