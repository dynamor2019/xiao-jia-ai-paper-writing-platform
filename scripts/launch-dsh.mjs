import './project-env.mjs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { PROJECT_ROOT, resolveDataRoot } from './project-paths.mjs';
import { assertPlatformIdle, installPendingPlatformUpdate } from './install-platform-update.mjs';
import { registerPlatformUpdates } from './register-platform-updates.mjs';
import { patchPlatformUpdateUi } from './patch-dsh-platform-update-ui.mjs';

const stateRoot = resolve(resolveDataRoot(), process.env.PAPER_STATE_DIR || '.dsh-state');
try {
  const result = installPendingPlatformUpdate({ projectRoot: PROJECT_ROOT, stateRoot });
  if (result.installed) console.log(`小贾已自动更新至 ${result.version}`);
} catch (error) {
  if (error.code === 'UPDATE_RECOVERY_REQUIRED') throw error;
  console.warn(`平台更新未安装：${error.message}。继续使用现有版本。`);
}
try { patchPlatformUpdateUi(PROJECT_ROOT); }
catch (error) { console.warn(`版本提示未载入：${error.message}`); }
try {
  registerPlatformUpdates({ projectRoot: PROJECT_ROOT,
    dshHome: process.env.DSH_HOME || resolve(homedir(), '.dsh'), stateRoot, idle: assertPlatformIdle });
} catch (error) { console.warn(`更新入口注册已延后：${error.message}`); }
await import('./start-dsh-web.mjs');
