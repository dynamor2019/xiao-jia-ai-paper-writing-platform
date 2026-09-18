import 'dotenv/config';

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { patchFullAccessToolSchemas } from './patch-dsh-full-access-tools.mjs';
import { patchContinueButton } from './patch-dsh-continue-button.mjs';
import { patchEditRecovery } from './patch-dsh-edit-recovery.mjs';
import { patchEmptyToolCallRetry } from './patch-dsh-empty-tool-call.mjs';
import { patchWebAllLite } from './patch-dsh-web-all-lite.mjs';
import { patchJournalSelector } from './patch-dsh-journal-ui.mjs';
import { patchTodoStoppedStatus } from './patch-dsh-todo-status.mjs';
import { patchUniverExecuteSchema } from './patch-dsh-univer-execute.mjs';
import { patchWorkbenchDocxPreview } from './patch-dsh-workbench-docx-preview.mjs';
import { patchWorkbenchFloating } from './patch-dsh-workbench-floating.mjs';
import { patchWorkbenchPylustrator } from './patch-dsh-workbench-pylustrator.mjs';
import { patchIncompatibleUiBundles } from './patch-dsh-incompatible-ui-bundles.mjs';
import { patchDshBranding } from './patch-dsh-branding.mjs';
import { syncDshRuntime } from './sync-dsh-runtime.mjs';

const binPath = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const dataRoot = resolve(process.env.PAPER_DATA_ROOT || 'F:\\DSH data');
const stateDir = resolve(dataRoot, process.env.PAPER_STATE_DIR || '.dsh-state');
const tempDir = resolve(stateDir, 'tmp');
const webWorkspace = resolve(process.env.DSH_WEB_WORKSPACE || join(dataRoot, 'output'));
const npmPrefix = process.env.DSH_NPM_PREFIX || 'C:\\Users\\Administrator\\AppData\\Roaming\\npm';
const npmCache = process.env.DSH_NPM_CACHE || join(stateDir, 'npm-cache');
const lockPath = join(stateDir, 'web-supervisor.lock.json');
const cleanupStampPath = join(stateDir, 'last-cleanup.json');
const supervisorLog = join(stateDir, 'web-supervisor.log');
const childStdoutLog = join(stateDir, 'web-child.stdout.log');
const childStderrLog = join(stateDir, 'web-child.stderr.log');
const latestWebUrlPath = join(stateDir, 'latest-web-url.txt');
const healthUrl = 'http://127.0.0.1:3080/';
const fallbackBrowserUrl = `http://127.0.0.1:3080/?dsh_ui=${Date.now()}`;
const healthIntervalMs = 30_000;
const playwrightRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'ms-playwright')
  : '';
const playwrightChromium = existsSync(playwrightRoot)
  ? readdirSync(playwrightRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
    .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
    .map((entry) => join(playwrightRoot, entry.name, 'chrome-win64', 'chrome.exe'))
    .find((candidate) => existsSync(candidate))
  : undefined;
const browserCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ...(playwrightChromium ? [playwrightChromium] : []),
];
const univerRenderBrowser = process.env.UNIVER_RENDER_BROWSER
  || browserCandidates.find((candidate) => existsSync(candidate));
const defaultBrowser = browserCandidates.find((candidate) => existsSync(candidate));
const pylustratorHelper = resolve(process.env.DSH_PYLUSTRATOR_HELPER || join(process.cwd(), 'scripts', 'open_with_pylustrator.py'));
const pylustratorPython = process.env.DSH_PYLUSTRATOR_PYTHON
  || (existsSync(join(stateDir, 'pylustrator-venv', 'Scripts', 'python.exe'))
    ? join(stateDir, 'pylustrator-venv', 'Scripts', 'python.exe')
    : undefined);

if (!existsSync(binPath)) {
  console.error('未找到本地 dsh，请先运行 npm install。');
  process.exit(1);
}

