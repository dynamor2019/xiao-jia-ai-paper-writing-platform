/**
 * /paper 命令 - 基于文献 PDF 自动撰写论文
 * 用法:
 *   /paper <选题>                  # 自动读取数据目录 papers/input 下的 PDF
 *   /paper <选题> --file <路径>     # 指定单个文献文件
 *   /paper <选题> --dir <目录>      # 指定文献目录
 *   /paper <选题> --journal <期刊ID> # 按目标期刊要求写作
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { addFeedback, findClaimEvidence, readFeedback, resolveFeedback } from './paper-feedback.js';
import { PAPER_PHASES as WORKBENCH_PHASES, paperStages, groupPaperPhases as groupWorkbenchPhases } from './paper-phases.js';
import { sanitizeAuthorForm } from './manuscript-authors.mjs';

const name = 'command-paper';
const inject = ['commands', 'goals', 'webServer', 'systemPrompt', 'tools'];

const PROJECT_DIR = resolve(process.env.DSH_PAPER_PROJECT_DIR || String.raw`__DSH_PAPER_PROJECT_DIR__`);
const REVIEWER_MODULE = join(PROJECT_DIR, 'scripts', 'reviewer-response-web.mjs');
const { registerReviewerFeature } = await import(existsSync(REVIEWER_MODULE) ? pathToFileURL(REVIEWER_MODULE).href : new URL('../../../scripts/reviewer-response-web.mjs', import.meta.url).href);
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
const PAPER_INPUT_HINT = '<研究领域或题目> [--focus <核心贡献>] [--scope <范围边界>] [--method <方法偏好>] [--constraints <数据约束>] [--journal <期刊ID>] [--output-dir <项目目录>]';
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
const JOURNAL_SKILLS = {
  'automation-in-construction': 'journal-automation-in-construction',
  'advanced-engineering-informatics': 'journal-advanced-engineering-informatics',
  'journal-of-computing-in-civil-engineering': 'journal-journal-of-computing-in-civil-engineering',
  'computer-aided-civil-and-infrastructure-engineering': 'journal-computer-aided-civil-and-infrastructure-engineering',
  'building-and-environment': 'journal-building-and-environment',
  'energy-and-buildings': 'journal-energy-and-buildings',
  'journal-of-building-engineering': 'journal-journal-of-building-engineering',
  'science-and-technology-for-the-built-environment': 'journal-science-and-technology-for-the-built-environment',
  'building-services-engineering-research-and-technology': 'journal-building-services-engineering-research-and-technology',
  'engineering-applications-of-artificial-intelligence': 'journal-engineering-applications-of-artificial-intelligence',
  'ieee-transactions-on-automation-science-and-engineering': 'journal-ieee-transactions-on-automation-science-and-engineering',
  'expert-systems-with-applications': 'journal-expert-systems-with-applications',
};
const STAGE_LABELS = [
  ['project-intake', '研究建档'],
  ['topic-discovery', '联网选题'],
  ['topic-confirmation', '研究问题确认'],
  ['protocol-design', '冻结研究方案'],
  ['experiment-execution', '实验运行'],
  ['data-validation', '数据验收'],
  ['literature-search', '结果导向文献检索'],
  ['literature-review', '文献精读与证据综合'],
  ['outline-generation', '论文大纲'],
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
const WORKBENCH_STAGE_LABELS = paperStages().map((id) => [id, new Map(STAGE_LABELS).get(id)]);
const APPROVAL_STAGES = new Set(['topic-confirmation', 'protocol-design', 'outline-generation', 'submission-readiness']);

function authorsPathForSession(agent) {
  return join(RUNS_DIR, `${sessionKey(agent)}.authors.json`);
}

function projectAuthorsPath(outputDir) {
  return join(outputDir, '.dsh-state', 'manuscript-authors.json');
}

function readAuthorForm(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return sanitizeAuthorForm(parsed.authors ?? parsed);
  } catch {
    return sanitizeAuthorForm(undefined);
  }
}

function writeAuthorForm(path, authors) {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ authors: sanitizeAuthorForm(authors) }, null, 2)}\n`, 'utf8');
}

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
        ? `本对话只绑定 ${run.outputDir}。未关闭 work-chain.json 前不要另开流水线。查状态或恢复用 continue_paper_workflow，不要另跑 npm run paper。文档规则：原始证据、实验程序与结果引用、稿件、必要门禁报告必须保留；只有研究方案、数据证据、结论或实际阻塞发生实质变化时才更新对应台账。普通进度、重试、检查和无变化结论只写会话或运行日志，不另建说明文档，也不调用模型专门总结这些操作。同一用途固定一个文件并按需更新，不按轮次或时间戳新增说明；仅关键方案变更或不可替代证据需要留历史版本。大型实验数据沿用共享区域，论文目录仅保存引用与哈希。`
        : '本对话未绑定论文项目。只有用户明确要求写论文时才调用 start_paper_workflow；其他对话不要注入论文流程。';
    },
  });
  ctx.systemPrompt.context({
    name: 'paper:target-journal',
    order: 30,
    text: () => targetJournalId
      ? `目标期刊：${JOURNALS[targetJournalId]}。开始期刊相关工作前，必须先调用 /${JOURNAL_SKILLS[targetJournalId]} 加载该期刊 skill，再将其作为选题范围、结构和格式边界；不要只凭本上下文猜测期刊要求，也不要向用户复述本上下文。`
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
    path: '/dsh-paper-authors',
    handler: async (req, res) => {
      const url = new URL(req.url || '/dsh-paper-authors', 'http://127.0.0.1');
      const finish = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.method === 'GET') {
          const agent = { id: url.searchParams.get('sessionId') || '' };
          const run = readRunState(agent);
          const path = run?.outputDir && existsSync(projectAuthorsPath(run.outputDir))
            ? projectAuthorsPath(run.outputDir)
            : authorsPathForSession(agent);
          finish(200, { authors: readAuthorForm(path) });
          return;
        }
        if (req.method !== 'POST') {
          finish(405, { error: '只接受 GET 或 POST' });
          return;
        }
        const body = await readJsonBody(req, 32768);
        const sessionId = String(body.sessionId || '').trim();
        if (!sessionId) {
          finish(400, { error: '缺少 sessionId' });
          return;
        }
        const authors = sanitizeAuthorForm(body.authors);
        const agent = { id: sessionId };
        writeAuthorForm(authorsPathForSession(agent), authors);
        const run = readRunState(agent);
        if (run?.outputDir) writeAuthorForm(projectAuthorsPath(run.outputDir), authors);
        finish(200, { authors });
      } catch (error) {
        finish(400, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  }), 'paper: author form route');

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
  return join(OUTPUT_DIR, 'papers', paperProjectId(agent));
}

function resolveProjectDir(projectId) {
  const current = join(OUTPUT_DIR, 'papers', projectId);
  if (existsSync(current)) return current;
  return join(OUTPUT_DIR, 'paper-projects', projectId);
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
    if (entry.isDirectory()) {
      const relativeSegments = relative(root, path).split(sep).map((segment) => segment.toLowerCase());
      const isArchived = entry.name.toLowerCase() === 'archive_work_files';
      const isSuperseded = relativeSegments.some((_, index) =>
        relativeSegments.slice(index, index + 5).join('/') === 'milestones/reproducibility/results/superseded');
      if (isArchived || isSuperseded) return [];
      return collectFiles(path, root);
    }
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
  const name = basename(file.replaceAll('\\', '/'));
  return /^(?:manuscript(?:[-_].*)?|paper[-_]full|paper[-_]final)\.md$/i.test(name)
    || (name.toLowerCase().endsWith('.md')
      && !/^(?:agents|readme)(?:[_.-]|$)/i.test(name)
      && !/(quality-report|scientific-review|citation-verification|research-brief|claim-evidence|analysis-plan|data-validation|topic-discovery|submission|revision-log|publication-record|references|tables|cover[-_ ]letter|highlights|report|review|prompt|proposal|statement|declaration|summary)/i.test(name));
}

/** Prefer the canonical article over newer supporting notes in the same package. */
function findManuscriptArtifact(artifacts) {
  return artifacts.find((row) => /^(?:manuscript|paper[-_]full|paper[-_]final)\.md$/i.test(basename(row.path)))
    || artifacts.find((row) => isManuscriptMarkdown(row.file));
}

