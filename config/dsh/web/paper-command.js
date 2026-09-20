/**
 * /paper 命令 - 基于文献 PDF 自动撰写论文
 * 用法:
 *   /paper <选题>                  # 自动读取数据目录 papers/input 下的 PDF
 *   /paper <选题> --file <路径>     # 指定单个文献文件
 *   /paper <选题> --dir <目录>      # 指定文献目录
 *   /paper <选题> --journal <期刊ID> # 按目标期刊要求写作
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, basename, extname, relative, resolve } from 'node:path';

const name = 'command-paper';
const inject = ['commands', 'goals', 'webServer', 'systemPrompt'];

const PROJECT_DIR = resolve(process.env.DSH_PAPER_PROJECT_DIR || String.raw`__DSH_PAPER_PROJECT_DIR__`);
const DATA_ROOT = resolve(process.env.PAPER_DATA_ROOT || String.raw`__PAPER_DATA_ROOT__`);
const INPUT_DIR = resolve(DATA_ROOT, process.env.PAPER_INPUT_DIR || 'papers/input');
const OUTPUT_DIR = resolve(DATA_ROOT, process.env.OUTPUT_DIR || 'output');
const STATE_ROOT = resolve(DATA_ROOT, process.env.PAPER_STATE_DIR || '.dsh-state');
const RUNS_DIR = join(STATE_ROOT, 'paper-runs');
const TARGET_JOURNAL_STATE_PATH = join(STATE_ROOT, 'target-journal.json');
const VALIDATE_SCRIPT = join(PROJECT_DIR, 'src', 'workflows', 'validate-paper.ts');
const WORD_SCRIPT = join(PROJECT_DIR, 'scripts', 'md-to-docx.mjs');
const BACKGROUND_RUNNER_SCRIPT = join(PROJECT_DIR, 'scripts', 'paper-background-runner.mjs');
const CLEANUP_SCRIPT = join(PROJECT_DIR, 'scripts', 'cleanup-dsh-data.mjs');
const PANDOC_BIN = process.env.PANDOC_PATH || 'pandoc';
const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.txt', '.md']);
const PAPER_INPUT_HINT = '<研究领域或题目> [--focus <核心贡献>] [--scope <范围边界>] [--method <方法偏好>] [--constraints <数据约束>] [--journal <期刊ID>]';
const JOURNALS = {
  'automation-in-construction': 'Automation in Construction',
  'advanced-engineering-informatics': 'Advanced Engineering Informatics',
  'journal-of-computing-in-civil-engineering': 'Journal of Computing in Civil Engineering',
  'computer-aided-civil-and-infrastructure-engineering': 'Computer-Aided Civil and Infrastructure Engineering',
  'building-and-environment': 'Building and Environment',
  'energy-and-buildings': 'Energy and Buildings',
  'journal-of-building-engineering': 'Journal of Building Engineering',
  'science-and-technology-for-the-built-environment': 'Science and Technology for the Built Environment',
  'building-services-engineering-research-and-technology': 'Building Services Engineering Research and Technology',
  'engineering-applications-of-artificial-intelligence': 'Engineering Applications of Artificial Intelligence',
  'ieee-transactions-on-automation-science-and-engineering': 'IEEE Transactions on Automation Science and Engineering',
  'expert-systems-with-applications': 'Expert Systems with Applications',
};
const WORKBENCH_STAGE_LABELS = [
  ['project-intake', '研究建档'],
  ['topic-discovery', '联网选题'],
  ['topic-confirmation', '研究问题确认'],
  ['literature-search', '文献检索'],
  ['literature-review', '文献精读'],
  ['protocol-design', '冻结研究方案'],
  ['outline-generation', '论文大纲'],
  ['experiment-execution', '实验运行'],
  ['data-validation', '数据验收'],
  ['introduction-writing', '前言与相关工作'],
  ['methods-writing', '方法与实验设置'],
  ['results-writing', '研究结果'],
  ['discussion-writing', '讨论与局限'],
  ['manuscript-completion', '摘要结论与全文'],
  ['citation-verification', '引用核验'],
  ['polishing', '润色降重'],
  ['quality-validation', '两轮评审与质量门禁'],
  ['formatting', '期刊格式'],
  ['export', '导出文件'],
  ['submission-readiness', '投稿清单'],
];

function readTargetJournalId() {
  try {
    const state = JSON.parse(readFileSync(TARGET_JOURNAL_STATE_PATH, 'utf8'));
    return typeof state.journalId === 'string' && JOURNALS[state.journalId] ? state.journalId : '';
  } catch {
    return '';
  }
}

let targetJournalId = readTargetJournalId();

function saveTargetJournalId(journalId) {
  targetJournalId = journalId;
  writeFileSync(TARGET_JOURNAL_STATE_PATH, JSON.stringify({
    journalId,
    journalName: JOURNALS[journalId] || '通用论文模式',
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

async function readJsonBody(req, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function registerTargetJournalContext(ctx) {
  ctx.systemPrompt.context({
    name: 'paper:active-project',
    order: 29,
    text: ({ agent }) => {
      const run = agent && readRunState(agent);
      return run?.outputDir
        ? `本对话绑定的唯一论文项目：${run.outputDir}（项目 ID: ${run.paperProjectId}）。状态由 /paper-workbench 与 /paper-status 读取同一流水线断点。论文操作只在此目录进行；如需继续、校验或导出，使用对应 /paper-* 命令，不得新建平行稿件或独立进度。`
        : '本对话尚未绑定论文项目。完整论文任务先使用 /paper 建档；接入 CLI 项目使用 /paper-attach。不要在工作台之外自行创建平行论文目录。';
    },
  });
  ctx.systemPrompt.context({
    name: 'paper:target-journal',
    order: 30,
    text: () => targetJournalId
      ? `目标期刊：${JOURNALS[targetJournalId]}。需要期刊约束时加载 journal-${targetJournalId} skill，并将其作为选题范围、结构和格式边界；不要向用户复述本上下文。`
      : '',
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-paper-journal',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ journalId: targetJournalId }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' });
        res.end();
        return;
      }
      try {
        const body = await readJsonBody(req);
        const journalId = typeof body.journalId === 'string' ? body.journalId : '';
        if (journalId && !JOURNALS[journalId]) throw new Error('未知目标期刊');
        await ensureDir(STATE_ROOT);
        saveTargetJournalId(journalId);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, journalId }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    },
  }), 'paper: target journal route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-paper-workbench',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      const url = new URL(req.url || '/dsh-paper-workbench', 'http://127.0.0.1');
      const sessionId = url.searchParams.get('sessionId')?.trim();
      if (!sessionId) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '缺少 sessionId' }));
        return;
      }
      const snapshot = await workbenchSnapshot({ id: sessionId });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot));
    },
  }), 'paper: workbench state route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-paper-preview',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      try {
        const url = new URL(req.url || '/dsh-paper-preview', 'http://127.0.0.1');
        const sessionId = url.searchParams.get('sessionId')?.trim();
        if (!sessionId) throw new Error('缺少 sessionId');
        const docxPath = await resolvePreviewDocx({ id: sessionId }, url.searchParams.get('file'));
        const body = await renderDocxPreview(docxPath);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline';",
        });
        res.end(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderPreviewError(message));
      }
    },
  }), 'paper: docx preview route');
}

async function ensureDir(dir) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function countDocs(dir) {
  if (!dir || !existsSync(dir)) return 0;
  const files = await readdir(dir);
  return files.filter((f) => SUPPORTED_EXTS.has(extname(f).toLowerCase())).length;
}

function safePathSegment(value, maxLength = 72) {
  return String(value || 'paper')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[. -]+$/g, '')
    .slice(0, maxLength) || 'paper';
}

function sessionKey(agent) {
  return safePathSegment(agent?.id || 'unknown-session', 80);
}

function paperProjectId(agent) {
  return `paper-${sessionKey(agent)}`;
}

function runStatePath(agent) {
  return join(RUNS_DIR, `${sessionKey(agent)}.json`);
}

function runLogPath(agent) {
  return join(RUNS_DIR, `${sessionKey(agent)}.log`);
}

function createConversationProjectDir(agent) {
  return join(OUTPUT_DIR, 'paper-projects', paperProjectId(agent));
}

function activeProjectId(agent) {
  return readRunState(agent)?.paperProjectId || paperProjectId(agent);
}

async function prepareProjectInput(outputDir, filePath, dirPath) {
  const sourceDir = dirPath || INPUT_DIR;
  const sourceFiles = filePath ? [filePath] : existsSync(sourceDir)
    ? (await readdir(sourceDir, { withFileTypes: true })).filter((entry) => entry.isFile() && SUPPORTED_EXTS.has(extname(entry.name).toLowerCase())).map((entry) => join(sourceDir, entry.name))
    : [];
  const inputDir = join(outputDir, 'input');
  if (sourceFiles.length > 0) await ensureDir(inputDir);
  for (const source of sourceFiles) {
    const dest = join(inputDir, basename(source));
    if (resolve(source) !== resolve(dest)) await copyFile(source, dest);
  }
  return await countDocs(inputDir) > 0 ? inputDir : undefined;
}

function activePaperDir(agent) {
  return readRunState(agent)?.outputDir;
}

async function collectFiles(dir, root = dir) {
  if (!dir || !existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const rows = await Promise.all(entries.map(async (entry) => {
    if (entry.name === '.dsh-state') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(path, root);
    const info = await stat(path);
    return [{ file: path.slice(root.length + 1), path, modifiedAt: info.mtimeMs, size: info.size }];
  }));
  return rows.flat();
}

async function listOutputArtifacts(baseDir) {
  const rows = await collectFiles(baseDir);
  return rows.filter((row) => row.size > 0).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function isInsideDir(childPath, parentDir) {
  const rel = relative(resolve(parentDir), resolve(childPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function resolvePreviewDocx(agent, requestedFile) {
  const baseDir = activePaperDir(agent);
  if (!baseDir) throw new Error('本对话尚未建立论文项目。');
  const artifacts = await listOutputArtifacts(baseDir);
  const requested = requestedFile ? resolve(requestedFile) : '';
  const docxPath = requested || artifacts.find((row) => row.file.toLowerCase().endsWith('.docx') && !row.file.startsWith('~$'))?.path;
  if (!docxPath) throw new Error('当前论文目录尚未找到 Word 文件。');
  if (extname(docxPath).toLowerCase() !== '.docx') throw new Error('只能预览 .docx 文件。');
  if (!isInsideDir(docxPath, baseDir)) throw new Error('拒绝预览当前论文目录之外的文件。');
  if (!existsSync(docxPath)) throw new Error(`Word 文件不存在: ${docxPath}`);
  return docxPath;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPreviewShell(title, content) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f6f7f9;color:#202124;font:16px/1.65 Cambria,Georgia,serif}.page{box-sizing:border-box;max-width:920px;min-height:100vh;margin:0 auto;padding:44px 58px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.06)}h1,h2,h3{font-family:Arial,Helvetica,sans-serif;line-height:1.25}table{border-collapse:collapse;width:100%;margin:18px 0}td,th{border:1px solid #cfd4dc;padding:6px 8px;vertical-align:top}img{max-width:100%;height:auto}pre{white-space:pre-wrap;background:#f3f4f6;padding:12px;overflow:auto}@media(max-width:720px){.page{padding:24px 18px}}</style></head><body><main class="page">${content}</main></body></html>`;
}

function renderPreviewError(message) {
  return renderPreviewShell('Word 预览不可用', `<h1>Word 预览不可用</h1><p>${escapeHtml(message)}</p><p>可先使用 /paper-export 重新导出 Word，或确认 pandoc 已安装并在 PATH 中。</p>`);
}

function renderDocxPreview(docxPath) {
  return new Promise((resolvePreview, reject) => {
    const child = spawn(PANDOC_BIN, [docxPath, '--from=docx', '--to=html5', '--standalone', '--metadata', `title=${basename(docxPath)}`], {
      cwd: PROJECT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`Pandoc 启动失败: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Pandoc 转换失败: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      const html = stdout.trim();
      resolvePreview(/^<!doctype html/i.test(html) || /^<html/i.test(html) ? html : renderPreviewShell(basename(docxPath), html));
    });
  });
}

function isManuscriptMarkdown(file) {
  return file.toLowerCase().endsWith('.md')
    && !/^(agents|readme)\.md$/i.test(file)
    && !/(quality-report|scientific-review|citation-verification|research-brief|claim-evidence|analysis-plan|data-validation|topic-discovery|submission|revision-log|publication-record|references|tables)/i.test(file);
}

async function resolveValidationTargets(rawInput, agent) {
  const args = splitArgs(rawInput || '');
  const markdownArg = args.find((arg) => arg.toLowerCase().endsWith('.md'));
  const docxArg = args.find((arg) => arg.toLowerCase().endsWith('.docx'));
  const artifacts = await listOutputArtifacts(activePaperDir(agent));
  const markdown = markdownArg
    || artifacts.find((row) => isManuscriptMarkdown(row.file))?.path;
  if (!markdown || !existsSync(markdown)) return { error: '未找到可校验的 Markdown 论文，请先生成或在命令后指定 .md 文件路径。' };
  const pairedDocx = markdown.replace(/\.md$/i, '.docx');
  const docx = docxArg || (existsSync(pairedDocx) ? pairedDocx : artifacts.find((row) => row.file.toLowerCase().endsWith('.docx'))?.path);
  return { markdown, docx: docx && existsSync(docx) ? docx : undefined };
}

function runValidation(markdown, docx) {
  return new Promise((resolve) => {
    const tsxCli = join(PROJECT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const args = [tsxCli, VALIDATE_SCRIPT, markdown];
    if (docx) args.push(docx);
    args.push('--semantic');
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

function runNodeScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: PROJECT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

function createFileIfMissing(path, content) {
  if (existsSync(path)) return false;
  writeFileSync(path, content, 'utf8');
  return true;
}

async function initializeResearchWorkspace(topic, journalId, agent) {
  const outputDir = activePaperDir(agent) || createConversationProjectDir(agent);
  const milestoneDir = join(outputDir, 'milestones');
  await ensureDir(milestoneDir);
  await ensureDir(join(outputDir, '.dsh-state'));
  const journalName = JOURNALS[journalId] || '通用论文模式';
  const created = [];
  const templates = {
    'research-brief.md': `# Research Brief\n\n- 宽泛研究领域：${topic}\n- 目标期刊：${journalName}\n- 联网选题与最终研究问题：待确认\n- 假设、预期贡献与不主张边界：待确认\n- 数据、代码、伦理与可复现要求：待确认\n- 完成标准：研究、数据、稿件、科技质量、DOCX 与投稿清单全部通过\n`,
    'topic-discovery.md': '# Topic Discovery\n\nStatus: BLOCKED - 尚未运行联网检索与研究方向评估。\n',
    'claim-evidence-matrix.md': '# Claim-Evidence Matrix\n\n| ID | 核心主张 | 证据来源 | 数据/结果位置 | 证据强度 | 冲突或缺口 | 状态 |\n|---|---|---|---|---|---|---|\n| C1 | 待确认 | 待核验 | 待定位 | 未评估 | 待检查 | BLOCKED |\n',
    'analysis-plan.md': '# Frozen Research Protocol\n\nStatus: BLOCKED - 待文献综合后冻结假设、变量、数据、基线、对照、消融、统计、伦理、失败规则和复现设置。\n',
    'data-validation.md': '# Data Validation\n\nStatus: BLOCKED - 尚无通过程序获取并验收的实验数据。\n',
    'submission-checklist.md': `# Submission Checklist\n\n- [ ] 目标期刊范围与最新作者指南已核对：${journalName}\n- [ ] 源稿质量门禁 PASS\n- [ ] 独立科技审查无 critical/major 问题\n- [ ] DOCX 公式、表格、图片和交叉引用检查 PASS\n- [ ] 引用真实性审计 PASS\n- [ ] 作者贡献、利益冲突、数据/代码可用性及 AI 声明完整\n- [ ] Cover letter、Highlights、图表与补充材料齐全\n`,
    'revision-log.md': '# Revision Log\n\n| Version | Date | Trigger | Changes | Evidence rerun | Quality status |\n|---|---|---|---|---|---|\n',
    'publication-record.md': `# Publication Record\n\n- 目标期刊：${journalName}\n- 投稿日期：待填写\n- Manuscript ID：待填写\n- 编辑决定：未投稿\n- 审稿轮次：0\n- 接收日期：待填写\n- DOI / 正式链接：待填写\n`,
  };
  for (const [file, content] of Object.entries(templates)) {
    if (createFileIfMissing(join(milestoneDir, file), content)) created.push(file);
  }
  writeFileSync(join(outputDir, '.dsh-state', 'research-workspace.json'), JSON.stringify({ topic, journalId, journalName, outputDir, paperProjectId: activeProjectId(agent), updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  const current = readRunState(agent);
  saveRunState(agent, { ...current, topic, journalId, journalName, outputDir, status: current?.status || 'initialized' });
  return { created, journalName, outputDir };
}

function readWorkspaceState(agent) {
  try {
    const outputDir = activePaperDir(agent);
    return outputDir ? JSON.parse(readFileSync(join(outputDir, '.dsh-state', 'research-workspace.json'), 'utf8')) : null;
  } catch {
    return null;
  }
}

function readPipelineState(outputDir) {
  try {
    return JSON.parse(readFileSync(join(outputDir, '.dsh-state', 'paper-pipeline-state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function splitArgs(input) {
  const args = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(input)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

function normalizePaperTopic(input) {
  const text = input.replace(/\s+/g, ' ').trim();
  const titleMatch = text.match(/题目[:：]\s*(.*?)(?=\s+(?:目标|范围|要求)[:：]|$)/);
  const scopeMatch = text.match(/核心创新[^:：]*[:：]\s*([^。.\n]+)/) || text.match(/范围[:：]\s*([^。.\n]+)/);
  const title = (titleMatch?.[1] || text).trim();
  const scope = scopeMatch?.[1]?.trim();
  if (!scope || title.includes(scope)) return title;
  return `${title}; scope: ${scope}`;
}

function readRunState(agent) {
  try {
    return JSON.parse(readFileSync(runStatePath(agent), 'utf8'));
  } catch {
    return null;
  }
}

function saveRunState(agent, state) {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(runStatePath(agent), JSON.stringify({ ...state, sessionId: String(agent?.id || ''), paperProjectId: state.paperProjectId || paperProjectId(agent), updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function outputDirFromRunLog(agent) {
  try {
    const log = readFileSync(runLogPath(agent), 'utf8');
    const matches = [...log.matchAll(/\[论文工作目录\]\s+([^\r\n]+)/g)];
    const value = matches.at(-1)?.[1]?.replace(/^\s+/, '');
    return value ? resolve(PROJECT_DIR, value) : undefined;
  } catch {
    return undefined;
  }
}

function activeProjectPid(outputDir) {
  if (!outputDir) return undefined;
  try {
    const { pid } = JSON.parse(readFileSync(join(outputDir, '.dsh-state', 'paper-pipeline.lock.json'), 'utf8'));
    return processIsRunning(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function startPipeline(ctx, topic, inputDir, journalId, experimentCommand, resultsFile, outputDir, agent, approvalMode = 'topic', researchDirection = {}) {
  const ownerPid = activeProjectPid(outputDir);
  if (ownerPid) throw new Error(`论文项目正在进程 ${ownerPid} 中运行，请等待完成后再恢复。`);
  const tsxCli = join(PROJECT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const pipeline = join(PROJECT_DIR, 'src', 'workflows', 'paper-pipeline.ts');
  const statePath = runStatePath(agent);
  const logPath = runLogPath(agent);
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  if (existsSync(join(outputDir, '.dsh-state', 'paper-pipeline-state.json'))) appendFileSync(logPath, `\n[断点恢复] ${new Date().toISOString()}\n`, 'utf8');
  else writeFileSync(logPath, '', 'utf8');

  const pipelineArgs = [tsxCli, pipeline, topic];
  if (inputDir) pipelineArgs.push('--input-dir', inputDir);
  if (journalId) pipelineArgs.push('--journal', journalId);
  if (experimentCommand) pipelineArgs.push('--experiment-command', experimentCommand);
  if (resultsFile) pipelineArgs.push('--results-file', resultsFile);
  if (researchDirection.focus) pipelineArgs.push('--focus', researchDirection.focus);
  if (researchDirection.scope) pipelineArgs.push('--scope', researchDirection.scope);
  if (researchDirection.method) pipelineArgs.push('--method', researchDirection.method);
  if (researchDirection.constraints) pipelineArgs.push('--constraints', researchDirection.constraints);
  pipelineArgs.push('--approval-mode', approvalMode);
  pipelineArgs.push('--output-dir', outputDir);
  pipelineArgs.push('--project-id', activeProjectId(agent));
  const requestPath = join(RUNS_DIR, `${sessionKey(agent)}-${Date.now()}.request.json`);
  writeFileSync(requestPath, JSON.stringify({
    projectDir: PROJECT_DIR,
    runStatePath: statePath,
    runLogPath: logPath,
    pipelineArgs,
    initialState: {
      sessionId: String(agent?.id || ''),
      topic,
      inputDir,
      journalId,
      journalName: journalId ? JOURNALS[journalId] : undefined,
      experimentCommand,
      resultsFile,
      researchDirection,
      approvalMode,
      outputDir,
      paperProjectId: activeProjectId(agent),
      status: 'running',
      stage: 'starting',
      startedAt: new Date().toISOString(),
      logPath,
    },
  }, null, 2), 'utf8');
  const child = spawn(process.execPath, [BACKGROUND_RUNNER_SCRIPT, requestPath], {
    cwd: PROJECT_DIR,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const state = { topic, inputDir, journalId, journalName: journalId ? JOURNALS[journalId] : undefined, experimentCommand, resultsFile, researchDirection, approvalMode, outputDir, paperProjectId: activeProjectId(agent), status: 'running', stage: 'starting', pid: child.pid, startedAt: new Date().toISOString(), logPath };
  saveRunState(agent, state);
  return state;
}

function goalStatusText(ctx, invocation) {
  const goal = ctx.goals.get(invocation.agent);
  if (!goal) return '对话目标: 未设置';
  if (goal.phase === 'complete') return '对话目标: 已完成';
  if (goal.activation === 'armed') return `对话目标: 正在执行 (${goal.roundsStarted}/${goal.maxGoalRounds})`;
  return `对话目标: 等待恢复 (${goal.roundsStarted}/${goal.maxGoalRounds})\n提示: 任务列表是持久快照，并不表示模型仍在执行；使用 /paper-resume 恢复。`;
}

function statusText(ctx, invocation) {
  const state = readRunState(invocation.agent);
  const goalStatus = goalStatusText(ctx, invocation);
  if (!state) return `${goalStatus}\n后台流水线: 尚未启动`;
  const running = state.status === 'running' && processIsRunning(state.pid);
  if (state.status === 'running' && !running) {
    state.status = 'failed';
    state.error = '后台进程已退出；请重新发送 /paper 启动新的论文任务。';
    state.finishedAt ||= new Date().toISOString();
    saveRunState(invocation.agent, state);
  }
  const status = running && state.stage === 'auto-recovery-wait'
    ? '自动恢复等待'
    : running
      ? '运行中'
      : state.status === 'awaiting-confirmation'
        ? '等待确认研究问题'
        : state.status === 'completed'
          ? '已完成'
          : '已失败';
  const retryLine = running && state.nextRetryAt ? `下次自动续跑: ${state.nextRetryAt}` : undefined;
  let tail = '';
  try {
    tail = readFileSync(runLogPath(invocation.agent), 'utf8').trim().split(/\r?\n/).slice(-12).join('\n');
  } catch {
    tail = '暂无日志。';
  }
  return [goalStatus, `后台流水线: ${status}`, retryLine, `选题: ${state.topic}`, `目标期刊: ${state.journalName || '通用论文模式'}`, `当前阶段: ${state.stage}`, `开始时间: ${state.startedAt}`, `日志: ${state.logPath}`, '', '最近进度:', tail || '任务刚刚启动。'].filter(Boolean).join('\n');
}

async function workbenchText(ctx, invocation) {
  const snapshot = await workbenchSnapshot(invocation.agent);
  if (!snapshot.project) return `${statusText(ctx, invocation)}\n论文项目: 尚未建立，请先使用 /paper。`;
  return [
    '科技论文工作台',
    `项目: ${snapshot.topic}`,
    `推荐研究问题: ${snapshot.recommendedTopic || '尚未生成'}`,
    `目标期刊: ${snapshot.journalName}`,
    statusText(ctx, invocation),
    '',
    ...snapshot.stages.map((stage, index) => `${index + 1}. ${stage.label}: ${stage.passed ? 'READY' : 'BLOCKED'}`),
    '',
    `输入资料: ${snapshot.inputCount} 个文件`,
    `可交付文件: ${snapshot.deliverableCount} 个`,
    `质量门禁: ${snapshot.quality}`,
    snapshot.latestReport ? `最新报告: ${snapshot.latestReport}` : '最新报告: 尚未生成',
    '',
    snapshot.runStatus === 'awaiting-confirmation' ? '请使用 /paper-confirm 确认推荐研究问题，随后全部阶段将自动执行。' : '工作台和 /paper 命令读取同一流水线状态。',
  ].join('\n');
}

async function workbenchSnapshot(agent) {
  const state = readRunState(agent);
  const baseDir = state?.outputDir;
  if (!baseDir) {
    return {
      project: false,
      runStatus: 'idle',
      stage: 'project-intake',
      stages: WORKBENCH_STAGE_LABELS.map(([id, label]) => ({ id, label, passed: false, status: 'pending' })),
      progress: { completed: 0, total: WORKBENCH_STAGE_LABELS.length, percent: 0 },
      inputCount: 0,
      deliverableCount: 0,
      quality: '未运行',
    };
  }
  const running = state.status === 'running' && processIsRunning(state.pid);
  if (state.status === 'running' && !running) {
    state.status = 'failed';
    state.error = '后台进程已退出；可从断点恢复。';
    saveRunState(agent, state);
  }
  const artifacts = await listOutputArtifacts(baseDir);
  const reports = artifacts.filter((row) => /(quality-report|scientific-review|citation-verification)/i.test(row.file));
  const deliverables = artifacts.filter((row) => /\.(md|docx|tex|bib)$/i.test(row.file) && !reports.includes(row));
  const latestReport = reports[0];
  const qualityReports = reports.filter((row) => /(paper-quality-report|docx-quality-report|final-scientific-review)/i.test(row.file));
  const qualityTexts = qualityReports.map((row) => readFileSync(row.path, 'utf8'));
  const quality = qualityTexts.length === 0 ? '未运行'
    : qualityTexts.some((value) => /\bBLOCKED\b|Verdict:\s*(?:major revision|reject)/i.test(value)) ? 'BLOCKED'
      : qualityReports.some((row, index) => /paper-quality-report/i.test(row.file) && /\bPASS\b|Verdict:\s*pass/i.test(qualityTexts[index])) ? 'PASS' : '需复核';
  const manuscript = deliverables.find((row) => isManuscriptMarkdown(row.file));
  const word = deliverables.find((row) => row.file.toLowerCase().endsWith('.docx') && !row.file.startsWith('~$'));
  const workspace = readWorkspaceState(agent);
  const pipeline = readPipelineState(baseDir);
  const runStatus = running ? 'running' : state.status;
  const pipelineStage = WORKBENCH_STAGE_LABELS.some(([id]) => id === state.stage) ? state.stage : pipeline?.stage || 'project-intake';
  const currentIndex = Math.max(0, WORKBENCH_STAGE_LABELS.findIndex(([id]) => id === pipelineStage));
  const stages = WORKBENCH_STAGE_LABELS.map(([id, label], index) => {
    let status = index < currentIndex ? 'complete' : 'pending';
    if (runStatus === 'completed') status = 'complete';
    if (index === currentIndex && ['running', 'awaiting-confirmation'].includes(runStatus)) status = 'active';
    if (index === currentIndex && runStatus === 'failed') status = 'error';
    if (id === 'project-intake' && existsSync(join(baseDir, 'milestones', 'research-brief.md')) && status === 'pending') status = 'complete';
    if (id === 'export' && word && status === 'pending') status = 'complete';
    if (id === 'quality-validation' && quality === 'PASS' && status === 'pending') status = 'complete';
    return { id, label, passed: status === 'complete', status };
  });
  const completed = stages.filter((stage) => stage.passed).length;
  return {
    project: true,
    topic: workspace?.topic || state.topic,
    recommendedTopic: pipeline?.topic,
    researchDirection: workspace?.researchDirection || state.researchDirection || pipeline?.metadata?.researchDirection || {},
    journalName: workspace?.journalName || state.journalName || '通用论文模式',
    outputDir: baseDir,
    paperProjectId: workspace?.paperProjectId || pipeline?.metadata?.paperProjectId || state.paperProjectId || paperProjectId(agent),
    runStatus,
    stage: state.stage || pipelineStage,
    nextRetryAt: state.nextRetryAt,
    recoveryCount: state.recoveryCount,
    stages,
    progress: { completed, total: stages.length, percent: Math.round((completed / stages.length) * 100) },
    inputCount: await countDocs(state.inputDir || join(baseDir, 'input')),
    deliverableCount: deliverables.length,
    quality,
    latestReport: latestReport?.path,
    latestWord: word?.path,
    latestWordPreviewUrl: word ? `/dsh-paper-preview?sessionId=${encodeURIComponent(agent?.id || '')}&file=${encodeURIComponent(word.path)}` : '',
    error: state.error,
  };
}

function artifactPassed(path) {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, 'utf8');
  return content.trim().length > 40 && !/Status:\s*BLOCKED|待确认|尚未/i.test(content);
}

async function submissionText(agent) {
  const baseDir = activePaperDir(agent);
  if (!baseDir) return 'SUBMISSION BLOCKED\n- 尚未建立本对话的论文项目。';
  const artifacts = await listOutputArtifacts(baseDir);
  const latestMarkdown = artifacts.find((row) => isManuscriptMarkdown(row.file));
  const latestDocx = artifacts.find((row) => row.file.toLowerCase().endsWith('.docx') && !row.file.startsWith('~$'));
  const report = artifacts.find((row) => /quality-report\.md$/i.test(row.file));
  const reportText = report ? readFileSync(report.path, 'utf8') : '';
  const qualityPassed = Boolean(report) && /\bPASS\b|Verdict:\s*pass/i.test(reportText) && !/\bBLOCKED\b|Verdict:\s*(?:major revision|reject)/i.test(reportText);
  const checks = [
    ['论文 Markdown 源稿', Boolean(latestMarkdown), latestMarkdown?.path],
    ['正式 Word 文件', Boolean(latestDocx), latestDocx?.path],
    ['质量门禁 PASS', qualityPassed, report?.path],
    ['引用核验报告', artifacts.some((row) => /citation-verification/i.test(row.file))],
    ['投稿清单', existsSync(join(baseDir, 'milestones', 'submission-manifest.md')), join(baseDir, 'milestones', 'submission-manifest.md')],
    ['Cover letter', artifacts.some((row) => /cover[-_ ]letter/i.test(row.file))],
    ['作者与研究声明', artifacts.some((row) => /(declaration|authorship|research-integrity)/i.test(row.file))],
    ['修订追踪', existsSync(join(baseDir, 'milestones', 'revision-log.md')), join(baseDir, 'milestones', 'revision-log.md')],
    ['投稿与发表记录', existsSync(join(baseDir, 'milestones', 'publication-record.md')), join(baseDir, 'milestones', 'publication-record.md')],
  ];
  const ready = checks.every(([, passed]) => passed);
  return [ready ? 'SUBMISSION READY' : 'SUBMISSION BLOCKED', ...checks.map(([label, passed, path]) => `- ${passed ? 'PASS' : 'BLOCKED'} ${label}${path ? `: ${path}` : ''}`), '', ready ? '投稿包已满足平台验收条件，仍需在期刊官网核对当天的易变要求。' : '先修复所有 BLOCKED 项，不得把生成文件等同于投稿完成。'].join('\n');
}

function apply(ctx) {
  registerTargetJournalContext(ctx);

  ctx.commands.register({
    name: 'paper',
    description: '从联网选题、研究设计、实验运行到写作、校验和投稿的一站式流水线',
    input: {
      hint: PAPER_INPUT_HINT,
      images: false,
    },
    handler: async (invocation) => handlePaperCommand(ctx, invocation),
  });

  ctx.commands.register({
    name: 'paper-project',
    description: '初始化一站式论文项目及研究、证据、实验和投稿台账',
    input: { hint: '<研究主题> [--journal <期刊ID>]', images: false },
    handler: async (invocation) => {
      const parts = splitArgs(invocation.rawInput?.trim() || '');
      let journalId = '';
      const topicParts = [];
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '--journal' && parts[i + 1]) { journalId = parts[++i].toLowerCase(); } else { topicParts.push(parts[i]); }
      }
      journalId ||= targetJournalId;
      const topic = topicParts.join(' ').trim();
      if (!topic) return { kind: 'error', text: '请填写研究主题后再初始化论文项目。' };
      if (journalId && !JOURNALS[journalId]) return { kind: 'error', text: `未知期刊 ID: ${journalId}` };
      const existing = readRunState(invocation.agent);
      if (existing?.topic && existing.topic !== topic) {
        return { kind: 'error', text: `一个对话只对应一篇论文。本对话已绑定“${existing.topic}”，请新建对话后再建立新论文。` };
      }
      const result = await initializeResearchWorkspace(topic, journalId, invocation.agent);
      return { kind: 'success', text: [`论文项目已建立: ${topic}`, `目标期刊: ${result.journalName}`, `新建台账: ${result.created.length ? result.created.join(', ') : '已有文件均已保留，未覆盖'}`, `本对话论文目录: ${result.outputDir}`, '', '下一步先完善 research-brief.md 与 analysis-plan.md，再进入证据综合和逐段写作。'].join('\n') };
    },
  });

  ctx.commands.register({
    name: 'paper-attach',
    description: '将 CLI 创建的论文项目接入当前对话工作台',
    input: { hint: '<论文项目ID>', images: false },
    handler: async (invocation) => {
      const projectId = invocation.rawInput?.trim() || '';
      if (!/^paper-[a-zA-Z0-9_-]+$/.test(projectId)) return { kind: 'error', text: '请填写有效的论文项目 ID。' };
      if (readRunState(invocation.agent)?.outputDir) return { kind: 'error', text: '当前对话已绑定论文项目，请新建对话后再接入。' };
      const outputDir = join(OUTPUT_DIR, 'paper-projects', projectId);
      const checkpoint = readPipelineState(outputDir);
      if (!checkpoint?.topic) return { kind: 'error', text: '未找到该项目的流水线检查点。' };
      const awaiting = checkpoint.metadata?.awaitingApproval === 'topic-confirmation';
      const ownerPid = activeProjectPid(outputDir);
      saveRunState(invocation.agent, {
        topic: checkpoint.metadata?.originalTopic || checkpoint.topic,
        journalId: checkpoint.metadata?.targetJournalId,
        researchDirection: checkpoint.metadata?.researchDirection || {},
        inputDir: checkpoint.metadata?.inputDir || (existsSync(join(outputDir, 'input')) ? join(outputDir, 'input') : undefined),
        outputDir,
        paperProjectId: projectId,
        status: ownerPid ? 'running' : awaiting ? 'awaiting-confirmation' : existsSync(join(outputDir, 'milestones', 'submission-manifest.md')) && /READY FOR AUTHOR CONFIRMATION/.test(readFileSync(join(outputDir, 'milestones', 'submission-manifest.md'), 'utf8')) ? 'completed' : 'failed',
        stage: checkpoint.stage,
        pid: ownerPid,
        startedAt: checkpoint.createdAt || new Date().toISOString(),
        logPath: runLogPath(invocation.agent),
      });
      return { kind: 'success', text: `已接入论文项目 ${projectId}。使用 /paper-workbench 查看状态；需要继续时使用 /paper-resume。` };
    },
  });

  ctx.commands.register({
    name: 'paper-confirm',
    description: '确认联网推荐的最终研究问题，并从同一断点自动完成余下论文流程',
    input: { hint: '[无参数]', images: false },
    handler: async (invocation) => {
      const run = readRunState(invocation.agent);
      if (!run?.outputDir) return { kind: 'error', text: '本对话尚未启动论文流程。' };
      if (run.status !== 'awaiting-confirmation' || run.stage !== 'topic-confirmation') {
        return { kind: 'error', text: '当前不处于研究问题确认阶段，请使用 /paper-status 查看真实状态。' };
      }
      if (activeProjectPid(run.outputDir)) return { kind: 'error', text: '论文项目仍在运行，请等待完成后再确认。' };
      const pipeline = readPipelineState(run.outputDir);
      if (!pipeline?.topic) return { kind: 'error', text: '没有找到联网选题结果，无法确认。' };
      startPipeline(ctx, run.topic, run.inputDir, run.journalId, run.experimentCommand, run.resultsFile, run.outputDir, invocation.agent, 'auto', run.researchDirection);
      return { kind: 'success', text: [`已确认最终研究问题: ${pipeline.topic}`, `论文目录: ${run.outputDir}`, '', '同一流水线已从断点继续；后续文献、方案、数据集、程序实验、写作、两轮评审、格式和投稿包将自动执行。'].join('\n') };
    },
  });

  ctx.commands.register({
    name: 'paper-export',
    description: '从最新或指定 Markdown 生成正式 Word 并执行 DOCX 质量检查',
    input: { hint: '[paper.md] [paper.docx]', images: false },
    handler: async (invocation) => {
      const targets = await resolveValidationTargets(invocation.rawInput?.trim(), invocation.agent);
      if (targets.error) return { kind: 'error', text: targets.error };
      const output = targets.docx || targets.markdown.replace(/\.md$/i, '.docx');
      const result = await runNodeScript(WORD_SCRIPT, [targets.markdown, output]);
      return { kind: result.code === 0 ? 'success' : 'error', text: result.output || `Word 文档: ${output}` };
    },
  });

  ctx.commands.register({
    name: 'paper-submission',
    description: '执行投稿包完整性验收并列出所有阻断项',
    input: { hint: '[无参数]', images: false },
    handler: async (invocation) => ({ kind: 'success', text: await submissionText(invocation.agent) }),
  });

  ctx.commands.register({
    name: 'cleanup',
    description: '清理 DSH 低风险临时文件、日志、缓存和散乱图脚本；默认只预览',
    input: { hint: '[--apply]', images: false },
    handler: async (invocation) => {
      const args = splitArgs(invocation.rawInput?.trim() || '');
      const applyCleanup = args.includes('--apply');
      const result = await runNodeScript(CLEANUP_SCRIPT, [applyCleanup ? '--apply' : '--dry-run']);
      return { kind: result.code === 0 ? 'success' : 'error', text: result.output || 'cleanup finished' };
    },
  });

  ctx.commands.register({
    name: 'paper-workbench',
    description: '查看论文研究空间、真实运行状态、证据输入、质量门禁和产物概况',
    input: { hint: '[无参数]', images: false },
    handler: async (invocation) => ({ kind: 'success', text: await workbenchText(ctx, invocation) }),
  });

  ctx.commands.register({
    name: 'paper-artifacts',
    description: '列出论文输出、质量报告及更新时间顺序',
    input: { hint: '[无参数]', images: false },
    handler: async (invocation) => {
      const baseDir = activePaperDir(invocation.agent);
      const artifacts = await listOutputArtifacts(baseDir);
      if (artifacts.length === 0) return { kind: 'success', text: baseDir ? `本对话论文目录暂无里程碑产物: ${baseDir}` : '本对话尚未建立论文项目。' };
      return {
        kind: 'success',
        text: ['论文产物（按更新时间排序）:', ...artifacts.map((row) => `- ${row.file} (${Math.ceil(row.size / 1024)} KB)\n  ${row.path}`)].join('\n'),
      };
    },
  });

  ctx.commands.register({
    name: 'paper-validate',
    description: '对论文源稿和 Word 执行结构、公式、图表及独立科技质量门禁',
    input: { hint: '[paper.md] [paper.docx]', images: false },
    handler: async (invocation) => {
      const targets = await resolveValidationTargets(invocation.rawInput?.trim(), invocation.agent);
      if (targets.error) return { kind: 'error', text: targets.error };
      const result = await runValidation(targets.markdown, targets.docx);
      const header = [`源稿: ${targets.markdown}`, `Word: ${targets.docx || '未找到，已跳过 DOCX 二次检查'}`].join('\n');
      if (result.code === 0 || result.code === 2) {
        return { kind: 'success', text: `${header}\n\n${result.output || (result.code === 0 ? 'PASS' : 'BLOCKED')}` };
      }
      return { kind: 'error', text: `${header}\n\n校验执行失败:\n${result.output}` };
    },
  });

  ctx.commands.register({
    name: 'journals',
    description: '列出可用的 AI + MEP 目标期刊及调用 ID',
    input: { hint: '[无参数]', images: false },
    handler: async () => ({
      kind: 'success',
      text: ['已内置以下非 MDPI 期刊：', ...Object.entries(JOURNALS).map(([id, title]) => `- ${title}: ${id}`), '', '用法: /paper <选题> --journal <期刊ID>'].join('\n'),
    }),
  });

  ctx.commands.register({
    name: 'paper-status',
    description: '查看对话目标、论文流水线和最近日志',
    input: { hint: '[无参数]', images: false },
    handler: async (invocation) => ({ kind: 'success', text: statusText(ctx, invocation) }),
  });

  ctx.commands.register({
    name: 'paper-resume',
    description: '恢复因停止或服务重启而中断的论文目标',
    input: { hint: '[无参数]', images: false },
    handler: async (invocation) => {
      const messages = [];
      const goal = ctx.goals.get(invocation.agent);
      if (goal && goal.phase !== 'complete' && !(goal.phase === 'active' && goal.activation === 'armed')) {
        ctx.goals.resume(invocation.agent, { id: goal.id, revision: goal.revision });
        messages.push('对话目标已恢复。');
      }

      const run = readRunState(invocation.agent);
      if (run?.status === 'awaiting-confirmation') {
        return { kind: 'error', text: '流水线正在等待你确认最终研究问题，请使用 /paper-confirm。' };
      }
      const pipelineRunning = run?.status === 'running' && processIsRunning(run.pid);
      const projectRunning = activeProjectPid(run?.outputDir);
      if (projectRunning) return { kind: 'success', text: `论文项目正在进程 ${projectRunning} 中运行，无需重复恢复。` };
      if (run && run.status !== 'completed' && !pipelineRunning) {
        const outputDir = run.outputDir || outputDirFromRunLog(invocation.agent);
        const checkpoint = outputDir && join(outputDir, '.dsh-state', 'paper-pipeline-state.json');
        if (!checkpoint || !existsSync(checkpoint)) {
          return { kind: 'error', text: '找到中断任务，但没有可用的流水线检查点；请使用 /paper 重新开始。' };
        }
        startPipeline(ctx, run.topic, run.inputDir, run.journalId, run.experimentCommand, run.resultsFile, outputDir, invocation.agent, run.approvalMode || 'auto', run.researchDirection);
        messages.push(`后台流水线已从检查点恢复：${outputDir}`);
      } else if (pipelineRunning) {
        messages.push('后台流水线正在运行，无需重复恢复。');
      }

      if (messages.length === 0) return { kind: 'error', text: '当前没有可恢复的论文任务。' };
      return { kind: 'success', text: messages.join('\n') };
    },
  });

  async function handlePaperCommand(ctx, invocation) {
      const raw = invocation.rawInput?.trim() || '';
      if (!raw) {
        return {
          kind: 'success',
          text: `用法: /paper ${PAPER_INPUT_HINT}\n流程将在联网选题后暂停一次，确认研究问题后自动完成其余阶段。`,
        };
      }

      // 解析参数
      let topic = '';
      let filePath = '';
      let dirPath = '';
      let journalId = '';
      let experimentCommand = '';
      let resultsFile = '';
      const researchDirection = {};
      const parts = splitArgs(raw);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '--file' && parts[i + 1]) {
          filePath = parts[i + 1];
          i++;
        } else if (parts[i] === '--dir' && parts[i + 1]) {
          dirPath = parts[i + 1];
          i++;
        } else if (parts[i] === '--journal' && parts[i + 1]) {
          journalId = parts[i + 1].toLowerCase();
          i++;
        } else if (parts[i] === '--experiment-command' && parts[i + 1]) {
          experimentCommand = parts[++i];
        } else if (parts[i] === '--results-file' && parts[i + 1]) {
          resultsFile = parts[++i];
        } else if (parts[i] === '--focus' && parts[i + 1]) {
          researchDirection.focus = parts[++i];
        } else if (parts[i] === '--scope' && parts[i + 1]) {
          researchDirection.scope = parts[++i];
        } else if (parts[i] === '--method' && parts[i + 1]) {
          researchDirection.method = parts[++i];
        } else if (parts[i] === '--constraints' && parts[i + 1]) {
          researchDirection.constraints = parts[++i];
        } else if (!parts[i].startsWith('--')) {
          topic = topic ? topic + ' ' + parts[i] : parts[i];
        }
      }
      journalId ||= targetJournalId;

      if (!topic) {
        return { kind: 'error', text: '请提供论文选题。用法: /paper <选题>' };
      }
      topic = normalizePaperTopic(topic);
      if (journalId && !JOURNALS[journalId]) {
        return { kind: 'error', text: `未知期刊 ID: ${journalId}\n使用 /journals 查看可用列表。` };
      }

      try {
        await ensureDir(OUTPUT_DIR);
        await ensureDir(STATE_ROOT);

        const currentRun = readRunState(invocation.agent);
        if (currentRun?.status === 'running' && processIsRunning(currentRun.pid)) {
          return { kind: 'error', text: `已有论文任务正在运行（${currentRun.stage}）。使用 /paper-status 查看进度。` };
        }
        if (currentRun?.topic && currentRun.topic !== topic) {
          return { kind: 'error', text: `一个对话只对应一篇论文。本对话已绑定“${currentRun.topic}”，请新建对话后再开始新论文。` };
        }

        if (filePath && dirPath) return { kind: 'error', text: '--file 和 --dir 只能选择一个。' };
        if (filePath) {
          if (!existsSync(filePath)) {
            return { kind: 'error', text: `文件不存在: ${filePath}` };
          }
          if (!SUPPORTED_EXTS.has(extname(filePath).toLowerCase())) {
            return { kind: 'error', text: '只支持 PDF / DOCX / TXT / MD 文件' };
          }
        }
        if (dirPath) {
          if (!existsSync(dirPath) || !(await stat(dirPath)).isDirectory()) {
            return { kind: 'error', text: `目录不存在: ${dirPath}` };
          }
        }
        const outputDir = currentRun?.outputDir || createConversationProjectDir(invocation.agent);
        const useDir = currentRun?.outputDir && currentRun.status !== 'initialized'
          ? currentRun.inputDir
          : await prepareProjectInput(outputDir, filePath, dirPath);
        const docCount = await countDocs(useDir);
        const runState = startPipeline(ctx, topic, useDir, journalId, experimentCommand, resultsFile, outputDir, invocation.agent, 'topic', researchDirection);

        const fileInfo = filePath ? `文献: ${basename(filePath)}` : docCount > 0 ? `本地文献数量: ${docCount} 篇` : '本地文献: 无，将使用联网检索';
        const successText = [
          `论文研究生命周期已启动`,
          `研究领域: ${topic}`,
          `目标期刊: ${journalId ? JOURNALS[journalId] : '通用论文模式'}`,
          `方向控制: ${Object.values(researchDirection).filter(Boolean).join('；') || '由联网选题自动细化'}`,
          fileInfo,
          `文献目录: ${useDir || '联网检索'}`,
          `本对话论文目录: ${runState.outputDir}`,
          `日志: ${runState.logPath}`,
          '',
          '关键阶段:',
          '  联网选题 → 研究方案',
          `  文献与前言 → 实验运行与数据验收 → 方法、结果和讨论`,
          '  两轮跨模型专家评审 → 期刊格式 → 导出与投稿包',
          '',
          '联网选题完成后，工作台会等待你确认最终研究问题；确认后自动完成其余阶段。',
        ].join('\n');
        return {
          kind: 'success',
          text: successText,
        };
      } catch (error) {
        return {
          kind: 'error',
          text: `启动失败: ${error.message}`,
        };
      }
  }
}

export { apply, inject, name, prepareProjectInput, WORKBENCH_STAGE_LABELS };