function runStartupPatch(label, patch) {
  try {
    return patch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${label}跳过：${message}`);
    return false;
  }
}

function runPeriodicCleanup() {
  if (process.env.DSH_AUTO_CLEANUP === 'false') return;
  const intervalDays = Number(process.env.DSH_AUTO_CLEANUP_DAYS || '1');
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  if (existsSync(cleanupStampPath)) {
    try {
      const stamp = JSON.parse(readFileSync(cleanupStampPath, 'utf8'));
      if (Date.now() - Date.parse(stamp.lastRunAt) < intervalMs) return;
    } catch {
      // Broken stamps are replaced after a successful cleanup.
    }
  }
  const cleanup = spawnSync(process.execPath, ['scripts/cleanup-dsh-data.mjs', '--apply'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
  if (cleanup.stdout) process.stdout.write(cleanup.stdout);
  if (cleanup.stderr) process.stderr.write(cleanup.stderr);
  if (cleanup.status === 0) {
    writeFileSync(cleanupStampPath, JSON.stringify({ lastRunAt: new Date().toISOString() }, null, 2), 'utf8');
  } else {
    console.warn(`自动清理跳过：退出码 ${cleanup.status ?? 'unknown'}`);
  }
}

process.env.NPM_CONFIG_PREFIX = npmPrefix;
process.env.NPM_CONFIG_CACHE = npmCache;
process.env.NPM_CONFIG_GLOBALCONFIG = join(npmPrefix, 'etc', 'npmrc');
process.env.NODE_PATH = join(npmPrefix, 'node_modules');

const synced = await syncDshRuntime();
console.log(`论文平台配置已同步（${synced.skills} 个 skills）。`);
process.env.DSH_PERMISSION_MODE ||= 'danger-full-access';
const patchedTools = runStartupPatch('全权限工具兼容补丁', patchFullAccessToolSchemas);
console.log(`全权限工具兼容补丁已检查（更新 ${patchedTools} 个工具）。`);
const patchedUniver = runStartupPatch('Univer 执行参数补丁', patchUniverExecuteSchema);
console.log(`Univer 执行参数补丁已检查（更新 ${patchedUniver} 个运行时）。`);
console.log(`全家桶轻量兼容补丁已检查（${runStartupPatch('全家桶轻量兼容补丁', patchWebAllLite) ? '已更新' : '无需更新'}）。`);
console.log(`不兼容 UI 插件禁用补丁已检查（${runStartupPatch('不兼容 UI 插件禁用补丁', patchIncompatibleUiBundles) ? '已更新' : '无需更新'}）。`);
console.log(`小贾AI 品牌补丁已检查（${runStartupPatch('小贾AI 品牌补丁', patchDshBranding) ? '已更新' : '无需更新'}）。`);
console.log(`文件工作台右上角入口补丁已检查（${runStartupPatch('文件工作台右上角入口补丁', patchWorkbenchFloating) ? '已更新' : '无需更新'}）。`);
console.log(`文件工作台 Word 预览补丁已检查（更新 ${runStartupPatch('文件工作台 Word 预览补丁', patchWorkbenchDocxPreview)} 个文件）。`);
console.log(`文件工作台 Pylustrator 入口补丁已检查（更新 ${runStartupPatch('文件工作台 Pylustrator 入口补丁', patchWorkbenchPylustrator)} 个文件）。`);
runStartupPatch('期刊与论文工作台补丁', patchJournalSelector);
console.log(`快捷继续按钮补丁已检查（${runStartupPatch('快捷继续按钮补丁', patchContinueButton) ? '已更新' : '无需更新'}）。`);
console.log(`编辑失败恢复补丁已检查（${runStartupPatch('编辑失败恢复补丁', patchEditRecovery) ? '已更新' : '无需更新'}）。`);
console.log(`空工具调用重试补丁已检查（${runStartupPatch('空工具调用重试补丁', patchEmptyToolCallRetry) ? '已更新' : '无需更新'}）。`);
console.log(`任务停止状态补丁已检查（${runStartupPatch('任务停止状态补丁', patchTodoStoppedStatus) ? '已更新' : '无需更新'}）。`);

mkdirSync(stateDir, { recursive: true });
mkdirSync(tempDir, { recursive: true });
mkdirSync(webWorkspace, { recursive: true });
runPeriodicCleanup();
process.env.TEMP = tempDir;
process.env.TMP = tempDir;
process.env.TMPDIR = tempDir;
let child;
let stopping = false;
let ownsLock = false;

function logSupervisor(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(supervisorLog, `${line}\n`, 'utf8');
}

async function isHealthy() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    return response.ok || response.status === 401 || response.status === 403;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSupervisorLock() {
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (processIsAlive(lock.pid)) {
        logSupervisor(`检测到已有启动器 pid=${lock.pid}，本次退出。`);
        openFreshBrowser();
        process.exit(0);
      }
    } catch {
      // Broken lock files are replaced below.
    }
  }
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  ownsLock = true;
}

function runDsh() {
  let openedBrowser = false;
  child = spawn(process.execPath, [binPath, 'web', '--no-open'], {
    cwd: webWorkspace,
    env: {
      ...process.env,
      TEMP: tempDir,
      TMP: tempDir,
      TMPDIR: tempDir,
      NPM_CONFIG_PREFIX: npmPrefix,
      NPM_CONFIG_CACHE: npmCache,
      NPM_CONFIG_GLOBALCONFIG: join(npmPrefix, 'etc', 'npmrc'),
      NODE_PATH: join(npmPrefix, 'node_modules'),
      DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE || 'DISABLED',
      DSH_PYLUSTRATOR_HELPER: pylustratorHelper,
      ...(pylustratorPython ? { DSH_PYLUSTRATOR_PYTHON: pylustratorPython } : {}),
      ...(univerRenderBrowser ? { UNIVER_RENDER_BROWSER: univerRenderBrowser } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    process.stdout.write(chunk);
    appendFileSync(childStdoutLog, chunk);
    const tokenUrl = text.match(/http:\/\/127\.0\.0\.1:3080\/\?token=[^\s]+/u)?.[0];
    if (tokenUrl) writeFileSync(latestWebUrlPath, `${tokenUrl}\n`, 'utf8');
    if (!openedBrowser && text.includes('dsh web:')) {
      openedBrowser = true;
      openFreshBrowser();
    }
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(childStderrLog, chunk);
  });
  return child;
}

function openFreshBrowser() {
  if (!defaultBrowser) return;
  const browser = spawn(defaultBrowser, ['--start-fullscreen', resolveBrowserUrl()], {
    detached: true,
    stdio: 'ignore',
  });
  browser.unref();
}

function resolveBrowserUrl() {
  if (!existsSync(latestWebUrlPath)) return fallbackBrowserUrl;
  const latestUrl = readFileSync(latestWebUrlPath, 'utf8').trim();
  if (!latestUrl) return fallbackBrowserUrl;
  try {
    const url = new URL(latestUrl);
    url.searchParams.set('dsh_ui', String(Date.now()));
    return url.toString();
  } catch {
    return fallbackBrowserUrl;
  }
}

function waitForExit(processHandle) {
  return new Promise((resolve) => {
    let failedChecks = 0;
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || stopping) return;
      checking = true;
      failedChecks = await isHealthy() ? 0 : failedChecks + 1;
      checking = false;
      if (failedChecks >= 3 && !processHandle.killed) {
        logSupervisor('连续三次健康检查失败，正在重启 Web 服务。');
        processHandle.kill();
      }
    }, healthIntervalMs);
    processHandle.once('exit', (code, signal) => {
      clearInterval(timer);
      resolve({ code, signal });
    });
  });
}

function stop(signal) {
  stopping = true;
  if (child && !child.killed) child.kill(signal);
  releaseSupervisorLock();
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

function releaseSupervisorLock() {
  if (!ownsLock) return;
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (lock.pid === process.pid) rmSync(lockPath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
  ownsLock = false;
}

process.once('exit', releaseSupervisorLock);

acquireSupervisorLock();

if (await isHealthy()) {
  logSupervisor('检测到已有健康服务，本次启动无需重复运行。');
  openFreshBrowser();
  process.exit(0);
}

let restartCount = 0;
while (!stopping) {
  logSupervisor(restartCount === 0 ? '正在启动 Web 服务。' : `正在执行第 ${restartCount} 次自动重启。`);
  const result = await waitForExit(runDsh());
  if (stopping) break;
  restartCount += 1;
  logSupervisor(`Web 服务退出（code=${result.code ?? 'null'}, signal=${result.signal ?? 'none'}）。`);
  await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, restartCount * 2_000)));
}
