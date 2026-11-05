import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { patchContinueButton } from './patch-dsh-continue-button.mjs';
import { patchEditRecovery } from './patch-dsh-edit-recovery.mjs';
import { patchTodoStoppedStatus } from './patch-dsh-todo-status.mjs';
import { runStartupPatch } from './startup-patch.mjs';

/** Supply the two supported upstream layouts without touching installed packages. */
function clientFixture(modern) {
  const component = modern ? 'const InputBar = (0, react.memo)(function InputBar' : 'function InputBar';
  const access = modern ? '' : '\t\t\tconst accessSelect = command === void 0 ? null : (0, react_jsx_runtime.jsx)(PermissionSelect, {});';
  const modes = modern ? 'sessionId === void 0 ? null : renderSlot("conversation.input.permission", { locked }),' : 'accessSelect,';
  return [
    `\t\t${component}({ useSession, useInput, inputActions, sessionId, disabled = false }) {`,
    '\t\t\tconst input = useInput((s) => s);',
    '\t\t\tconst running = useSession((s) => s.running) ?? false;',
    '\t\t\tconst empty = input.draft === "";',
    '\t\t\tconst machineBusy = false, subagent = null, blocked = void 0, locked = disabled;',
    '\t\t\tconst command = void 0;',
    access,
    '\t\t\tconst primaryStops = running && subagent === null && (empty || blocked !== void 0);',
    `\t\t\treturn { children: [${modes} null] };`,
    modern ? '\t\t});' : '\t\t}',
    '\t\tconst locales = {',
    '\t\t\t"todo.progress.active": "{active} 进行中",',
    '\t\t\t"todo.progress.active": "{active} in progress",',
    '\t\t};',
    '\t\tfunction progressLabel(todos, t) {',
    '\t\t\tconst active = todos.filter((todo) => todo.status === "in_progress").length;',
    '\t\t\treturn [',
    '\t\t\t\t...active > 0 ? [t("todo.progress.active", { active })] : [],',
    '\t\t\t].join(" ");',
    '\t\t}',
    '\t\tfunction TodoPanel({ todos, t }) {',
    '\t\t\treturn {',
    '\t\t\t\t\t\t\t\tchildren: progressLabel(todos, t)',
    '\t\t\t};',
    '\t\t}',
    modern ? '\t\tfunction TodoDock({ useProjection, t }) {' : '\t\tfunction TodoDock({ useProjection, useSession, t }) {',
    '\t\t\treturn (0, react_jsx_runtime.jsx)(TodoPanel, {',
    '\t\t\t\ttodos: useProjection("todos") ?? [],',
    '\t\t\t\tt',
    '\t\t\t});',
    '\t\t}',
  ].join('\n');
}

/** Create disposable fixtures and always remove them. */
function fixtureFiles(run) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-startup-patches-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Evaluate the UI adapter with fake hooks; never submit a real model request. */
function uiContext(source) {
  const jsx = (component, props) => typeof component === 'function' ? component(props) : props;
  return runInNewContext(`${source}\n({ InputBar, TodoDock, progressLabel })`, {
    react: { memo: (component) => component },
    react_jsx_runtime: { jsx },
    _deepseek_ai_dsh_client_ui_primitives: { Tooltip: (props) => props.children },
    renderSlot: () => null,
    setTimeout: (callback) => callback(),
  });
}

for (const modern of [false, true]) {
  for (const eol of ['\n', '\r\n']) {
    test(`continue and todo patches support ${modern ? 'slot' : 'legacy'} layout / ${JSON.stringify(eol)}`, () => fixtureFiles((directory) => {
      const path = join(directory, 'client.js');
      const fixture = clientFixture(modern).replaceAll('\n', eol);
      writeFileSync(path, `\ufeff${fixture}`, 'utf8');
      assert.equal(patchContinueButton(path), true);
      assert.equal(patchTodoStoppedStatus(path), true);
      const bytes = readFileSync(path);
      const source = bytes.toString('utf8');
      assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
      if (eol === '\r\n') assert.equal(/(?<!\r)\n/.test(source), false);
      assert.equal(patchContinueButton(path), false);
      assert.equal(patchTodoStoppedStatus(path), false);
      assert.deepEqual(readFileSync(path), bytes);
      const ui = uiContext(source);
      const session = { blank: false, running: false };
      const draft = { draft: '' };
      let submitted = 0;
      const props = {
        sessionId: 'test', useSession: (select) => select(session), useInput: (select) => select(draft),
        inputActions: { setDraft: (value) => { draft.draft = value; }, snapshot: draft, submit: () => { submitted += 1; } },
      };
      ui.InputBar(props).children[0].onClick();
      assert.equal(draft.draft, '继续');
      assert.equal(submitted, 1);
      for (const state of [{ blank: true, running: false }, { blank: false, running: true }]) {
        Object.assign(session, state); draft.draft = '';
        assert.equal(ui.InputBar(props).children[0], null);
      }
      session.running = false; session.blank = false;
      assert.equal(ui.InputBar({ ...props, disabled: true }).children[0], null);
      draft.draft = 'keep my draft';
      assert.equal(ui.InputBar(props).children[0], null);
      const todos = [{ status: 'in_progress' }];
      for (const running of [false, true]) {
        const result = ui.TodoDock({ useProjection: () => todos, useSession: (select) => select({ running }), t: (key) => key });
        assert.equal(result.children, running ? 'todo.progress.active' : 'todo.progress.stopped');
      }
    }));
  }
}

