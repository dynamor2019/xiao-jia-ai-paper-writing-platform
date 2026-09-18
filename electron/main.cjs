const { app, BrowserWindow, dialog, shell } = require('electron');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { homedir } = require('node:os');

const projectRoot = resolve(__dirname, '..');
const dataRoot = resolve(process.env.PAPER_DATA_ROOT || join(process.env.USERPROFILE || homedir(), 'Documents', 'XiaoJiaAI Data'));
const stateDir = resolve(dataRoot, process.env.PAPER_STATE_DIR || '.dsh-state');
const latestWebUrlPath = join(stateDir, 'latest-web-url.txt');
const fallbackUrl = 'http://127.0.0.1:3080/';

let mainWindow;
let webProcess;

function resolveWebUrl() {
  if (!existsSync(latestWebUrlPath)) return fallbackUrl;
  const latestUrl = readFileSync(latestWebUrlPath, 'utf8').trim();
  if (!latestUrl) return fallbackUrl;
  try {
    const url = new URL(latestUrl);
    url.searchParams.set('desktop', '1');
    url.searchParams.set('dsh_ui', String(Date.now()));
    return url.toString();
  } catch {
    return fallbackUrl;
  }
}

async function isHealthy() {
  try {
    const response = await fetch(fallbackUrl, { signal: AbortSignal.timeout(3000) });
    return response.ok || response.status === 401 || response.status === 403;
  } catch {
    return false;
  }
}

async function waitForWebReady(timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHealthy()) return true;
    await new Promise((resolveReady) => setTimeout(resolveReady, 1000));
  }
  return false;
}

function startWebService() {
  webProcess = spawn(process.execPath, ['scripts/start-dsh-web.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      XIAOJIA_DESKTOP: '1',
      DSH_OPEN_BROWSER: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  webProcess.stdout.on('data', (chunk) => process.stdout.write(chunk));
  webProcess.stderr.on('data', (chunk) => process.stderr.write(chunk));
  webProcess.once('exit', (code) => {
    if (code && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('service-exit', code);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: '小贾AI科研论文写作平台',
    icon: join(projectRoot, 'config', 'dsh', 'assets', 'xiaojia-logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>小贾AI科研论文写作平台</title>
        <style>
          body {
            margin: 0;
            height: 100vh;
            display: grid;
            place-items: center;
            font-family: "Microsoft YaHei", system-ui, sans-serif;
            background: #101827;
            color: #f8fafc;
          }
          main { text-align: center; }
          img { width: 72px; height: 72px; border-radius: 16px; }
          p { color: #cbd5e1; }
        </style>
      </head>
      <body>
        <main>
          <img src="file://${join(projectRoot, 'config', 'dsh', 'assets', 'xiaojia-logo.png').replaceAll('\\', '/')}" />
          <h2>小贾AI科研论文写作平台正在启动</h2>
          <p>首次启动需要准备本地服务，请稍等。</p>
        </main>
      </body>
    </html>
  `));
}

async function boot() {
  createWindow();
  startWebService();
  const ready = await waitForWebReady();
  if (!ready) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '启动失败',
      message: '本地服务启动超时，请先双击 setup-dsh.bat 完成初始化后重试。',
    });
    return;
  }
  await mainWindow.loadURL(resolveWebUrl());
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});

app.on('before-quit', () => {
  if (webProcess && !webProcess.killed) webProcess.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
