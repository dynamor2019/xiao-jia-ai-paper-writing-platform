import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertModelDependencies, captureModelDependencies, verifyModelDependencies } from './model-dependency-lock.mjs';
import { prepareModelInstallation } from './prepare-model-installation.mjs';
import { preserveModelUpdateAssets } from './model-update-assets.mjs';
import { preserveLockedModelLayer } from './preserve-model-layer.mjs';

/** Run npm without changing the user's existing network environment. */
export function runNpm(cwd, args) {
  const cli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (process.platform === 'win32' && !existsSync(cli)) throw new Error('Cannot locate npm-cli.js for shell-free protected update');
  const command = process.platform === 'win32' ? process.execPath : 'npm';
  const commandArgs = process.platform === 'win32' ? [cli, ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`npm failed (${result.status ?? result.error?.code})`);
}

/** Reject flags or commands that could redirect the isolated install. */
export function validateUpdateSpecs(specs) {
  if (!specs.length || specs.some((spec) => !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-zA-Z0-9.*^~+-]+)?$/.test(spec))) {
    throw new Error('Protected update accepts registry package specs only, not shell commands, URLs, paths or npm flags');
  }
}

/** Verify a staged upgrade before touching the running installation. */
export function guardedModelUpdate({ projectRoot, lockPath, specs, run = runNpm,
  prepare = prepareModelInstallation, checkOnly = false, auditStage = () => {}, move = renameSync }) {
  validateUpdateSpecs(specs);
  const baseline = verifyModelDependencies(projectRoot, lockPath);
  const staging = mkdtempSync(join(resolve(projectRoot), '.dsh-model-stage-'));
  try {
    cpSync(join(projectRoot, 'node_modules'), join(staging, 'node_modules'), {
      recursive: true, verbatimSymlinks: true,
    });
    for (const file of ['package.json', 'package-lock.json']) {
      copyFileSync(join(projectRoot, file), join(staging, file));
    }
    run(staging, ['install', ...specs, '--ignore-scripts', '--legacy-peer-deps']);
    preserveLockedModelLayer(projectRoot, staging, baseline);
    prepare(staging);
    preserveModelUpdateAssets(join(projectRoot, 'node_modules'), join(staging, 'node_modules'));
    const actual = captureModelDependencies(staging, baseline.roots);
    auditStage({ staging, baseline, actual });
    assertModelDependencies(baseline, actual);
    verifyModelDependencies(projectRoot, lockPath);
    if (checkOnly) return { checked: true, installed: false };
    installVerifiedStage(projectRoot, staging, lockPath, move);
    return { checked: true, installed: true };
  } finally {
    // Delete only this exact freshly-created directory, never a project or data directory.
    const retainedBackup = join(resolve(projectRoot), `.dsh-model-backup-${basename(staging)}`);
    if (existsSync(retainedBackup)) console.warn(`Rollback requires attention; retained originals at ${retainedBackup} and ${staging}`);
    else rmSync(staging, { recursive: true, force: true });
  }
}

/** Keep the original dependency directory and manifests until verification succeeds. */
function installVerifiedStage(projectRoot, staging, lockPath, move) {
  const root = resolve(projectRoot);
  const modules = join(root, 'node_modules');
  const backup = join(root, `.dsh-model-backup-${basename(staging)}`);
  if (dirname(resolve(modules)) !== root || dirname(resolve(backup)) !== root || existsSync(backup)) {
    throw new Error('Unsafe dependency backup target; refusing update');
  }
  let moved = false;
  try {
    promoteStagedManifests(root, staging);
    move(modules, backup);
    moved = true;
    move(join(staging, 'node_modules'), modules);
    verifyModelDependencies(root, lockPath);
  } catch (error) {
    if (moved) {
      rmSync(modules, { recursive: true, force: true });
      renameSync(backup, modules);
    }
    for (const file of ['package.json', 'package-lock.json']) {
      const original = join(staging, `before-${file}`);
      if (existsSync(original)) copyFileSync(original, join(root, file));
    }
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
}

/** Install the exact tested lockfile, refusing encoding or line-ending changes. */
function promoteStagedManifests(projectRoot, staging) {
  for (const file of ['package.json', 'package-lock.json']) {
    const before = readFileSync(join(projectRoot, file));
    const after = readFileSync(join(staging, file));
    new TextDecoder('utf-8', { fatal: true }).decode(after);
    const bom = (buffer) => buffer.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
    if (bom(before) !== bom(after) || before.includes(Buffer.from('\r\n')) !== after.includes(Buffer.from('\r\n'))) {
      throw new Error(`Staged update changed encoding or line endings: ${file}; live installation untouched`);
    }
  }
  for (const file of ['package.json', 'package-lock.json']) {
    copyFileSync(join(projectRoot, file), join(staging, `before-${file}`));
    copyFileSync(join(staging, file), join(projectRoot, file));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const lockPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'model-dependencies.lock.json');
  if (!existsSync(lockPath)) throw new Error('Model dependency baseline is missing; approve the known-working installation before upgrading');
  const checkOnly = process.argv.includes('--check-only');
  let specs = process.argv.slice(2).filter((arg) => arg !== '--check-only');
  if (!specs.length) {
    const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    const current = JSON.parse(readFileSync(join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
    const target = process.env.DSH_TARGET_VERSION || current;
    const locked = JSON.parse(readFileSync(lockPath, 'utf8'));
    const protectedNames = new Set(Object.values(locked.packages).map((entry) => entry.name));
    specs = Object.keys(manifest.dependencies).filter((name) => name.startsWith('@deepseek-ai/dsh')
      && !protectedNames.has(name))
      .map((name) => `${name}@${target}`);
    specs.push(`dsh-univer-office@${process.env.DSH_UNIVER_OFFICE_TARGET_VERSION || '0.3.5'}`);
  }
  guardedModelUpdate({ projectRoot, lockPath, specs, checkOnly });
  console.log(checkOnly ? 'Isolated core update verification passed; live installation unchanged'
    : 'Core update completed without changing protected model dependencies');
}