/** Read only a content-bound review; historical reports cannot approve a changed article. */
function currentManuscriptReview(manuscript, artifacts) {
  if (!manuscript) return undefined;
  const report = artifacts.find((row) => row.path === manuscript.path.replace(/\.md$/i, '.quality-report.md'));
  if (!report) return undefined;
  const text = readFileSync(report.path, 'utf8');
  const sha256 = createHash('sha256').update(readFileSync(manuscript.path)).digest('hex');
  if (!text.includes(`Manuscript SHA256: ${sha256}`)) return { status: 'stale', path: report.path };
  const scientificClear = (text.match(/Manuscript gate:\s*CLEAR/g) || []).length >= 2
    && /Review route:\s*qualityCrossReview/.test(text) && !/Manuscript gate:\s*BLOCKED/.test(text);
  const metadataMatched = /# Reference Metadata Audit\s+Status:\s*PASS/.test(text);
  const citationPath = join(dirname(manuscript.path), '.dsh-state', 'citation-support', 'current.json');
  let citationReport;
  try { citationReport = JSON.parse(readFileSync(citationPath, 'utf8')); } catch { citationReport = undefined; }
  const citationSupportClear = citationReport?.sha256 === sha256 && citationReport.total > 0
    && citationReport.results?.length === citationReport.total
    && citationReport.results.every(result => result.status === 'verified');
  const blocked = /(?:^|\n)Status:\s*BLOCKED|Manuscript gate:\s*BLOCKED/.test(text);
  return { status: blocked ? 'blocked' : scientificClear && metadataMatched ? 'clear' : 'pending',
    scientificClear, metadataMatched, citationSupportClear, citationCount: citationReport?.total, sha256, path: report.path };
}

