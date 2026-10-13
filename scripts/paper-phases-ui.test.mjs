import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { PAPER_PHASES } from '../config/dsh/web/paper-phases.js';
import { patchResearchWorkbench } from './patch-dsh-journal-ui.mjs';

for (const eol of ['\n', '\r\n']) {
  test(`workbench phase patch shares the execution contract and is idempotent for ${JSON.stringify(eol)}`, () => {
    const source = ['\t\tfunction workbenchPhases(snapshot) { return []; }',
      '\t\tconst WORKBENCH_STORAGE_KEY = "dsh.paper.workbench.topic";',
      '\t\t//#region lib/types/client/skeleton/InputBar.js'].join(eol);
    const patched = patchResearchWorkbench(source, eol);
    assert.ok(patched.includes(JSON.stringify(PAPER_PHASES)));
    assert.match(patched, /降级待核验/);
    assert.equal((patched.match(/function workbenchPhases/g) || []).length, 1);
    assert.equal(patchResearchWorkbench(patched, eol), patched);
    assert.doesNotThrow(() => new Script(patched));
  });
}
