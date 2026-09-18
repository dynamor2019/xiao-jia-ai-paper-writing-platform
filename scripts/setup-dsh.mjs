import 'dotenv/config';

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { PROJECT_ROOT, resolveDataRoot } from './project-paths.mjs';

const isWindows = process.platform === 'win32';
const args = new Set(process.argv.slice(2));
const dataRoot = resolveDataRoot();
const stateRoot = join(dataRoot, '.dsh-state');
const npmCacheRoot = join(stateRoot, 'npm-cache');
const pipCacheRoot = join(stateRoot, 'pip-cache');
const pylustratorVenv = join(stateRoot, 'pylustrator-venv');

function log(message = '') {
  console.log(message);
}

function warn(message) {
  console.warn(`提示: ${message}`);
}

function fail(message) {
  console.error(`错误: ${message}`);
  process.exit(1);
}

function windowsToken(value, isCommand = false) {
  const text = String(value);
  const safePattern = isCommand ? /^[A-Za-z0-9_.:-]+$/ : /^[A-Za-z0-9_./:=-]+$/;
  if (safePattern.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function windowsCommandLine(command, commandArgs) {
  return [
    windowsToken(command, true),
    ...commandArgs.map((arg) => windowsToken(arg)),
  ].join(' ');
}

function spawnCommand(command, commandArgs, options) {
  if (!isWindows) return spawnSync(command, commandArgs, options);
  return spawnSync(windowsCommandLine(command, commandArgs), { ...options, shell: true });
}

function run(command, commandArgs, options = {}) {
  return spawnCommand(command, commandArgs, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PAPER_DATA_ROOT: dataRoot,
      PAPER_STATE_DIR: '.dsh-state',
      PIP_CACHE_DIR: pipCacheRoot,
    },
    stdio: 'inherit',
    ...options,
  });
}

function commandWorks(command, commandArgs = ['--version']) {
  const result = spawnCommand(command, commandArgs, {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
  });
  return result.status === 0;
}

function requireCommand(command, installHint) {
  if (!commandWorks(command)) fail(`${command} 不可用。${installHint}`);
}

function nodeMajorVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return Number.isFinite(major) ? major : 0;
}

function ensureDirectories() {
  const dirs = [
    dataRoot,
    stateRoot,
    join(stateRoot, 'tmp'),
    npmCacheRoot,
    pipCacheRoot,
    join(dataRoot, 'output'),
    join(dataRoot, 'output', 'papers'),
    join(dataRoot, 'resources'),
    join(PROJECT_ROOT, 'papers', 'input'),
    join(PROJECT_ROOT, 'output'),
  ];

  for (const dir of dirs) mkdirSync(dir, { recursive: true });
}

function ensureEnvFile() {
  const envPath = join(PROJECT_ROOT, '.env');
  const examplePath = join(PROJECT_ROOT, '.env.example');
  if (!existsSync(envPath) && existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    log('已创建 .env，请按需填写模型 API Key。');
  }
}

function ensureNodeDependencies() {
  if (existsSync(join(PROJECT_ROOT, 'node_modules'))) {
    log('Node 依赖已存在，跳过 npm install。');
    return;
  }

  log('正在安装 Node 依赖，首次安装可能需要几分钟...');
  const result = run('npm', ['install', '--cache', npmCacheRoot]);
  if (result.status !== 0) fail('npm install 失败，请检查网络或 Node.js/npm 安装。');
}

function runRequiredStep(label, command, commandArgs) {
  log(label);
  const result = run(command, commandArgs);
  if (result.status !== 0) fail(`${label} 失败。`);
}

function runOptionalStep(label, command, commandArgs) {
  log(label);
  const result = run(command, commandArgs);
  if (result.status !== 0) warn(`${label} 未完成，不影响主程序启动。`);
}

function pythonCommand() {
  if (commandWorks('py', ['-3', '--version'])) return { command: 'py', baseArgs: ['-3'] };
  if (commandWorks('python', ['--version'])) return { command: 'python', baseArgs: [] };
  return null;
}

function installPylustrator() {
  const python = pythonCommand();
  if (!python) {
    warn('未检测到 Python，已跳过 Pylustrator 可选安装。');
    return;
  }

  if (!existsSync(pylustratorVenv)) {
    runOptionalStep('正在创建 Pylustrator 独立环境...', python.command, [
      ...python.baseArgs,
      '-m',
      'venv',
      pylustratorVenv,
    ]);
  }

  const pythonExe = isWindows
    ? join(pylustratorVenv, 'Scripts', 'python.exe')
    : join(pylustratorVenv, 'bin', 'python');

  if (!existsSync(pythonExe)) {
    warn('Pylustrator 独立环境不可用，已跳过可选绘图工具安装。');
    return;
  }

  runOptionalStep('正在安装 Pylustrator 可选绘图工具...', pythonExe, [
    '-m',
    'pip',
    'install',
    '--upgrade',
    'pip',
    'pylustrator',
  ]);
}

log('========================================');
log(' 小贾AI科研论文写作平台 初始化');
log('========================================');
log(`项目目录: ${PROJECT_ROOT}`);
log(`数据目录: ${dataRoot}`);
log('');

if (nodeMajorVersion() < 20) {
  fail('请安装完整 Node.js LTS 20 或更高版本: https://nodejs.org/');
}

requireCommand('npm', '请安装完整 Node.js LTS，npm 会随完整安装包一起安装。');
ensureDirectories();

if (args.has('--pylustrator-only')) {
  installPylustrator();
  process.exit(0);
}

ensureEnvFile();

if (!args.has('--skip-install')) ensureNodeDependencies();
runRequiredStep('正在连接项目数据目录...', 'node', ['scripts/link-dsh-data-root.mjs']);

if (!args.has('--skip-optional')) {
  if (commandWorks('git')) {
    runOptionalStep('正在准备 Figures for Papers 可选资源...', 'node', ['scripts/install-figures4papers.mjs']);
  } else {
    warn('未检测到 Git，已跳过 Figures for Papers 可选资源。');
  }
  installPylustrator();
}

log('');
log('初始化完成。现在可以双击 一键启动小贾AI.bat 启动项目。');
