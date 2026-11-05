import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Append only the updater declaration, preserving all existing profile bytes. */
export function registerPlatformUpdates({ projectRoot, dshHome, stateRoot, idle }) {
  const profile = join(dshHome, 'profiles/web');
  const path = join(profile, 'cordis.patch.yml');
  if (!existsSync(path)) return false;
  idle(stateRoot);
  const bytes = readFileSync(path);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const source = bytes.toString('utf8');
  for (const file of ['platform-updates.js', 'platform-updates-client.js']) {
    copyFileSync(join(projectRoot, 'config/dsh/web', file), join(profile, file));
  }
  if (/^\s*- id: xiaojia-platform-updates\s*$/m.test(source)) return false;
  const backup = join(stateRoot, 'platform-updates');
  mkdirSync(backup, { recursive: true });
  const before = join(backup, 'profile-before-registration.yml');
  if (!existsSync(before)) writeFileSync(before, bytes, { flag: 'wx' });
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const declaration = '\n- insert:\n    - id: xiaojia-platform-updates\n      name: ./platform-updates.js\n';
  writeFileSync(path, Buffer.concat([bytes, Buffer.from(declaration.replaceAll('\n', eol))]));
  return true;
}
