import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { SHARED_EVENTS, patchEventSource } from './patch-dsh-workbench-events.mjs';

test('workspace subscribers share one connection and release only after the last subscriber', () => {
  const sources = [];
  class FakeSource {
    handlers = {};
    closed = 0;
    constructor() { sources.push(this); }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    close() { this.closed += 1; }
  }
  const context = vm.createContext({ EventSource: FakeSource, EVENTS_API_PATH: '/events', console });
  vm.runInContext(SHARED_EVENTS, context);
  const follow = vm.runInContext('followWorkspaceEvents', context);
  let changes = 0;
  let path;
  const stop1 = follow(() => { changes += 1; });
  const stop2 = follow(() => { changes += 1; }, undefined, (event) => { path = event.path; });
  assert.equal(sources.length, 1);
  sources[0].handlers.change({});
  sources[0].handlers.write({ data: '{"path":"result.json"}' });
  sources[0].handlers.write({ data: 'invalid' });
  sources[0].handlers.write({ data: 'null' });
  assert.equal(changes, 2);
  assert.equal(path, 'result.json');
  stop1();
  stop1();
  assert.equal(sources[0].closed, 0);
  stop2();
  stop2();
  assert.equal(sources[0].closed, 1);
  const stop3 = follow(() => {});
  assert.equal(sources.length, 2);
  stop3();
});

test('patch is targeted, idempotent and preserves BOM and line endings', () => {
  for (const eol of ['\n', '\r\n']) {
    const original = '\ufeff// before' + eol + [
      'export function followWorkspaceEvents(onChange, connect = (url) => new EventSource(url), onWrite = () => {}) {',
      '    const source = connect(EVENTS_API_PATH);',
      '    return () => source.close();',
      '}',
      '// after',
    ].join(eol);
    const patched = patchEventSource(original);
    assert.ok(patched.startsWith('\ufeff// before' + eol));
    assert.ok(patched.endsWith(eol + '// after'));
    assert.ok(patched.includes('export function followWorkspaceEvents'));
    assert.equal(patchEventSource(patched), patched);
    if (eol === '\r\n') assert.equal(patched.replaceAll('\r\n', '').includes('\n'), false);
  }
  assert.throws(() => patchEventSource('unrecognized module'), /Cannot locate/);
});
