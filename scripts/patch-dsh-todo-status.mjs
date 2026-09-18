import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_BUNDLE = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-conversation',
  'lib',
  'client.js',
);
const PATCH_MARKER = '"todo.progress.stopped": "{active} stopped"';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`无法定位 DSH todo ${label} 插入点`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`DSH todo ${label} 插入点不唯一`);
  }
  return source.replace(needle, replacement);
}

export function patchTodoStoppedStatus() {
  let source = readFileSync(CLIENT_BUNDLE, 'utf8');
  const brokenDock = '\t\tfunction TodoDock({ useProjection, t }) {\n\t\t\tconst running = useSession((session) => session.running) ?? false;';
  if (source.includes(PATCH_MARKER)) {
    if (!source.includes(brokenDock)) return false;
    source = source.replace(
      brokenDock,
      '\t\tfunction TodoDock({ useProjection, useSession, t }) {\n\t\t\tconst running = useSession((session) => session.running) ?? false;',
    );
    writeFileSync(CLIENT_BUNDLE, source, 'utf8');
    return true;
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  source = replaceOnce(
    source,
    '\t\t\t"todo.progress.active": "{active} 进行中",',
    [
      '\t\t\t"todo.progress.active": "{active} 进行中",',
      '\t\t\t"todo.progress.stopped": "{active} 已停止",',
    ].join(eol),
    '中文状态文案',
  );
  source = replaceOnce(
    source,
    '\t\t\t"todo.progress.active": "{active} in progress",',
    [
      '\t\t\t"todo.progress.active": "{active} in progress",',
      `\t\t\t${PATCH_MARKER},`,
    ].join(eol),
    '英文状态文案',
  );
  source = replaceOnce(
    source,
    '\t\tfunction progressLabel(todos, t) {',
    '\t\tfunction progressLabel(todos, t, running) {',
    '摘要函数参数',
  );
  source = replaceOnce(
    source,
    '\t\t\t\t...active > 0 ? [t("todo.progress.active", { active })] : [],',
    '\t\t\t\t...active > 0 ? [t(running ? "todo.progress.active" : "todo.progress.stopped", { active })] : [],',
    '活动状态判断',
  );
  source = replaceOnce(
    source,
    '\t\tfunction TodoPanel({ todos, t }) {',
    '\t\tfunction TodoPanel({ todos, t, running }) {',
    '任务面板参数',
  );
  source = replaceOnce(
    source,
    '\t\t\t\t\t\t\t\tchildren: progressLabel(todos, t)',
    '\t\t\t\t\t\t\t\tchildren: progressLabel(todos, t, running)',
    '任务摘要调用',
  );
  source = replaceOnce(
    source,
    [
      '\t\tfunction TodoDock({ useProjection, useSession, t }) {',
      '\t\t\treturn (0, react_jsx_runtime.jsx)(TodoPanel, {',
      '\t\t\t\ttodos: useProjection("todos") ?? [],',
      '\t\t\t\tt',
      '\t\t\t});',
      '\t\t}',
    ].join(eol),
    [
      '\t\tfunction TodoDock({ useProjection, t }) {',
      '\t\t\tconst running = useSession((session) => session.running) ?? false;',
      '\t\t\treturn (0, react_jsx_runtime.jsx)(TodoPanel, {',
      '\t\t\t\ttodos: useProjection("todos") ?? [],',
      '\t\t\t\tt,',
      '\t\t\t\trunning',
      '\t\t\t});',
      '\t\t}',
    ].join(eol),
    '会话运行状态绑定',
  );

  writeFileSync(CLIENT_BUNDLE, source, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  console.log(patchTodoStoppedStatus() ? 'DSH todo 状态补丁已安装。' : 'DSH todo 状态补丁已存在。');
}
