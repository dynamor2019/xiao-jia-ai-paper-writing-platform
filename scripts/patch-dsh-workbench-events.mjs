import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SHARED_EVENTS = `const workspaceEventSubscriptions = new Map();
const connectWorkspaceEvents = (url) => new EventSource(url);
function followWorkspaceEvents(onChange, connect = connectWorkspaceEvents, onWrite = () => {}) {
    let entry = workspaceEventSubscriptions.get(connect);
    if (!entry) {
        const listeners = new Set();
        const source = connect(EVENTS_API_PATH);
        entry = { source, listeners };
        workspaceEventSubscriptions.set(connect, entry);
        const dispatch = (kind, value) => {
            for (const listener of [...listeners]) {
                try { listener[kind](value); } catch (error) { console.warn('workspace event listener failed', error); }
            }
        };
        source.addEventListener("change", (event) => dispatch("onChange", event));
        source.addEventListener("write", (event) => {
            let payload;
            try { payload = JSON.parse(event?.data); } catch { return; }
            if (typeof payload?.path === "string" && payload.path) dispatch("onWrite", { path: payload.path });
        });
    }
    const listener = { onChange, onWrite };
    entry.listeners.add(listener);
    return () => {
        if (!entry.listeners.delete(listener) || entry.listeners.size > 0) return;
        entry.source.close();
        workspaceEventSubscriptions.delete(connect);
    };
}`;

/** Replace only the workspace subscription helper, preserving the file bytes elsewhere. */
export function patchEventSource(source) {
  if (source.includes('const workspaceEventSubscriptions = new Map();')) return source;
  const pattern = /([\t ]*)(?:export )?function followWorkspaceEvents\(onChange,[\s\S]*?return \(\) => source\.close\(\);\r?\n\1}/;
  if (!pattern.test(source)) throw new Error('Cannot locate workspace event subscription helper');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return source.replace(pattern, (original, indent) => {
    const helper = SHARED_EVENTS.split('\n').map((line) => indent + line).join(eol);
    return original.includes('export function')
      ? helper.replace('function followWorkspaceEvents', 'export function followWorkspaceEvents')
      : helper;
  });
}

/** Patch the installed workbench helper and served bundle, with a recoverable backup. */
export function patchWorkbenchEvents() {
  const root = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles/web/node_modules/dsh-workbench/lib');
  let changed = 0;
  for (const relative of ['client/workspace-events.js', 'client.js']) {
    const file = join(root, relative);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const source = bytes.toString('utf8');
    const next = patchEventSource(source);
    if (next === source) continue;
    const backup = file + '.before-shared-events.bak';
    if (!existsSync(backup)) copyFileSync(file, backup);
    writeFileSync(file, next, 'utf8');
    const actual = readFileSync(file);
    if (!actual.equals(Buffer.from(next, 'utf8'))) throw new Error('Workspace patch byte verification failed');
    changed += 1;
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Workbench shared event subscriptions: ${patchWorkbenchEvents()} files patched`);
}
