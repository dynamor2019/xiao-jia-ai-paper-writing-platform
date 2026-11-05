import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileHash, readUpdateJson, updateFile, validateUpdateManifest, writeUpdateJson } from './platform-update-files.mjs';
import { extractUpdateArchive } from './platform-update-extract.mjs';

/** A running host owns the installation; PID uncertainty never permits a replacement. */
export function assertPlatformIdle(stateRoot, probe = process.kill) {
  const lock = readUpdateJson(join(stateRoot, 'web-supervisor.lock.json'));
  if (!lock && !existsSync(join(stateRoot, 'web-supervisor.lock.json'))) return;
  if (!lock) throw new Error('宿主锁无法读取，更新已延后');
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error('无法确认宿主状态，更新已延后');
  try { probe(lock.pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return;
    throw new Error('无法确认宿主状态，更新已延后');
  }
  throw new Error('宿主仍在运行，更新将在关闭平台后的下次启动执行');
}

/** An application patch cannot silently change its locked model or desktop dependencies. */
export function assertCompatibleDependencies(current, next) {
  const canonical = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
  if (current.name !== next.name || canonical(current.dependencies) !== canonical(next.dependencies)
    || canonical(current.devDependencies) !== canonical(next.devDependencies)) {
    throw new Error('新版更改运行依赖，需要完整发行包或受保护升级；现有安装保持不变');
  }
}

/** Refuse existing links in any managed target's ancestry. */
function safeTarget(root, relative) {
  root = resolve(root);
  const target = updateFile(root, relative);
  for (let cursor = target; cursor !== root; cursor = dirname(cursor)) {
    if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('更新目标包含目录链接');
  }
  return target;
}

/** Restore only the files recorded by this transaction, never entire data directories. */
export function rollbackPlatformUpdate(projectRoot, journalPath, modelLock) {
  const journal = readUpdateJson(journalPath);
  if (!existsSync(journalPath)) return false;
  if (!journal || journal.projectRoot !== resolve(projectRoot)
    || dirname(journal.backup || '') !== dirname(journalPath) || journal.modelLock !== modelLock) {
    throw Object.assign(new Error('更新事务记录损坏，必须先恢复备份'), { code: 'UPDATE_RECOVERY_REQUIRED' });
  }
  for (const item of [...journal.files].reverse()) {
    const target = safeTarget(projectRoot, item.path);
    if (item.existed) copyFileSync(join(journal.backup, item.path), target);
    else rmSync(target, { force: true });
  }
  if (journal.modelLock && existsSync(join(journal.backup, 'local-model-lock.json'))) {
    copyFileSync(join(journal.backup, 'local-model-lock.json'), journal.modelLock);
  }
  rmSync(journalPath, { force: true });
  return true;
}

/** Promote already-hashed product files with rollback and a crash-recovery journal. */
export function promotePlatformUpdate({ projectRoot, staging, manifest, directory, approve,
  beforeWrite = () => {}, dshHome = process.env.DSH_HOME || join(homedir(), '.dsh') }) {
  const backup = join(directory, `rollback-${manifest.version}`);
  const journalPath = join(directory, 'transaction.json');
  const modelLock = join(dshHome, 'model-routing.lock.json');
  const journal = { backup, files: [], modelLock, projectRoot: resolve(projectRoot) };
  mkdirSync(backup, { recursive: true });
  if (existsSync(modelLock)) copyFileSync(modelLock, join(backup, 'local-model-lock.json'));
  writeUpdateJson(journalPath, journal);
  try {
    const files = Object.keys(manifest.files).sort((a, b) => Number(a === 'package.json') - Number(b === 'package.json'));
    for (const path of files) {
      const target = safeTarget(projectRoot, path);
      if (existsSync(target) && fileHash(target) === manifest.files[path]) continue;
      const existed = existsSync(target);
      if (existed) {
        mkdirSync(dirname(join(backup, path)), { recursive: true });
        copyFileSync(target, join(backup, path));
      }
      journal.files.push({ path, existed });
      writeUpdateJson(journalPath, journal);
      beforeWrite(path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(staging, path), target);
      if (fileHash(target) !== manifest.files[path]) throw new Error('更新文件写入校验失败');
    }
    approve();
    writeUpdateJson(join(directory, 'installed-files.json'), { version: manifest.version, files: manifest.files });
    rmSync(journalPath, { force: true });
  } catch (error) {
    try { rollbackPlatformUpdate(projectRoot, journalPath, modelLock); } catch (recovery) {
      throw Object.assign(recovery, { code: 'UPDATE_RECOVERY_REQUIRED' });
    }
    throw error;
  }
}

/** Install before importing the host; never run npm, change model credentials or touch user data. */
function performPendingPlatformUpdate({ projectRoot, stateRoot, extract = extractUpdateArchive,
  approve, verify, idle = assertPlatformIdle,
  dshHome = process.env.DSH_HOME || join(homedir(), '.dsh') }) {
  const directory = join(stateRoot, 'platform-updates');
  const pendingPath = join(directory, 'pending.json');
  const journal = join(directory, 'transaction.json');
  if (!existsSync(pendingPath) && !existsSync(journal)) return { installed: false };
  idle(stateRoot);
  rollbackPlatformUpdate(projectRoot, journal, join(dshHome, 'model-routing.lock.json'));
  const pending = readUpdateJson(pendingPath);
  if (!pending && !existsSync(pendingPath)) return { installed: false };
  if (!pending) throw new Error('更新记录损坏，现有安装未改变');
  if (realpathSync(pending.projectRoot) !== realpathSync(projectRoot)
    || dirname(resolve(pending.archive)) !== resolve(directory)) throw new Error('更新请求不属于当前安装');
  const { manifest } = pending;
  validateUpdateManifest(manifest, `v${manifest.version}`);
  if (fileHash(pending.archive) !== manifest.asset.sha256) throw new Error('缓存更新包已改变');
  const staging = join(directory, `staging-${manifest.version}`);
  if (existsSync(staging)) throw new Error('发现未完成的更新暂存目录，请先检查');
  const manifestPath = join(directory, 'extract-manifest.json');
  writeUpdateJson(manifestPath, manifest);
  try {
    extract(pending.archive, staging, manifestPath);
    for (const [path, hash] of Object.entries(manifest.files)) {
      if (fileHash(safeTarget(staging, path)) !== hash) throw new Error(`更新文件校验失败: ${path}`);
    }
    const next = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
    if (next.version !== manifest.version) throw new Error('清单与应用版本不一致');
    assertCompatibleDependencies(JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')), next);
    assertProtectedModelFiles(projectRoot, manifest);
    assertSourceTreeClean(projectRoot, directory);
    const dirty = readUpdateJson(join(directory, 'installed-files.json'));
    for (const [path, hash] of Object.entries(dirty?.files || {})) {
      if (manifest.files[path] && existsSync(updateFile(projectRoot, path)) && fileHash(updateFile(projectRoot, path)) !== hash) {
        throw new Error(`检测到本地定制，未覆盖: ${path}`);
      }
    }
    const run = args => execFileSync(process.execPath, args, { cwd: projectRoot, windowsHide: true, stdio: 'pipe' });
    (verify || (() => run(['scripts/verify-model-routing.mjs'])))();
    promotePlatformUpdate({ projectRoot, staging, manifest, directory, dshHome,
      approve: approve || (() => run(['scripts/verify-model-routing.mjs', '--accept-installed-code'])) });
    rmSync(pendingPath, { force: true });
    writeUpdateJson(join(directory, 'status.json'), { currentVersion: manifest.version,
      latestVersion: manifest.version, status: 'current', message: '更新安装完成，用户数据和模型配置已保留' });
    return { installed: true, version: manifest.version };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(manifestPath, { force: true });
  }
}

/** Two simultaneous launches must not promote the same update transaction. */
export function installPendingPlatformUpdate(options) {
  const directory = join(options.stateRoot, 'platform-updates');
  if (!existsSync(join(directory, 'pending.json')) && !existsSync(join(directory, 'transaction.json'))) {
    return { installed: false };
  }
  const lease = join(directory, 'installer.lock.json');
  if (existsSync(lease)) {
    const lock = readUpdateJson(lease);
    if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0) throw new Error('无法确认更新安装器状态');
    try { process.kill(lock.pid, 0); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      rmSync(lease);
    }
  }
  try { writeFileSync(lease, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('另一个启动器正在安装更新，请稍后再试');
    throw error;
  }
  try { return performPendingPlatformUpdate(options); }
  finally { rmSync(lease, { force: true }); }
}

/** Preserve tracked local customizations instead of resetting a developer checkout. */
function assertSourceTreeClean(projectRoot, directory) {
  if (!existsSync(join(projectRoot, '.git'))) return;
  const status = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=no'],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  const baseline = readUpdateJson(join(directory, 'installed-files.json'))?.files || {};
  for (const entry of status.split('\0').filter(Boolean)) {
    const path = entry.slice(3);
    if (!/^[ M]{2} /.test(entry) || !baseline[path] || !existsSync(updateFile(projectRoot, path))
      || fileHash(updateFile(projectRoot, path)) !== baseline[path]) {
      throw new Error('本地源码有未提交修改，自动更新未覆盖，请先保存版本');
    }
  }
}

/** Model access changes need explicit review, even when the platform release is trusted. */
function assertProtectedModelFiles(projectRoot, manifest) {
  const lock = readUpdateJson(join(projectRoot, 'config/dsh/web/model-routing.lock.json'));
  const sources = Object.keys(lock?.protectedFiles || {});
  const compiled = sources.filter(path => path.startsWith('src/') && path.endsWith('.ts'))
    .flatMap(path => ['.js', '.js.map', '.d.ts'].map(extension => path.replace(/^src\//, 'dist/').replace(/\.ts$/, extension)));
  const protectedPaths = new Set([...sources, ...compiled,
    'config/dsh/web/cordis.patch.yml', 'config/dsh/web/model-routing.lock.json']);
  for (const path of protectedPaths) {
    if (manifest.files[path] && (!existsSync(updateFile(projectRoot, path))
      || fileHash(updateFile(projectRoot, path)) !== manifest.files[path])) {
      throw new Error(`新版涉及模型保护文件，需要手动审查安装：${path}`);
    }
  }
}
