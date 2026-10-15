import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Preserve previously installed Electron assets only for the same package version. */
export function preserveModelUpdateAssets(sourceModules, targetModules) {
  const source = join(sourceModules, 'electron');
  const target = join(targetModules, 'electron');
  if (!existsSync(join(source, 'dist'))) return;
  if (!existsSync(join(source, 'path.txt')) || !existsSync(join(target, 'package.json'))) {
    throw new Error('Desktop runtime assets are incomplete; update refused');
  }
  const before = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const after = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  if (before.name !== after.name || before.version !== after.version) {
    throw new Error('Desktop runtime version changed; automatic asset reuse refused');
  }
  cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true, force: true });
  cpSync(join(source, 'path.txt'), join(target, 'path.txt'), { force: true });
}
