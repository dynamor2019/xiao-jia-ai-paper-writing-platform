import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureModelDependencies, verifyModelDependencies } from './model-dependency-lock.mjs';
import { prepareModelInstallation } from './prepare-model-installation.mjs';

/** Locate the non-secret dependency fingerprint shipped with a desktop build. */
export function packagedModelBaselinePath(projectRoot) {
  return join(projectRoot, 'config', 'dsh', 'web', 'model-dependencies.lock.json');
}

/** Adopt only an exactly verified packaged tree, never replace a local baseline. */
export function initializePackagedModelBaseline(projectRoot, dshHome) {
  const local = join(dshHome, 'model-dependencies.lock.json');
  if (existsSync(local)) {
    verifyModelDependencies(projectRoot, local);
    return false;
  }
  const packaged = packagedModelBaselinePath(projectRoot);
  if (!existsSync(packaged)) return false;
  verifyModelDependencies(projectRoot, packaged);
  const bytes = readFileSync(packaged);
  mkdirSync(dshHome, { recursive: true });
  try { writeFileSync(local, bytes, { flag: 'wx' }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    verifyModelDependencies(projectRoot, local);
    return false;
  }
  return true;
}

/** Capture the prepared package tree after source and existing baseline checks. */
async function preparePackagedModelBaseline(projectRoot, dshHome) {
  const { verifyModelRouting } = await import('./verify-model-routing.mjs');
  verifyModelRouting({ projectRoot, dshHome });
  prepareModelInstallation(projectRoot);
  const baseline = captureModelDependencies(projectRoot);
  writeFileSync(packagedModelBaselinePath(projectRoot), `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Desktop model baseline prepared: ${Object.keys(baseline.packages).length} protected packages`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  await preparePackagedModelBaseline(root, process.env.DSH_HOME || join(homedir(), '.dsh'));
}
