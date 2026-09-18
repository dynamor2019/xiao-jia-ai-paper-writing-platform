import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_RECOVERIES = Number(process.env.PAPER_BACKGROUND_MAX_RECOVERIES || 72);
const RETRY_BASE_MS = Number(process.env.PAPER_BACKGROUND_RETRY_BASE_MS || 60_000);
const RETRY_MAX_MS = Number(process.env.PAPER_BACKGROUND_RETRY_MAX_MS || 900_000);

function saveRunState(path, state) {
  writeFileSync(path, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

function outputDirFromRunLog(projectDir, logPath) {
  try {
    const log = readFileSync(logPath, 'utf8');
    const matches = [...log.matchAll(/\[论文工作目录\]\s+([^\r\n]+)/g)];
    const value = matches.at(-1)?.[1]?.trim();
    return value ? resolve(projectDir, value) : undefined;
  } catch {
    return undefined;
  }
}

function appendLog(path, text) {
  appendFileSync(path, text, 'utf8');
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isRecoverableLog(text) {
  return /中转站上游暂不可用|Service temporarily unavailable|Connection error|TRANSPORT|fetch failed|ECONNRESET|ETIMEDOUT|TimeoutError|operation was aborted|aborted due to timeout|HTTP 408|HTTP 409|HTTP 429|HTTP 5\d\d|\[5\d\d\]|\[429\]|EMPTY_RESPONSE|completed with no visible content/i.test(text);
}

function retryDelayMs(recoveryCount) {
  const base = Number.isFinite(RETRY_BASE_MS) && RETRY_BASE_MS > 0 ? RETRY_BASE_MS : 60_000;
  const max = Number.isFinite(RETRY_MAX_MS) && RETRY_MAX_MS > 0 ? RETRY_MAX_MS : 900_000;
  return Math.min(max, base * Math.max(1, recoveryCount));
}

const requestPath = process.argv[2];
if (!requestPath || !existsSync(requestPath)) {
  process.exit(1);
}

const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const state = {
  ...request.initialState,
  pid: process.pid,
  stage: request.initialState.stage || 'starting',
};

saveRunState(request.runStatePath, state);
appendLog(request.runLogPath, `\n[后台启动器] pid=${process.pid}\n`);

async function runPipelineUntilSettled() {
  let recoveryCount = 0;

  while (true) {
    let recentOutput = '';
    state.status = 'running';
    state.error = undefined;
    state.recoveryCount = recoveryCount;
    state.stage = recoveryCount > 0 ? 'auto-recovery' : state.stage;
    saveRunState(request.runStatePath, state);

    const child = spawn(process.execPath, request.pipelineArgs, {
      cwd: request.projectDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    state.pipelinePid = child.pid;
    saveRunState(request.runStatePath, state);

    const code = await new Promise((resolveCode) => {
      const record = (chunk) => {
        const text = chunk.toString();
        recentOutput += text;
        if (recentOutput.length > 24_000) recentOutput = recentOutput.slice(-24_000);
        appendLog(request.runLogPath, text);
        const matches = [...text.matchAll(/\[阶段\s+\d+\/\d+\]\s+([^\r\n]+)/g)];
        if (matches.length > 0) {
          state.stage = matches.at(-1)[1].trim();
        }
        state.outputDir ||= outputDirFromRunLog(request.projectDir, request.runLogPath);
        saveRunState(request.runStatePath, state);
      };

      child.stdout.on('data', record);
      child.stderr.on('data', record);
      child.on('error', (error) => {
        recentOutput += `\n${error.message}`;
        resolveCode(1);
      });
      child.on('close', (exitCode) => resolveCode(exitCode ?? 1));
    });

    if (code === 0 || code === 3) {
      state.status = code === 0 ? 'completed' : 'awaiting-confirmation';
      state.exitCode = code;
      state.finishedAt = new Date().toISOString();
      saveRunState(request.runStatePath, state);
      cleanupRequest();
      return;
    }

    if (isRecoverableLog(recentOutput) && recoveryCount < MAX_RECOVERIES) {
      recoveryCount += 1;
      const waitMs = retryDelayMs(recoveryCount);
      const resumeAt = new Date(Date.now() + waitMs).toISOString();
      state.status = 'running';
      state.stage = 'auto-recovery-wait';
      state.exitCode = code;
      state.recoveryCount = recoveryCount;
      state.nextRetryAt = resumeAt;
      state.error = `可恢复服务错误，后台将在 ${Math.round(waitMs / 1000)} 秒后自动续跑`;
      appendLog(request.runLogPath, `\n[自动恢复] 第 ${recoveryCount}/${MAX_RECOVERIES} 次，${resumeAt} 从检查点继续。\n`);
      saveRunState(request.runStatePath, state);
      await delay(waitMs);
      appendLog(request.runLogPath, `\n[自动恢复] 开始第 ${recoveryCount} 次续跑。\n`);
      continue;
    }

    state.status = 'failed';
    state.exitCode = code;
    state.error = recentOutput.trim().slice(-2000) || `pipeline exited with code ${code}`;
    state.finishedAt = new Date().toISOString();
    saveRunState(request.runStatePath, state);
    cleanupRequest();
    return;
  }
}

function cleanupRequest() {
  try {
    rmSync(requestPath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

runPipelineUntilSettled().catch((error) => {
  state.status = 'failed';
  state.error = error instanceof Error ? error.message : String(error);
  state.finishedAt = new Date().toISOString();
  saveRunState(request.runStatePath, state);
  cleanupRequest();
});
