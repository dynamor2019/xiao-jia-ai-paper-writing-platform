import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Apply the reviewed adapter patch inside this installation, never the live tree by accident. */
export function prepareModelInstallation(projectRoot) {
  const target = join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');
  if (!existsSync(target)) return;
  const patch = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'patch-dsh-empty-tool-call.mjs')).href;
  const alias = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'patch-dsh-protocol-alias.mjs')).href;
  const context = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'patch-dsh-context-overflow.mjs')).href;
  const code = `import { patchEmptyToolCallRetry } from ${JSON.stringify(patch)};
    import { patchOpenAiProtocolAlias } from ${JSON.stringify(alias)};
    import { patchContextOverflowClassification } from ${JSON.stringify(context)};
    patchEmptyToolCallRetry(); patchOpenAiProtocolAlias(); patchContextOverflowClassification();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: projectRoot, stdio: 'inherit', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('Reviewed model adapter patch failed; installation was not approved');
}
