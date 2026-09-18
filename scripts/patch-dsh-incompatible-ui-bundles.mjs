import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROFILE_PACKAGE = join(
  process.env.USERPROFILE || 'C:\\Users\\Administrator',
  '.dsh',
  'profiles',
  'web',
  'package.json',
);
const PROFILE_WORKSPACE = join(
  process.env.USERPROFILE || 'C:\\Users\\Administrator',
  '.dsh',
  'profiles',
  'web',
  'pnpm-workspace.yaml',
);

const INCOMPATIBLE_BUNDLES = new Set([
  '@linxin666/dsh-web-all',
  'dsh-univer-office',
  '@linxin666/dsh-client-ui-web-ui-settings',
  '@linxin666/dsh-client-ui-market',
]);

export function patchIncompatibleUiBundles() {
  if (process.env.DSH_KEEP_INCOMPATIBLE_UI === 'true') return false;
  let changed = false;

  if (existsSync(PROFILE_PACKAGE)) {
    const source = readFileSync(PROFILE_PACKAGE, 'utf8');
    const profile = JSON.parse(source);
    const bundles = profile?.dsh?.profile?.bundles;
    if (Array.isArray(bundles)) {
      const nextBundles = bundles.filter((bundle) => !INCOMPATIBLE_BUNDLES.has(bundle));
      if (nextBundles.length !== bundles.length) {
        profile.dsh.profile.bundles = nextBundles;
        changed = true;
      }
    }

    if (profile.dependencies && typeof profile.dependencies === 'object') {
      for (const bundle of INCOMPATIBLE_BUNDLES) {
        if (bundle in profile.dependencies) {
          delete profile.dependencies[bundle];
          changed = true;
        }
      }
    }

    if (changed) writeFileSync(PROFILE_PACKAGE, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  }

  if (existsSync(PROFILE_WORKSPACE)) {
    const source = readFileSync(PROFILE_WORKSPACE, 'utf8');
    const lines = source.split(/\r?\n/);
    const nextLines = lines.filter((line) => ![...INCOMPATIBLE_BUNDLES].some((bundle) => line.includes(bundle)));
    if (nextLines.length !== lines.length) {
      writeFileSync(PROFILE_WORKSPACE, `${nextLines.join('\n').replace(/\n+$/u, '')}\n`, 'utf8');
      changed = true;
    }
  }

  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(patchIncompatibleUiBundles() ? 'Incompatible UI bundles disabled.' : 'No incompatible UI bundles to disable.');
}