async function resolveValidationTargets(rawInput, agent) {
  const args = splitArgs(rawInput || '');
  const markdownArg = args.find((arg) => arg.toLowerCase().endsWith('.md'));
  const docxArg = args.find((arg) => arg.toLowerCase().endsWith('.docx'));
  const artifacts = await listOutputArtifacts(activePaperDir(agent));
  const markdown = markdownArg
    || findManuscriptArtifact(artifacts)?.path;
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
    'research-brief.md': `# Research Brief\r\n\r\n- 宽泛研究领域：${topic}\r\n- 目标期刊：${journalName}\r\n- 联网选题与最终研究问题：待确认\r\n- 假设、预期贡献与不主张边界：待确认\r\n- 数据、代码、伦理与可复现要求：待确认\r\n- 完成标准：研究、数据、稿件、科技质量、DOCX 与投稿清单全部通过\r\n`,
    'topic-discovery.md': '# Topic Discovery\r\n\r\nStatus: BLOCKED - 尚未运行联网检索与研究方向评估。\r\n',
    'claim-evidence-matrix.md': '# Claim-Evidence Matrix\r\n\r\n| ID | 核心主张 | 证据来源 | 数据/结果位置 | 证据强度 | 冲突或缺口 | 状态 |\r\n|---|---|---|---|---|---|---|\r\n| C1 | 待确认 | 待核验 | 待定位 | 未评估 | 待检查 | BLOCKED |\r\n',
    'analysis-plan.md': '# Frozen Research Protocol\r\n\r\nStatus: BLOCKED - 待文献综合后冻结假设、变量、数据、基线、对照、消融、统计、伦理、失败规则和复现设置。\r\n',
    'data-validation.md': '# Data Validation\r\n\r\nStatus: BLOCKED - 尚无通过程序获取并验收的实验数据。\r\n',
    'submission-checklist.md': `# Submission Checklist\r\n\r\n- [ ] 目标期刊范围与最新作者指南已核对：${journalName}\r\n- [ ] 源稿质量门禁 PASS\r\n- [ ] 独立科技审查无 critical/major 问题\r\n- [ ] DOCX 公式、表格、图片和交叉引用检查 PASS\r\n- [ ] 引用真实性审计 PASS\r\n- [ ] 作者贡献、利益冲突、数据/代码可用性及 AI 声明完整\r\n- [ ] Cover letter、Highlights、图表与补充材料齐全\r\n`,
    'revision-log.md': '# Revision Log\r\n\r\n| Version | Date | Trigger | Changes | Evidence rerun | Quality status |\r\n|---|---|---|---|---|---|\r\n',
    'publication-record.md': `# Publication Record\r\n\r\n- 目标期刊：${journalName}\r\n- 投稿日期：待填写\r\n- Manuscript ID：待填写\r\n- 编辑决定：未投稿\r\n- 审稿轮次：0\r\n- 接收日期：待填写\r\n- DOI / 正式链接：待填写\r\n`,
  };
  for (const [file, content] of Object.entries(templates)) {
    if (file !== 'research-brief.md' && file !== 'revision-log.md') continue;
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
  const scopeMatch = text.match(/核心创新[^:：]*[:：]\s*([^。.\r\n]+)/) || text.match(/范围[:：]\s*([^。.\r\n]+)/);
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

function readWorkChain(outputDir) {
  if (!outputDir) return null;
  try {
    return JSON.parse(readFileSync(join(outputDir, '.dsh-state', 'work-chain.json'), 'utf8'));
  } catch {
    return null;
  }
}

function assertPipelineChain(outputDir) {
  const active = readWorkChain(outputDir)?.active;
  if (!active || active.status === 'closed' || active.id === 'pipeline') return;
  // The pipeline asks before writing. A hard stop here leaves no way to answer.
}

function sessionsOnProject(outputDir) {
  if (!outputDir || !existsSync(RUNS_DIR)) return [];
  const root = resolve(outputDir);
  const rows = [];
  for (const name of readdirSync(RUNS_DIR)) {
    if (!name.endsWith('.json') || name.includes('.request.')) continue;
    try {
      const run = JSON.parse(readFileSync(join(RUNS_DIR, name), 'utf8'));
      if (run.outputDir && resolve(run.outputDir) === root) rows.push(`${name.replace(/\.json$/, '')}: ${run.status || 'unknown'} / ${run.stage || '-'}`);
    } catch {
      // A malformed run record is reported by its absence from this inventory.
    }
  }
  return rows;
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

function reconcileRunState(agent) {
  const run = readRunState(agent);
  if (!run?.outputDir) return run;
  const checkpoint = readPipelineState(run.outputDir);
  if (!checkpoint?.topic) return run;
  const ownerPid = activeProjectPid(run.outputDir);
  if (ownerPid) {
    run.status = 'running';
    run.pipelinePid = ownerPid;
    if (!processIsRunning(run.pid)) run.pid = ownerPid;
    run.stage = checkpoint.stage || run.stage;
  } else if (run.status === 'running' && processIsRunning(run.pid)) {
    // A live supervisor may be waiting for its bounded recovery timer.
    return run;
  } else if (checkpoint.metadata?.awaitingApproval) {
    run.status = 'awaiting-confirmation';
    run.stage = checkpoint.metadata.awaitingApproval;
    run.pid = undefined;
  } else if (run.status === 'failed' && run.stage !== checkpoint.stage) {
    run.stage = checkpoint.stage;
    run.error = '历史会话错误已过期，请以当前项目检查点和检查报告为准。';
  } else if (run.status === 'running' || (run.status === 'awaiting-confirmation' && run.stage !== checkpoint.stage)) {
    run.status = 'failed';
    run.stage = checkpoint.stage || run.stage;
    run.pid = undefined;
    run.error = `流水线未正常结束，已保留 ${run.stage} 检查点；可从同一阶段恢复。`;
    run.finishedAt = new Date().toISOString();
  }
  saveRunState(agent, run);
  return run;
}

function resolveApprovalMode(mode) {
  return ['auto', 'topic', 'all'].includes(mode) ? mode : 'topic';
}

function isPathWithin(root, target) {
  const targetRelative = relative(root, target);
  return targetRelative !== '' && targetRelative !== '..'
    && !targetRelative.startsWith(`..${sep}`) && !isAbsolute(targetRelative);
}

function quoteCommandPath(value) {
  if (/["%!^`$]/.test(value)) throw new Error('路径含有无法安全传递给实验解释器的字符。');
  return `"${value}"`;
}

function resolveExperimentConfiguration(outputDir, scriptPath, resultsFile) {
  const outputRoot = realpathSync(outputDir);
  const actualScript = realpathSync(resolve(outputRoot, scriptPath));
  if (!isPathWithin(outputRoot, actualScript) || !statSync(actualScript).isFile()) {
    throw new Error('实验脚本必须是论文项目目录内的普通文件。');
  }
  const extension = extname(actualScript).toLowerCase();
  if (!['.mjs', '.js', '.py'].includes(extension)) throw new Error('实验脚本仅支持 .mjs、.js 或 .py。');

  const result = resolve(outputRoot, resultsFile);
  if (!['.csv', '.tsv', '.json'].includes(extname(result).toLowerCase())) {
    throw new Error('机器可读实验结果必须使用 CSV、TSV 或 JSON 格式。');
  }
  const expectedResultRoot = resolve(outputRoot, 'experiments', 'results');
  if (!isPathWithin(expectedResultRoot, result)) throw new Error('结果文件必须写入论文项目的 experiments/results 目录。');

  let existingParent = dirname(result);
  while (!existsSync(existingParent) && existingParent !== outputRoot) existingParent = dirname(existingParent);
  if (!isPathWithin(outputRoot, realpathSync(existingParent))) throw new Error('结果目录不能通过链接指向论文项目之外。');
  if (existsSync(result) && !isPathWithin(outputRoot, realpathSync(result))) {
    throw new Error('结果文件不能通过链接指向论文项目之外。');
  }

  const interpreter = extension === '.py' ? 'python' : quoteCommandPath(process.execPath);
  return {
    command: `${interpreter} ${quoteCommandPath(actualScript)} --results-file ${quoteCommandPath(result)}`,
    resultsFile: result,
  };
}

function validateApprovalStage(outputDir, pipeline, stage, approvalMode = 'all') {
  if (stage === 'topic-confirmation') {
    let discovery;
    try {
      discovery = JSON.parse(readFileSync(join(outputDir, '.dsh-state', 'topic-discovery.json'), 'utf8'));
    } catch {
      return '缺少选题证据与独立复核记录，不能确认。';
    }
    if (discovery.selected?.title !== pipeline.topic || !discovery.review?.approved
      || Object.values(discovery.review.checks || {}).length !== 5
      || Object.values(discovery.review.checks).some((value) => value !== true)) {
      return '选题科学性复核尚未通过，请检查选题报告并重新选题。';
    }
    return '';
  }
  if (stage === 'protocol-design') {
    if (!existsSync(join(outputDir, 'milestones', 'analysis-plan.md'))) return '缺少冻结研究方案 analysis-plan.md，不能确认方案阶段。';
    return '';
  }
  if (stage === 'outline-generation') {
    if (!Array.isArray(pipeline.outline?.nodes)) return '缺少论文大纲检查点，不能确认大纲阶段。';
    const blueprintPath = join(outputDir, 'milestones', 'argument-blueprint.md');
    if (!existsSync(blueprintPath)) return '缺少论证蓝图 argument-blueprint.md，请重新生成大纲后再确认。';
    const blueprint = readFileSync(blueprintPath, 'utf8');
    if (resolveApprovalMode(approvalMode) === 'all') {
      for (const heading of ['中心回答（作者确认）', '替代解释与适用边界（作者确认）']) {
        const section = blueprint.split(`## ${heading}`)[1]?.split(/\r?\r\n## /, 1)[0]?.trim() || '';
        if (!section || /^\[待作者填写/.test(section)) return `请先补全论证蓝图中的“${heading}”，再确认大纲阶段。`;
      }
    }
    return '';
  }
  if (stage === 'submission-readiness') {
    const manifestPath = join(outputDir, 'milestones', 'submission-manifest.md');
    if (!existsSync(manifestPath)) return '缺少投稿清单，不能确认投稿阶段。';
    const manifest = readFileSync(manifestPath, 'utf8');
    if (!/READY FOR AUTHOR CONFIRMATION/.test(manifest) || /(?:Status|Submission status):\s*BLOCKED/i.test(manifest)) return '投稿清单仍未通过，请先处理阻断项。';
    return '';
  }
  if (pipeline.metadata?.pendingQuestion?.stage === stage) return '';
  return `当前阶段 ${stage} 不是可确认节点，请使用 /paper-status 查看真实状态。`;
}

function startPipeline(ctx, topic, inputDir, journalId, experimentCommand, resultsFile, outputDir, agent, approvalMode = 'topic', researchDirection = {}, approvedStage = '', decision = '') {
  assertPipelineChain(outputDir);
  const existingRun = readRunState(agent);
  if (existingRun?.outputDir === outputDir && existingRun.status === 'running' && processIsRunning(existingRun.pid)) {
    throw new Error('论文后台监督仍在运行或等待有限恢复，不启动第二个写作者。');
  }
  const ownerPid = activeProjectPid(outputDir);
  if (ownerPid) throw new Error(`论文项目正在进程 ${ownerPid} 中运行，请等待完成后再恢复。`);
  const tsxCli = join(PROJECT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const pipeline = join(PROJECT_DIR, 'src', 'workflows', 'paper-pipeline.ts');
  const statePath = runStatePath(agent);
  const logPath = runLogPath(agent);
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  if (existsSync(join(outputDir, '.dsh-state', 'paper-pipeline-state.json'))) appendFileSync(logPath, `\r\n[断点恢复] ${new Date().toISOString()}\r\n`, 'utf8');
  else writeFileSync(logPath, '', 'utf8');

  const pipelineArgs = [tsxCli, pipeline, topic];
  if (inputDir) pipelineArgs.push('--input-dir', inputDir);
  if (journalId) pipelineArgs.push('--journal', journalId);
  if (experimentCommand) pipelineArgs.push('--experiment-command', experimentCommand);
  if (resultsFile) pipelineArgs.push('--results-file', resultsFile);
  const resolution = readRunState(agent)?.experimentResolution;
  if (resolution) pipelineArgs.push('--experiment-resolution', JSON.stringify(resolution));
  if (readRunState(agent)?.billingRestored === true) pipelineArgs.push('--billing-restored');
  if (readRunState(agent)?.repairStage) pipelineArgs.push('--repair-stage', readRunState(agent).repairStage);
  if (researchDirection.focus) pipelineArgs.push('--focus', researchDirection.focus);
  if (researchDirection.scope) pipelineArgs.push('--scope', researchDirection.scope);
  if (researchDirection.method) pipelineArgs.push('--method', researchDirection.method);
  if (researchDirection.constraints) pipelineArgs.push('--constraints', researchDirection.constraints);
  pipelineArgs.push('--approval-mode', approvalMode);
  if (approvedStage) pipelineArgs.push('--approved-stage', approvedStage);
  if (decision) pipelineArgs.push('--decision', decision);
  pipelineArgs.push('--output-dir', outputDir);
  pipelineArgs.push('--project-id', activeProjectId(agent));
  const sessionAuthors = authorsPathForSession(agent);
  const projectAuthors = projectAuthorsPath(outputDir);
  if (!existsSync(projectAuthors) && existsSync(sessionAuthors)) writeAuthorForm(projectAuthors, readAuthorForm(sessionAuthors));
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
      approvedStage,
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
  const state = { topic, inputDir, journalId, journalName: journalId ? JOURNALS[journalId] : undefined, experimentCommand, resultsFile, researchDirection, approvalMode, approvedStage, outputDir, paperProjectId: activeProjectId(agent), status: 'running', stage: 'starting', pid: child.pid, startedAt: new Date().toISOString(), logPath };
  saveRunState(agent, state);
  return state;
}

function goalStatusText(ctx, invocation) {
  const goal = ctx.goals.get(invocation.agent);
  if (!goal) return '对话目标: 未设置';
  if (goal.phase === 'complete') return '对话目标: 已完成';
  if (goal.activation === 'armed') return `对话目标: 正在执行 (${goal.roundsStarted}/${goal.maxGoalRounds})`;
  return `对话目标: 等待恢复 (${goal.roundsStarted}/${goal.maxGoalRounds})\r\n提示: 任务列表是持久快照，并不表示模型仍在执行；使用 /paper-resume 恢复。`;
}

function statusText(ctx, invocation) {
  const state = reconcileRunState(invocation.agent);
  const goalStatus = goalStatusText(ctx, invocation);
  if (!state) return `${goalStatus}\r\n后台流水线: 尚未启动`;
  const running = state.status === 'running' && processIsRunning(state.pid);
  if (state.status === 'running' && !running) {
    state.status = 'failed';
    state.error = '后台进程已退出；助手应先检查同一项目的检查点并主动调用 /paper-resume；仅当检查点缺失时，才根据当前对话上下文主动调用 /paper 重建任务。';
    state.finishedAt ||= new Date().toISOString();
    saveRunState(invocation.agent, state);
  }
  const status = running && state.stage === 'auto-recovery-wait'
    ? '自动恢复等待'
    : running
      ? '运行中'
      : state.status === 'awaiting-confirmation'
        ? '等待确认阶段产物'
        : state.status === 'completed'
          ? '已完成'
          : '已失败';
  const retryLine = running && state.nextRetryAt ? `下次自动续跑: ${state.nextRetryAt}` : undefined;
  let tail = '';
  try {
    tail = readFileSync(runLogPath(invocation.agent), 'utf8').trim().split(/\r?\r\n/).slice(-12).join('\r\n');
  } catch {
    tail = '暂无日志。';
  }
  const chain = readWorkChain(state.outputDir)?.active;
  const chainLine = chain ? `当前工作链: ${chain.title} / ${chain.status}${chain.note ? `。${chain.note}` : ''}` : '当前工作链: 未登记';
  let questionLine;
  try {
    const pending = readPipelineState(state.outputDir)?.metadata?.pendingQuestion;
    if (pending?.question && Array.isArray(pending.choices)) {
      questionLine = ['需要你回答:', pending.question, ...pending.choices.map((choice) => `- ${choice.id}: ${choice.label}`), '用 /paper-confirm <选项> 回答。这不会把稿件标成投稿就绪。'].join('\r\n');
    }
  } catch {
    questionLine = undefined;
  }
  const sessions = sessionsOnProject(state.outputDir);
  const sessionLine = sessions.length ? `绑定同一项目的对话: ${sessions.join('；')}` : undefined;
  return [goalStatus, chainLine, sessionLine, `后台流水线: ${status}`, retryLine, `选题: ${state.topic}`, `目标期刊: ${state.journalName || '通用论文模式'}`, `当前阶段: ${state.stage}`, questionLine, `开始时间: ${state.startedAt}`, `日志: ${state.logPath}`, '', '最近进度:', tail || '任务刚刚启动。'].filter(Boolean).join('\r\n');
}

async function workbenchText(ctx, invocation) {
  const snapshot = await workbenchSnapshot(invocation.agent);
  if (!snapshot.project) return `${statusText(ctx, invocation)}\r\n论文项目: 尚未建立；若当前对话已有完整科研任务，助手应从上下文提炼主题并主动调用 /paper 建档，不要要求用户手动输入命令。`;
  return [
    '科技论文工作台',
    `项目: ${snapshot.topic}`,
    `推荐研究问题: ${snapshot.recommendedTopic || '尚未生成'}`,
    snapshot.recommendedTopic ? `选题依据与适用边界: ${join(snapshot.outputDir, 'milestones', 'topic-discovery.md')}` : '选题依据与适用边界: 尚未生成',
    `目标期刊: ${snapshot.journalName}`,
    statusText(ctx, invocation),
    '',
    ...snapshot.phases.map((phase, index) => `${index + 1}. ${phase.label}: ${phase.passed ? 'READY' : phase.status === 'active' ? '进行中' : phase.status === 'error' ? '需处理' : phase.status === 'degraded' ? '草稿继续，待核验' : '未开始'}${phase.detail ? `（${phase.detail}）` : ''}`),
    `当前内部步骤: ${snapshot.stage}`,
    '',
    `输入资料: ${snapshot.inputCount} 个文件`,
    `可交付文件: ${snapshot.deliverableCount} 个`,
    `质量门禁: ${snapshot.quality}`,
    `待处理研究异议: ${snapshot.openFeedback}`,
    snapshot.latestReport ? `最新报告: ${snapshot.latestReport}` : '最新报告: 尚未生成',
    '',
    snapshot.runStatus === 'awaiting-confirmation' ? '请先核对当前阶段产物，再使用 /paper-confirm 继续。' : '工作台和 /paper 命令读取同一流水线状态。',
  ].join('\r\n');
}

async function workbenchSnapshot(agent) {
  const state = reconcileRunState(agent);
  const baseDir = state?.outputDir;
  if (!baseDir) {
    return {
      project: false,
      runStatus: 'idle',
      stage: 'project-intake',
      stageLabel: '研究建档',
      phases: groupWorkbenchPhases(WORKBENCH_STAGE_LABELS.map(([id, label]) => ({ id, label, passed: false, status: 'pending' }))),
      stages: groupWorkbenchPhases(WORKBENCH_STAGE_LABELS.map(([id, label]) => ({ id, label, passed: false, status: 'pending' }))),
      progress: { completed: 0, total: WORKBENCH_PHASES.length, percent: 0 },
      inputCount: 0,
      deliverableCount: 0,
      quality: '未运行',
      authors: readAuthorForm(authorsPathForSession(agent)),
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
  const manuscript = findManuscriptArtifact(deliverables);
  const currentReview = currentManuscriptReview(manuscript, artifacts);
  const word = manuscript && deliverables.find((row) => row.path === manuscript.path.replace(/\.md$/i, '.docx'));
  const workspace = readWorkspaceState(agent);
  const pipeline = readPipelineState(baseDir);
  const manuscriptPrepared = Boolean(manuscript && word
    && pipeline?.metadata?.workflow?.tasks?.['manuscript-completion']?.status === 'complete'
    && pipeline?.metadata?.workflow?.tasks?.export?.status === 'complete');
  const openFeedback = readFeedback(baseDir).filter((item) => item.status === 'open').length;
  const runStatus = running ? 'running' : state.status;
  const pipelineStage = pipeline?.stage || (WORKBENCH_STAGE_LABELS.some(([id]) => id === state.stage) ? state.stage : 'project-intake');
  const currentIndex = Math.max(0, WORKBENCH_STAGE_LABELS.findIndex(([id]) => id === pipelineStage));
  const stages = WORKBENCH_STAGE_LABELS.map(([id, label], index) => {
    const tasks = pipeline?.metadata?.workflow?.tasks;
    if (tasks) {
      const task = tasks[id];
      const recordedStatus = { complete: 'complete', running: 'active', waiting: 'active', degraded: 'degraded', failed: 'error' }[task?.status] || 'pending';
      const status = id === pipelineStage && runStatus === 'failed' && !['complete', 'degraded'].includes(recordedStatus) ? 'error' : recordedStatus;
      return { id, label, passed: status === 'complete', status, detail: task?.error || '' };
    }
    let status = index < currentIndex ? 'complete' : 'pending';
    if (runStatus === 'completed') status = 'complete';
    if (index === currentIndex && ['running', 'awaiting-confirmation'].includes(runStatus)) status = 'active';
    if (index === currentIndex && runStatus === 'failed') status = 'error';
    return { id, label, passed: status === 'complete', status };
  });
  const phases = groupWorkbenchPhases(stages);
  if (manuscriptPrepared && !running) {
    for (const phase of phases) {
      if (!['writing', 'gates'].includes(phase.id)) continue;
      const taskIds = WORKBENCH_PHASES.find(([id]) => id === phase.id)[2];
      const failures = stages.filter((stage) => taskIds.includes(stage.id) && stage.status === 'error');
      const unrunOnly = failures.length > 0 && failures.every((stage) =>
        stage.id === 'literature-search' && /pipeline search failed and was not rerun/i.test(stage.detail)
        || stage.id === 'citation-verification' && /references were not re-verified/i.test(stage.detail));
      if (!unrunOnly) continue;
      phase.status = 'degraded';
      phase.passed = false;
      phase.detail = phase.id === 'writing'
        ? '正文与 Word 已生成；历史检索未重跑，不代表稿件写作失败。引用在独立核验阶段处理。'
        : '当前稿件的引用与科学复核待执行；尚未核验不代表已发现论文错误。';
    }
  }
  if (manuscriptPrepared && !running && currentReview) {
    const writing = phases.find((phase) => phase.id === 'writing');
    const gates = phases.find((phase) => phase.id === 'gates');
    if (currentReview.status === 'clear') {
      Object.assign(writing, { status: 'complete', passed: true, detail: '当前稿件及 Word 已生成，已通过内容绑定的双路科学复审。' });
      Object.assign(gates, { status: currentReview.citationSupportClear ? 'complete' : 'degraded', passed: currentReview.citationSupportClear,
        detail: currentReview.citationSupportClear ? `双路科学复审及${currentReview.citationCount}处引用支撑核验通过；作者签字和来源权限仍属于投稿前待办。`
          : '双路科学复审通过；DOI题名与年份已核对。逐句引用支撑和投稿权限仍需独立核验。' });
    } else if (currentReview.status === 'blocked') {
      Object.assign(gates, { status: 'error', passed: false, detail: `当前稿件存在未通过检查，请查看 ${currentReview.path}` });
    } else if (currentReview.status === 'stale') {
      Object.assign(gates, { status: 'degraded', passed: false, detail: '稿件内容已改变，旧版审查不能证明当前版本通过。' });
    }
  }
  const completed = phases.filter((phase) => phase.passed).length;
  return {
    project: true,
    manuscriptPrepared,
    currentReview,
    recordedStages: stages,
    topic: workspace?.topic || state.topic,
    recommendedTopic: pipeline?.topic,
    researchDirection: workspace?.researchDirection || state.researchDirection || pipeline?.metadata?.researchDirection || {},
    journalName: workspace?.journalName || state.journalName || '通用论文模式',
    outputDir: baseDir,
    paperProjectId: workspace?.paperProjectId || pipeline?.metadata?.paperProjectId || state.paperProjectId || paperProjectId(agent),
    runStatus,
    stage: pipelineStage,
    stageLabel: Object.fromEntries(WORKBENCH_STAGE_LABELS)[pipelineStage] || pipelineStage,
    authors: readAuthorForm(existsSync(projectAuthorsPath(baseDir)) ? projectAuthorsPath(baseDir) : authorsPathForSession(agent)),
    nextRetryAt: state.nextRetryAt,
    recoveryCount: state.recoveryCount,
    stages: phases,
    phases,
    progress: { completed, total: phases.length, percent: Math.round((completed / phases.length) * 100) },
    inputCount: await countDocs(state.inputDir || join(baseDir, 'input')),
    deliverableCount: deliverables.length,
    quality,
    openFeedback,
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
  if (!baseDir) return 'SUBMISSION BLOCKED\r\n- 尚未建立本对话的论文项目。';
  const artifacts = await listOutputArtifacts(baseDir);
  const latestMarkdown = findManuscriptArtifact(artifacts);
  const latestDocx = latestMarkdown && artifacts.find((row) => row.path === latestMarkdown.path.replace(/\.md$/i, '.docx'));
  const report = latestMarkdown && artifacts.find((row) => row.path === latestMarkdown.path.replace(/\.md$/i, '.quality-report.md'))
    || artifacts.find((row) => /paper-quality-report\.md$/i.test(row.file));
  const reportText = report ? readFileSync(report.path, 'utf8') : '';
  const qualityPassed = Boolean(report) && /\bPASS\b|Verdict:\s*pass/i.test(reportText) && !/\bBLOCKED\b|Verdict:\s*(?:major revision|reject)/i.test(reportText);
  const openFeedback = readFeedback(baseDir).filter((item) => item.status === 'open').length;
  const checks = [
    ['论文 Markdown 源稿', Boolean(latestMarkdown), latestMarkdown?.path],
    ['正式 Word 文件', Boolean(latestDocx), latestDocx?.path],
    ['质量门禁 PASS', qualityPassed, report?.path],
    ['研究者异议已处理', openFeedback === 0, openFeedback ? `${openFeedback} 项待处理` : undefined],
    ['引用核验报告', artifacts.some((row) => /citation-verification/i.test(row.file))],
    ['投稿清单', artifacts.some((row) => /(?:^|[\\/])submission-manifest\.md$/i.test(row.file))],
    ['Cover letter', artifacts.some((row) => /cover[-_ ]letter/i.test(row.file))],
    ['作者与研究声明', artifacts.some((row) => /(declaration|authorship|research-integrity)/i.test(row.file))],
  ];
  const manifest = artifacts.find((row) => /(?:^|[\\/])submission-manifest\.md$/i.test(row.file));
  const manifestText = manifest ? readFileSync(manifest.path, 'utf8') : '';
  const ready = checks.every(([, passed]) => passed)
    && /READY FOR AUTHOR CONFIRMATION/.test(manifestText) && !/\bBLOCKED\b/.test(manifestText);
  return [ready ? 'SUBMISSION READY' : 'SUBMISSION BLOCKED',
    latestMarkdown && latestDocx ? '稿件与 Word 已生成；剩余核验不代表需要重新撰写全文。' : '',
    ...checks.map(([label, passed, path]) => `- ${passed ? 'PASS' : 'BLOCKED'} ${label}${path ? `: ${path}` : ''}`),
    '', manifestText ? `当前投稿清单：\n${manifestText}` : '缺少投稿清单，待核验。',
    ready ? '仍需作者确认后自行投稿。' : '仅处理当前清单中的实际未完成项；历史失败不要求重跑已完成写作。'].filter(Boolean).join('\r\n');
}

async function confirmPaperStage(ctx, agent, decision = '') {
  const run = readRunState(agent);
  if (!run?.outputDir) return { kind: 'error', text: '本对话尚未启动论文流程。' };
  if (run.status !== 'awaiting-confirmation') {
    return { kind: 'error', text: '当前没有等待确认的论文阶段，请检查真实状态。' };
  }
  if (activeProjectPid(run.outputDir)) return { kind: 'error', text: '论文项目仍在运行，请等待完成后再确认。' };
  const pipeline = readPipelineState(run.outputDir);
  if (!pipeline?.topic) return { kind: 'error', text: '没有找到论文流水线检查点，无法确认。' };
  const pending = pipeline.metadata?.pendingQuestion;
  if (pending?.question) {
    const choice = pending.choices?.find((item) => item.id === decision);
    if (!choice) {
      return { kind: 'error', text: [pending.question, ...(pending.choices || []).map((item) => `- ${item.id}: ${item.label}`), '', '请用 /paper-confirm <选项> 回答。直接确认不会跳过，也不会把稿件标成投稿就绪。'].join('\r\n') };
    }
    startPipeline(ctx, run.topic, run.inputDir, run.journalId, run.experimentCommand, run.resultsFile, run.outputDir, agent, resolveApprovalMode(run.approvalMode), run.researchDirection, '', decision);
    return { kind: 'success', text: [`已收到选择: ${choice.label}`, `当前研究问题: ${pipeline.topic}`, `论文目录: ${run.outputDir}`, '', '流水线从同一检查点继续。已有标记仍保留，这次确认不是投稿通过。'].join('\r\n') };
  }
  const approvalStage = pipeline.metadata?.awaitingApproval || run.stage;
  const label = Object.fromEntries(WORKBENCH_STAGE_LABELS)[approvalStage] || approvalStage;
  const approvalMode = resolveApprovalMode(run.approvalMode);
  const validationError = validateApprovalStage(run.outputDir, pipeline, approvalStage, approvalMode);
  if (validationError) return { kind: 'error', text: validationError };
  startPipeline(ctx, run.topic, run.inputDir, run.journalId, run.experimentCommand, run.resultsFile, run.outputDir, agent, approvalMode, run.researchDirection, approvalStage);
  return {
    kind: 'success',
    text: [`已确认阶段: ${label}`, `当前研究问题: ${pipeline.topic}`, `论文目录: ${run.outputDir}`, '', approvalMode === 'all' ? '同一流水线已从断点继续；下一处关键产物仍会暂停等待你确认。' : '同一流水线已从断点继续；后续阶段按选题确认后的自动执行策略推进，投稿就绪仍保留作者确认。'].join('\r\n'),
  };
}

function apply(ctx) {
  registerReviewerFeature(ctx, { resolveProject: (id) => activePaperDir({ id }), stateRoot: STATE_ROOT });
  registerTargetJournalContext(ctx);

  ctx.tools.register(defineTool({
    name: 'start_paper_workflow',
    description: 'Start the unified, session-bound academic paper workflow when the conversation already contains a clear research task. Infer and preserve its topic and constraints from conversation context; do not ask the user to invoke /paper manually.',
    parameters: {
      topic: { type: 'string', required: true, description: 'Research topic/title distilled from the conversation.' },
      focus: { type: 'string', description: 'Core research contribution or question.' },
      scope: { type: 'string', description: 'Scope and boundaries.' },
      method: { type: 'string', description: 'Method preference or already established approach.' },
      constraints: { type: 'string', description: 'Data, evidence, or execution constraints.' },
      journal: { type: 'string', description: 'Known target journal ID.' },
      outputDir: { type: 'string', description: 'User-specified project directory, if any; must be inside the configured paper output root.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, execution) => {
      const options = [
        ['--focus', args.focus], ['--scope', args.scope], ['--method', args.method],
        ['--constraints', args.constraints], ['--journal', args.journal], ['--output-dir', args.outputDir],
      ];
      const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
      const rawInput = [quote(args.topic), ...options.flatMap(([flag, value]) => value ? [flag, quote(value)] : [])].join(' ');
      const result = await handlePaperCommand(ctx, { rawInput, agent: execution.agent });
      return `${result.kind === 'error' ? '启动失败: ' : ''}${result.text}`;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'continue_paper_workflow',
    description: 'Inspect the bound paper workflow, bind a reproducible in-project experiment script, resume a failed/interrupted stage, or confirm a checkpoint only after the user explicitly approved that exact stage. Never start a parallel CLI pipeline.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'confirm', 'configure-experiment', 'resolve-experiment', 'repair-gate', 'resume'] },
      gateStage: { type: 'string', enum: ['citation-verification', 'polishing', 'quality-validation', 'formatting'], description: 'A single repaired manuscript gate to recheck; never resets cached reviews or attempt limits.' },
      userConfirmed: { type: 'boolean', description: 'Set true only when the user explicitly approved the currently pending checkpoint in this conversation.' },
      billingRestored: { type: 'boolean', description: 'Set true only after the author explicitly confirmed restored relay balance/account access.' },
      experimentScript: { type: 'string', description: 'Existing .mjs, .js, or .py script inside the bound paper project.' },
      resultsFile: { type: 'string', description: 'CSV, TSV, or JSON output path inside the project experiments/results directory.' },
      experimentTask: { type: 'string', description: 'Interrupted plan task ID, such as pilot or formal-1.' },
      resolutionAction: { type: 'string', enum: ['retry', 'validate', 'stop'], description: 'Author-approved resolution; validate adopts existing completed output without rerunning it.' },
      resolutionReason: { type: 'string', description: 'The actual author decision and reason; do not infer permission.' },
      executionLog: { type: 'string', description: 'Existing project-local execution log when adopting interrupted output.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, execution) => {
      const agent = execution.agent;
      if (!agent) return '无法识别当前会话，未操作论文流水线。';
      if (args.action === 'status') {
        reconcileRunState(agent);
        return statusText(ctx, { agent });
      }
      if (args.action === 'confirm') {
        if (args.userConfirmed !== true) return '当前关卡需要用户明确确认；未启动流水线。';
        const result = await confirmPaperStage(ctx, agent);
        return result.text;
      }
      const run = reconcileRunState(agent);
      if (!run?.outputDir) return '本对话尚未绑定论文项目。';
      const checkpointState = readPipelineState(run.outputDir);
      const stage = checkpointState?.stage || run.stage;
      if (args.action === 'repair-gate') {
        if (args.userConfirmed !== true) return '定点门禁重检需要作者明确确认，不清除旧标记或付费限额。';
        if (activeProjectPid(run.outputDir) || (run.status === 'running' && processIsRunning(run.pid))) return '已有后台任务运行，不启动第二个重检任务。';
        if (!['citation-verification', 'polishing', 'quality-validation', 'formatting'].includes(args.gateStage)) return '请选择一个具体的稿件门禁。';
        run.repairStage = args.gateStage;
        saveRunState(agent, run);
        startPipeline(ctx, run.topic, run.inputDir, run.journalId, run.experimentCommand, run.resultsFile, run.outputDir, agent, resolveApprovalMode(run.approvalMode), run.researchDirection);
        return `已启动 ${args.gateStage} 定点重检；保留正文、结果、审查缓存和原限额，真实通过后才解除该门禁标记。`;
      }
      const stoppedError = checkpointState?.metadata?.workflow?.tasks?.[stage]?.error || run.error || '';
      if (args.action === 'resume' && /insufficient balance|billing_error|insufficient_quota|credit balance|billing failure|余额不足|额度不足/i.test(stoppedError)) {
        if (args.userConfirmed !== true || args.billingRestored !== true) return '此前余额或额度错误已停止；需要作者明确确认充值恢复后才能续跑，未重复计费。';
        run.billingRestored = true;
        saveRunState(agent, run);
      }
      if (args.action === 'resolve-experiment') {
        if (args.userConfirmed !== true) return '中断实验恢复必须由作者明确确认，未修改检查点。';
        if (activeProjectPid(run.outputDir) || (run.status === 'running' && processIsRunning(run.pid))) return '流水线或后台监督仍在运行，不能处理实验中断。';
        if (!['protocol-design', 'experiment-execution'].includes(stage)) return `当前阶段 ${stage} 不接受实验恢复决策。`;
        if (!args.experimentTask || !['retry', 'validate', 'stop'].includes(args.resolutionAction) || !args.resolutionReason?.trim()) return '需要具体实验任务、恢复动作和作者确认理由。';
        run.experimentResolution = { taskId: args.experimentTask, action: args.resolutionAction, reason: args.resolutionReason, logFile: args.executionLog };
        saveRunState(agent, run);
        return '已记录作者实验恢复决定；检查点和次数没有重置，调用 resume 后由流水线核对并执行。';
      }
      if (args.action === 'configure-experiment') {
        if (run.status === 'awaiting-confirmation') return '当前阶段正在等待作者确认；不能配置或启动实验。';
        if (activeProjectPid(run.outputDir)) return `论文流水线仍在运行（${stage}），不能更改实验配置。`;
        if (!['protocol-design', 'experiment-execution'].includes(stage)) return `当前阶段为 ${stage}，只有方案或实验阶段才能绑定实验程序。`;
        if (!args.experimentScript || !args.resultsFile) return '绑定实验程序必须同时提供项目内脚本路径和 experiments/results 下的结果文件路径。';
        const configuration = resolveExperimentConfiguration(run.outputDir, args.experimentScript, args.resultsFile);
        run.experimentCommand = configuration.command;
        run.resultsFile = configuration.resultsFile;
        run.status = 'failed';
        run.stage = stage;
        run.error = undefined;
        saveRunState(agent, run);
        return `已绑定项目内实验脚本：${args.experimentScript}\n结果文件：${configuration.resultsFile}\n尚未启动；先核对研究方案与参数证据，再调用 resume。`;
      }
      if (run.status === 'awaiting-confirmation') return '流水线正在等待用户确认当前关卡；不得自动跳过。';
      if (activeProjectPid(run.outputDir) || (run.status === 'running' && processIsRunning(run.pid))) return `论文流水线仍在运行（${run.stage}），无需重复启动。`;
      if (run.status === 'completed') return '论文流水线已完成，无需恢复。';
      const checkpoint = join(run.outputDir, '.dsh-state', 'paper-pipeline-state.json');
      if (!existsSync(checkpoint)) return '检查点缺失，未启动恢复。';
      if (stage === 'experiment-execution' && (!run.experimentCommand || !run.resultsFile) && !existsSync(join(run.outputDir, 'milestones', 'experiment-plan.json'))) {
        return '实验阶段尚无可复现程序或结果路径，未重复启动失败任务。助手应检查方案与现有数据；有充分证据时在项目内编写程序并调用 configure-experiment，证据不足时记录具体阻断项，不能要求用户手动输入 CLI 命令或虚构结果。';
      }
      const approvalMode = resolveApprovalMode(run.approvalMode);
      startPipeline(ctx, run.topic, run.inputDir, run.journalId, run.experimentCommand, run.resultsFile, run.outputDir, agent, approvalMode, run.researchDirection);
      return `已从同一项目的 ${stage} 检查点恢复，沿用 ${approvalMode} 审批策略：${run.outputDir}`;
    },
  }));

  ctx.commands.register({
    name: 'paper',
    description: '从联网选题、研究设计、实验运行到写作、校验和投稿的一站式流水线；助手应从对话上下文提炼主题并自主启动，不要求用户手动输入命令',
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
      return { kind: 'success', text: [`论文项目已建立: ${topic}`, `目标期刊: ${result.journalName}`, `新建台账: ${result.created.length ? result.created.join(', ') : '已有文件均已保留，未覆盖'}`, `本对话论文目录: ${result.outputDir}`, '', '下一步先完善 research-brief.md 与 analysis-plan.md，再进入证据综合和逐段写作。'].join('\r\n') };
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
      const outputDir = resolveProjectDir(projectId);
      const checkpoint = readPipelineState(outputDir);
      if (!checkpoint?.topic) return { kind: 'error', text: '未找到该项目的流水线检查点。' };
      const awaiting = APPROVAL_STAGES.has(checkpoint.metadata?.awaitingApproval);
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
    description: '确认当前暂停的论文阶段，并从同一断点继续运行',
    input: { hint: '[选项]', images: false },
    handler: async (invocation) => confirmPaperStage(ctx, invocation.agent, invocation.rawInput?.trim() || ''),
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
        text: ['论文产物（按更新时间排序）:', ...artifacts.map((row) => `- ${row.file} (${Math.ceil(row.size / 1024)} KB)\r\n  ${row.path}`)].join('\r\n'),
      };
    },
  });

  ctx.commands.register({
    name: 'paper-evidence',
    description: '按主张 ID 查找本论文的证据矩阵记录',
    input: { hint: '<主张 ID>', images: false },
    handler: async (invocation) => {
      const baseDir = activePaperDir(invocation.agent);
      if (!baseDir) return { kind: 'error', text: '请先建立或接入论文项目。' };
      try {
        const found = findClaimEvidence(baseDir, invocation.rawInput?.trim());
        return found
          ? { kind: 'success', text: `矩阵: ${found.path}\r\n${found.row}\r\n请沿证据来源和结果位置继续核对原始文件。` }
          : { kind: 'error', text: '未找到该主张 ID；请核对当前论文的 claim-evidence-matrix.md。' };
      } catch (error) {
        return { kind: 'error', text: error.message };
      }
    },
  });

  ctx.commands.register({
    name: 'paper-feedback',
    description: '登记、查看或处理本论文的研究者异议，不自动修改稿件',
    input: { hint: '[list | add <主张ID> | <异议> | <证据线索> | resolve <反馈ID> | <处理说明> | <复核依据>]', images: false },
    handler: async (invocation) => {
      const baseDir = activePaperDir(invocation.agent);
      if (!baseDir) return { kind: 'error', text: '请先建立或接入论文项目。' };
      const raw = invocation.rawInput?.trim() || 'list';
      try {
        if (raw === 'list') {
          const items = readFeedback(baseDir);
          return { kind: 'success', text: items.length
            ? items.map((item) => `${item.status === 'open' ? '待处理' : '已处理'} ${item.id} [${item.stage}] ${item.claimId}: ${item.issue}\r\n证据: ${item.evidence}${item.resolution ? `\r\n处理: ${item.resolution}; 复核: ${item.verification}` : ''}`).join('\r\n\r\n')
            : '当前论文没有研究者异议。' };
        }
        const [action, ...parts] = raw.split('|').map((part) => part.trim());
        if (action.startsWith('add ') && parts.length === 2) {
          const stage = readRunState(invocation.agent)?.stage || readPipelineState(baseDir)?.stage || 'project-intake';
          const item = addFeedback(baseDir, stage, action.slice(4), parts[0], parts[1]);
          return { kind: 'success', text: `已登记异议 ${item.id}，阶段 ${stage}；投稿检查会阻断未处理异议。` };
        }
        if (action.startsWith('resolve ') && parts.length === 2) {
          const item = resolveFeedback(baseDir, action.slice(8).trim(), parts[0], parts[1]);
          return { kind: 'success', text: `异议 ${item.id} 已记录处理与复核依据；请重新运行质量校验。` };
        }
        return { kind: 'error', text: '用法: /paper-feedback add <主张ID> | <异议> | <证据线索>；/paper-feedback resolve <反馈ID> | <处理说明> | <复核依据>；或 /paper-feedback list' };
      } catch (error) {
        return { kind: 'error', text: error.message };
      }
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
      const header = [`源稿: ${targets.markdown}`, `Word: ${targets.docx || '未找到，已跳过 DOCX 二次检查'}`].join('\r\n');
      if (result.code === 0 || result.code === 2) {
        return { kind: 'success', text: `${header}\r\n\r\n${result.output || (result.code === 0 ? 'PASS' : 'BLOCKED')}` };
      }
      return { kind: 'error', text: `${header}\r\n\r\n校验执行失败:\r\n${result.output}` };
    },
  });

  ctx.commands.register({
    name: 'journals',
    description: '列出可用的 AI + MEP 目标期刊及调用 ID',
    input: { hint: '[无参数]', images: false },
    handler: async () => ({
      kind: 'success',
      text: ['已内置以下非 MDPI 期刊：', ...Object.entries(JOURNALS).map(([id, title]) => `- ${title}: ${id}`), '', '用法: /paper <选题> --journal <期刊ID>'].join('\r\n'),
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
        return { kind: 'error', text: '流水线正在等待你确认当前阶段产物，请使用 /paper-confirm。' };
      }
      const pipelineRunning = run?.status === 'running' && processIsRunning(run.pid);
      const projectRunning = activeProjectPid(run?.outputDir);
      if (projectRunning) return { kind: 'success', text: `论文项目正在进程 ${projectRunning} 中运行，无需重复恢复。` };
      if (run && run.status !== 'completed' && !pipelineRunning) {
        const outputDir = run.outputDir || outputDirFromRunLog(invocation.agent);
        const checkpoint = outputDir && join(outputDir, '.dsh-state', 'paper-pipeline-state.json');
        if (!checkpoint || !existsSync(checkpoint)) {
        return { kind: 'error', text: '找到中断任务但检查点缺失。助手应根据当前对话上下文提炼原研究主题并主动调用 /paper 重建任务，不要要求用户重复任务描述或手动输入命令。' };
        }
        const pipelineState = readPipelineState(outputDir);
        if (pipelineState?.stage === 'experiment-execution' && (!run.experimentCommand || !run.resultsFile) && !existsSync(join(outputDir, 'milestones', 'experiment-plan.json'))) {
          return { kind: 'error', text: '实验阶段缺少可复现程序或结果路径，未重复启动失败任务。助手应检查项目方案与数据；证据充分时在项目 code/ 内编写程序并通过 continue_paper_workflow 的 configure-experiment 动作绑定，证据不足时记录阻断项，不能虚构实验结果。' };
        }
        startPipeline(ctx, run.topic, run.inputDir, run.journalId, run.experimentCommand, run.resultsFile, outputDir, invocation.agent, resolveApprovalMode(run.approvalMode), run.researchDirection);
        messages.push(`后台流水线已从检查点恢复：${outputDir}`);
      } else if (pipelineRunning) {
        messages.push('后台流水线正在运行，无需重复恢复。');
      }

      if (messages.length === 0) return { kind: 'error', text: '当前没有可恢复的论文任务。' };
      return { kind: 'success', text: messages.join('\r\n') };
    },
  });

  async function handlePaperCommand(ctx, invocation) {
      const raw = invocation.rawInput?.trim() || '';
      if (!raw) {
        return {
          kind: 'success',
          text: `当前调用没有研究主题。若用户已在本对话说明科研任务，请由助手从上下文提炼主题并重新调用，不要要求用户重复输入。用法: /paper ${PAPER_INPUT_HINT}\r\n流程将在联网选题后暂停一次，确认研究问题后自动完成其余阶段。`,
        };
      }

      // 解析参数
      let topic = '';
      let filePath = '';
      let dirPath = '';
      let requestedOutputDir = '';
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
        } else if (parts[i] === '--output-dir' && parts[i + 1]) {
          requestedOutputDir = parts[++i];
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
        return { kind: 'error', text: `未知期刊 ID: ${journalId}\r\n使用 /journals 查看可用列表。` };
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

        if (requestedOutputDir) {
          requestedOutputDir = resolve(requestedOutputDir);
          if (!isInsideDir(requestedOutputDir, OUTPUT_DIR)) {
            return { kind: 'error', text: `项目目录必须位于论文输出根目录内：${OUTPUT_DIR}` };
          }
          if (currentRun?.outputDir && resolve(currentRun.outputDir) !== requestedOutputDir) {
            return { kind: 'error', text: `本对话已绑定项目目录 ${currentRun.outputDir}，不能切换到其他目录。` };
          }
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
        const outputDir = currentRun?.outputDir || requestedOutputDir || createConversationProjectDir(invocation.agent);
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
        ].join('\r\n');
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

export { apply, inject, name, prepareProjectInput, resolveApprovalMode, resolveExperimentConfiguration, validateApprovalStage, WORKBENCH_STAGE_LABELS };
