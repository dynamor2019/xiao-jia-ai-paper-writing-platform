import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Read the core actually resolved from this installation or shared profile. */
function resolvedCoreVersion(anchor) {
  const path = createRequire(anchor).resolve('@deepseek-ai/dsh/package.json');
  return { version: JSON.parse(readFileSync(path, 'utf8')).version, path };
}

/** Compare release tuples without relying on project-specific prerelease labels. */
export function olderCore(local, shared) {
  const tuple = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
    if (!match) throw new Error(`Invalid DSH core version: ${version}`);
    return match.slice(1).map(Number);
  };
  const before = tuple(local);
  const after = tuple(shared);
  for (let index = 0; index < before.length; index++) {
    if (before[index] !== after[index]) return before[index] < after[index];
  }
  return false;
}

/** Refuse an older checkout's writes to a newer shared runtime before any sync. */
export function assertSharedRuntimeCompatible(projectRoot, home, resolveCore = resolvedCoreVersion) {
  const profile = join(home, 'profiles', 'web', 'package.json');
  if (!existsSync(profile)) return;
  const local = resolveCore(join(projectRoot, 'package.json'));
  let shared;
  try { shared = resolveCore(profile); } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return;
    throw error;
  }
  if (olderCore(local.version, shared.version)) {
    throw new Error(`拒绝旧副本覆盖共享 DSH 配置：当前 ${local.version}，共享运行时 ${shared.version}。请使用新版项目启动；新版内核位置：${shared.path}`);
  }
}
