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
const HOST_INDEX_PATH = join(WORKBENCH_ROOT, 'lib', 'host', 'index.js');
const CODE_VIEW_PATH = join(WORKBENCH_ROOT, 'lib', 'client', 'preview', 'code-view.js');
const CLIENT_BUNDLE_PATH = join(WORKBENCH_ROOT, 'lib', 'client.js');

const MARKER = 'dsh-workbench-pylustrator-open';
const API_PATH = '/dsh-workbench/pylustrator-open';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`无法定位 ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`${label} 不唯一`);
  return source.replace(needle, replacement);
}

function patchHostIndex() {
  if (!existsSync(HOST_INDEX_PATH)) return false;
  let source = readFileSync(HOST_INDEX_PATH, 'utf8');
  let changed = false;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  if (!source.includes('node:child_process')) {
    source = source.replace(
      'import { readFile, stat } from "node:fs/promises";',
      'import { spawn } from "node:child_process";\nimport { readFile, stat } from "node:fs/promises";',
    );
    changed = true;
  }

  if (!source.includes(MARKER)) {
    const helper = [
      `const PYLUSTRATOR_MARKER = "${MARKER}";`,
      `const PYLUSTRATOR_OPEN_API_PATH = "${API_PATH}";`,
      'function openPylustratorProcess(filePath) {',
      '    void PYLUSTRATOR_MARKER;',
      '    const helper = process.env.DSH_PYLUSTRATOR_HELPER;',
      '    const python = process.env.DSH_PYLUSTRATOR_PYTHON || process.env.PYTHON || "python";',
      '    if (!helper)',
      '        throw new Error("missing_pylustrator_helper");',
      '    const child = spawn(python, [helper, filePath], {',
      '        cwd: process.cwd(),',
      '        detached: true,',
      '        stdio: "ignore",',
      '        windowsHide: false,',
      '    });',
      '    child.unref();',
      '}',
      '',
    ].join(eol);
    source = source.replace('export function apply(ctx) {', `${helper}export function apply(ctx) {`);
    changed = true;
  }

  const anchor = [
    '    ctx.webServer.register({',
    '        kind: "exact",',
    '        path: EVENTS_API_PATH,',
  ].join(eol);
  if (!source.includes('path: PYLUSTRATOR_OPEN_API_PATH')) {
    const route = [
      '    ctx.webServer.register({',
      '        kind: "exact",',
      '        path: PYLUSTRATOR_OPEN_API_PATH,',
      '        handler: async (req, res) => {',
      '            if (req.method && req.method !== "POST")',
      '                return sendJson(res, 405, { error: "method_not_allowed" });',
      '            try {',
      '                const body = await readJson(req);',
      '                const requested = typeof body.path === "string" ? body.path : "";',
      '                const located = workspace.resolve(requested);',
      '                if (!located.ok)',
      '                    return sendJson(res, located.status, { error: located.error });',
      '                if (!located.relative.toLowerCase().endsWith(".py"))',
      '                    return sendJson(res, 415, { error: "not_python" });',
      '                openPylustratorProcess(located.absolute);',
      '                sendJson(res, 200, { ok: true, path: located.relative });',
      '            }',
      '            catch (error) {',
      '                sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });',
      '            }',
      '        },',
      '    });',
    ].join(eol);
    source = replaceOnce(source, anchor, `${route}${eol}${anchor}`, 'Pylustrator 路由插入点');
    changed = true;
  }

  if (changed) writeFileSync(HOST_INDEX_PATH, source, 'utf8');
  return changed;
}

function patchCodeViewFile(filePath) {
  if (!existsSync(filePath)) return false;
  let source = readFileSync(filePath, 'utf8');
  if (source.includes(MARKER)) return false;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const jsx = source.includes('jsx$1(') ? 'jsx$1' : '_jsx';
  const jsxs = source.includes('jsxs(') && !source.includes('_jsxs(') ? 'jsxs' : '_jsxs';

  const helper = [
    `const PYLUSTRATOR_CLIENT_MARKER = "${MARKER}";`,
    `const PYLUSTRATOR_OPEN_API_PATH = "${API_PATH}";`,
    'function isPythonFigureScript(path, content) {',
    '    return /\\.py$/i.test(path) && /\\b(matplotlib|pyplot|plt\\.|savefig|seaborn|pylustrator|finalize_figure|figures4papers)\\b/i.test(content);',
    '}',
    '',
  ].join(eol);
  const codeViewNeedle = source.includes('export function CodeView') ? 'export function CodeView' : 'function CodeView';
  source = source.replace(codeViewNeedle, `${helper}${codeViewNeedle}`);
  source = replaceOnce(source, `${source.match(/(\s+)const \[markdownSource, setMarkdownSource\] = useState\(false\);/)?.[0]}`, `${source.match(/(\s+)const \[markdownSource, setMarkdownSource\] = useState\(false\);/)?.[0]}${eol}${source.match(/(\s+)const \[markdownSource, setMarkdownSource\] = useState\(false\);/)?.[1]}const [pylustratorStatus, setPylustratorStatus] = useState("");`, 'Pylustrator 状态');
  const resetMatch = source.match(/(\s+)setSeenPath\(path\);\r?\n\1setMarkdownSource\(false\);/);
  if (!resetMatch) throw new Error('无法定位 Pylustrator 状态重置');
  source = source.replace(resetMatch[0], `${resetMatch[0]}${eol}${resetMatch[1]}setPylustratorStatus("");`);

  const sourceToggle = '    const toggle = isMarkdown ? (_jsx("button", { className: "dsh-wb-markdown-toggle", type: "button", onClick: () => setMarkdownSource((value) => !value), children: t(markdownSource ? "markdownPreview" : "markdownSource") })) : null;';
  const bundleToggle = [
    '\t\tconst toggle = isMarkdown ? /* @__PURE__ */ jsx$1("button", {',
    '\t\t\tclassName: "dsh-wb-markdown-toggle",',
    '\t\t\ttype: "button",',
    '\t\t\tonClick: () => setMarkdownSource((value) => !value),',
    '\t\t\tchildren: t(markdownSource ? "markdownPreview" : "markdownSource")',
    '\t\t}) : null;',
  ].join(eol);
  const indent = source.includes(sourceToggle) ? '    ' : '\t\t';
  const toggleNeedle = source.includes(sourceToggle) ? sourceToggle : bundleToggle;
  const toggleReplacement = [
    toggleNeedle,
    `${indent}const pylustratorOpen = kind === "code" && isPythonFigureScript(state.payload.path, state.payload.content) ? /* @__PURE__ */ ${jsx}("button", {`,
    `${indent}${indent}className: "dsh-wb-markdown-toggle",`,
    `${indent}${indent}type: "button",`,
    `${indent}${indent}"data-dsh-wb-tooltip": "用 Pylustrator 打开绘图脚本",`,
    `${indent}${indent}onClick: () => {`,
    `${indent}${indent}${indent}void PYLUSTRATOR_CLIENT_MARKER;`,
    `${indent}${indent}${indent}setPylustratorStatus("opening");`,
    `${indent}${indent}${indent}fetch(PYLUSTRATOR_OPEN_API_PATH, {`,
    `${indent}${indent}${indent}${indent}method: "POST",`,
    `${indent}${indent}${indent}${indent}headers: { "content-type": "application/json" },`,
    `${indent}${indent}${indent}${indent}body: JSON.stringify({ path: state.payload.path }),`,
    `${indent}${indent}${indent}}).then((response) => {`,
    `${indent}${indent}${indent}${indent}if (!response.ok) throw new Error(\`HTTP \${response.status}\`);`,
    `${indent}${indent}${indent}${indent}setPylustratorStatus("opened");`,
    `${indent}${indent}${indent}}).catch((error) => setPylustratorStatus(error instanceof Error ? error.message : String(error)));`,
    `${indent}${indent}},`,
    `${indent}${indent}children: pylustratorStatus === "opening" ? "正在打开..." : pylustratorStatus === "opened" ? "已打开 Pylustrator" : "Pylustrator 打开"`,
    `${indent}}) : null;`,
    `${indent}const toolbar = toggle || pylustratorOpen ? /* @__PURE__ */ ${jsxs}("div", { className: "dsh-wb-preview-toolbar", children: [pylustratorOpen, toggle] }) : null;`,
  ].join(eol);
  source = replaceOnce(source, toggleNeedle, toggleReplacement, 'Pylustrator 预览按钮');
  source = source.replaceAll(
    '_jsx("div", { className: "dsh-wb-preview-toolbar", children: toggle })',
    'toolbar',
  );
  source = source.replaceAll(
    'jsx$1("div", {\n\t\t\tclassName: "dsh-wb-preview-toolbar",\n\t\t\tchildren: toggle\n\t\t})',
    'toolbar',
  );
  source = source.replace(
    'children: [toggle ? _jsx("div", { className: "dsh-wb-preview-toolbar", children: toggle }) : null, _jsx("div", { className: "dsh-wb-cm", ref: hostRef })]',
    'children: [toolbar, _jsx("div", { className: "dsh-wb-cm", ref: hostRef })]',
  );
  source = source.replace(
    'children: [toggle ? /* @__PURE__ */ jsx$1("div", {\n\t\t\t\tclassName: "dsh-wb-preview-toolbar",\n\t\t\t\tchildren: toggle\n\t\t\t}) : null, /* @__PURE__ */ jsx$1("div", {',
    'children: [toolbar, /* @__PURE__ */ jsx$1("div", {',
  );
  writeFileSync(filePath, source, 'utf8');
  return true;
}

export function patchWorkbenchPylustrator() {
  return [
    patchHostIndex(),
    patchCodeViewFile(CODE_VIEW_PATH),
    patchCodeViewFile(CLIENT_BUNDLE_PATH),
  ].filter(Boolean).length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changed = patchWorkbenchPylustrator();
  console.log(changed > 0 ? `dsh-workbench Pylustrator 入口已安装（${changed} 个文件）。` : 'dsh-workbench Pylustrator 入口已存在或未安装。');
}