const promptLegacy = 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.';
const promptModern = 'Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session.';

for (const modern of [false, true, 'current']) {
  test(`edit recovery supports ${modern === 'current' ? 'current prompt' : modern ? 'function' : 'mapping'} errors`, () => fixtureFiles((directory) => {
    const toolFsTarget = join(directory, 'tool.js');
    const fsLocalTarget = join(directory, 'local.js');
    const remedies = modern
      ? 'function remediateFsError(error, displayPath) {\n\tif (error.code === "FS_STALE_VERSION") return error;\n\treturn error;\n}'
      : 'const REMEDIES = {\n\tFS_STALE_VERSION: "re-read the file, then retry",\n\tFS_NOT_OBSERVED: "read the file, then retry"\n};';
    const prompt = modern === 'current' ? 'Read a file before editing it unless you just created or edited it in this session.' : modern ? promptModern : promptLegacy;
    writeFileSync(toolFsTarget, `${remedies}\nconst prompt = ${JSON.stringify(prompt)};\nconst description = ${JSON.stringify(modern ? 'Literal text to replace.' : 'Literal text to replace. Must match exactly.')};`);
    writeFileSync(fsLocalTarget, 'function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {\nconst oldNorm = oldString, newNorm = newString, replacements = 0;\nif (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, "FS_EDIT_NOT_FOUND");\n}');
    assert.equal(patchEditRecovery({ toolFsTarget, fsLocalTarget }), true);
    assert.equal(patchEditRecovery({ toolFsTarget, fsLocalTarget }), false);
    assert.match(readFileSync(toolFsTarget, 'utf8'), /immediately read the current target file/);
    class FsError extends Error {
      constructor(message, code, options) { super(message, options); this.code = code; }
    }
    if (modern) {
      const remediate = runInNewContext(`${readFileSync(toolFsTarget, 'utf8')}\nremediateFsError`, { FsError });
      const original = new FsError('missing match', 'FS_EDIT_NOT_FOUND');
      assert.match(remediate(original, 'test').message, /copy an exact old_string/);
      assert.equal(remediate(original, 'test').cause, original);
    }
    const edit = runInNewContext(`${readFileSync(fsLocalTarget, 'utf8')}\napplyWhitespaceTolerantEdit`, { FsError });
    assert.equal(edit('a  b', 'a b', 'c', false, 'test').content, 'c');
    assert.throws(() => edit('a  b; a b', 'a b', 'c', false, 'test'), { code: 'FS_AMBIGUOUS_EDIT' });
    assert.equal(edit('different', 'a b', 'c', false, 'test'), undefined);
  }));
}

test('quick continue supports the new sending-state guard without changing its stop logic', () => fixtureFiles((directory) => {
  const path = join(directory, 'sending.js');
  const source = clientFixture(true).replace('const machineBusy = false,', 'const sending = false, machineBusy = false,')
    .replace('running && subagent === null && (empty', 'running && subagent === null && !sending && (empty');
  writeFileSync(path, source);
  assert.equal(patchContinueButton(path), true);
  assert.match(readFileSync(path, 'utf8'), /primaryStops = running && subagent === null && !sending/);
  assert.equal(patchContinueButton(path), false);
}));

test('unknown UI layout does not write a partially patched bundle', () => fixtureFiles((directory) => {
  const path = join(directory, 'unknown.js');
  writeFileSync(path, clientFixture(true).replace('const primaryStops =', 'const renamedPrimary ='));
  const before = readFileSync(path);
  assert.throws(() => patchContinueButton(path), /无法定位/);
  assert.deepEqual(readFileSync(path), before);
}));

test('startup failure has one warning and no misleading success', () => {
  const logs = [], warnings = [];
  const logger = { log: (text) => logs.push(text), warn: (text) => warnings.push(text) };
  assert.equal(runStartupPatch('test', () => { throw new Error('missing anchor'); }, logger), undefined);
  assert.equal(logs.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /未应用.*missing anchor/);
  runStartupPatch('test', () => false, logger);
  assert.match(logs[0], /无需更新/);
  runStartupPatch('test', () => true, logger);
  assert.match(logs[1], /已更新/);
  runStartupPatch('test', () => 2, logger);
  assert.match(logs[2], /更新 2 项/);
});

test('edit recovery validates both targets before writing either', () => fixtureFiles((directory) => {
  const toolFsTarget = join(directory, 'tool.js'), fsLocalTarget = join(directory, 'local.js');
  const source = `function remediateFsError(error) {\n\tif (error.code === "FS_STALE_VERSION") return error;\n}\nconst prompt = ${JSON.stringify(promptModern)};\nconst description = "Literal text to replace.";`;
  writeFileSync(toolFsTarget, source);
  writeFileSync(fsLocalTarget, 'unknown upstream implementation');
  assert.throws(() => patchEditRecovery({ toolFsTarget, fsLocalTarget }), /无法定位/);
  assert.equal(readFileSync(toolFsTarget, 'utf8'), source);
  assert.equal(readFileSync(fsLocalTarget, 'utf8'), 'unknown upstream implementation');
}));
