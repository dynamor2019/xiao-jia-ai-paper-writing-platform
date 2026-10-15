import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as util from 'node:util';
import { captureModelDependencies, verifyModelDependencies } from './model-dependency-lock.mjs';
import { runNpm } from './guarded-model-update.mjs';
import { prepareModelInstallation } from './prepare-model-installation.mjs';

/** Read only setup paths before third-party dependencies are installed. */
export function loadSetupPaths(projectRoot, env = process.env) {
  const path = join(projectRoot, '.env');
  if (!existsSync(path)) return env;
  if (!util.parseEnv) throw new Error('Setup requires Node.js LTS 20.12 or newer to read .env safely');
  const values = util.parseEnv(readFileSync(path, 'utf8'));
  for (const key of ['PAPER_DATA_ROOT', 'DSH_HOME']) {
    if (env[key] === undefined && values[key] !== undefined) env[key] = values[key];
  }
  return env;
}

/** Verify existing installations or initialize a fresh lockfile-based installation. */
export async function ensureSetupModelDependencies({ projectRoot, dshHome, run = runNpm,
  roots, required = ['@deepseek-ai/dsh', 'electron'], skipInstall = false,
  prepare = prepareModelInstallation,
  verifySource = async () => {
    const verifier = await import('./verify-model-routing.mjs');
    verifier.verifyModelRouting({ projectRoot, dshHome });
  } }) {
  const lockPath = join(dshHome, 'model-dependencies.lock.json');
  const complete = required.every((name) => existsSync(join(projectRoot, 'node_modules', name, 'package.json')));
  if (existsSync(lockPath)) {
    verifyModelDependencies(projectRoot, lockPath);
    await verifySource();
    if (!complete) throw new Error('Installation is incomplete; use the protected updater, not an unguarded reinstall');
    return { installed: false, baselineCreated: false };
  }
  if (existsSync(join(projectRoot, 'node_modules'))) {
    throw new Error('Existing installation has no approved model baseline; review it before --accept-current');
  }
  if (skipInstall) throw new Error('Dependencies are missing and installation was explicitly skipped');
  if (!existsSync(join(projectRoot, 'package-lock.json'))) throw new Error('Missing package-lock.json; setup refuses unpinned installation');
  run(projectRoot, ['ci', '--legacy-peer-deps']);
  if (!required.every((name) => existsSync(join(projectRoot, 'node_modules', name, 'package.json')))) {
    throw new Error('Dependency installation did not produce the required runtime');
  }
  await verifySource();
  prepare(projectRoot);
  const baseline = captureModelDependencies(projectRoot, roots);
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  return { installed: true, baselineCreated: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  loadSetupPaths(projectRoot);
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  await ensureSetupModelDependencies({ projectRoot, dshHome });
  console.log('Setup model dependency protection verified');
}
