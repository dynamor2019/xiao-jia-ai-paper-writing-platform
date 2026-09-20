import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { getModelClient } from '../../lib/model-client.js';
import type { Paper, PaperNote, ToolResult } from '../../types.js';

const execAsync = promisify(exec);
const DEFAULT_DATA_ROOT = process.env.PAPER_DATA_ROOT || join(process.env.USERPROFILE || homedir(), 'Documents', 'XiaoJiaAI Data');
const DEFAULT_OUTPUT_DIR = resolve(DEFAULT_DATA_ROOT, process.env.OUTPUT_DIR || 'output', 'papers', 'current');
interface OpenAlexWork {
  id?: string;
  doi?: string;
  display_name?: string;
  publication_year?: number;
  cited_by_count?: number;
  primary_location?: { landing_page_url?: string };
  authorships?: Array<{ author?: { display_name?: string } }>;
  abstract_inverted_index?: Record<string, number[]>;
}

interface CrossrefWork {
  DOI?: string;
  URL?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string }>;
  published?: { 'date-parts'?: number[][] };
  'is-referenced-by-count'?: number;
  abstract?: string;
}

export interface ResearchDirection {
  title: string;
  researchQuestion: string;
  novelty: string;
  method: string;
  requiredData: string;
  feasibility: string;
  risks: string[];
  sourceIds: string[];
}

export interface TopicDiscovery {
  selected: ResearchDirection;
  alternatives: ResearchDirection[];
  searchQuery: string;
  works: Paper[];
}

export interface ResultValidationOptions {
  analysisPlanFile?: string;
  experimentLogFile?: string;
  reproductionCheckFile?: string;
  requireExecutionEvidence?: boolean;
  statisticalAuditFile?: string;
}

interface ValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

interface ParsedResults {
  headers: string[];
  rows: string[][];
}

/** Search current scholarly metadata, then let the strongest routed model choose a defensible direction. */
export async function discoverResearchTopic(area: string, journalInstructions: string, outputDir = DEFAULT_OUTPUT_DIR): Promise<ToolResult<TopicDiscovery>> {
  try {
    const resolvedOutputDir = resolve(outputDir);
    const works = await searchScholarlyWorks(area, 40);
    if (works.length < 5) return { success: false, error: `联网选题检索仅返回 ${works.length} 篇文献，无法可靠判断研究空白` };
    const evidence = works.map((paper) => `${paper.id} | ${paper.year} | ${paper.title} | cited=${paper.citations ?? 0} | ${paper.url ?? ''}`).join('\n');
    let parsed: Omit<TopicDiscovery, 'works'>;
    try {
      const response = await getModelClient().generate(
        'You are a senior research director. Select research directions only from the supplied live scholarly metadata. Reward novelty, scientific value, feasible data and falsifiability. Do not invent references, datasets or completed results. Return strict JSON without markdown fences.',
        `Broad area: ${area}\n\nTarget journal:\n${journalInstructions || 'General scientific paper'}\n\nLive scholarly metadata:\n${evidence}\n\nReturn {"selected":ResearchDirection,"alternatives":[ResearchDirection,ResearchDirection],"searchQuery":"..."}. Each ResearchDirection must contain title,researchQuestion,novelty,method,requiredData,feasibility,risks,sourceIds. sourceIds must use only IDs above.`,
        { task: 'discovery', temperature: 0.2, maxTokens: 5000, timeoutMs: 120000, maxAttempts: 1 },
      );
      parsed = parseJsonObject(response) as Omit<TopicDiscovery, 'works'>;
    } catch (error) {
      parsed = createFallbackDiscovery(area, works, error);
    }
    validateDirection(parsed.selected, new Set(works.map((paper) => paper.id)));
    for (const direction of parsed.alternatives || []) validateDirection(direction, new Set(works.map((paper) => paper.id)));
    const discovery = { ...parsed, works };
    await mkdir(resolvedOutputDir, { recursive: true });
    await writeFile(resolve(resolvedOutputDir, 'topic-discovery.md'), formatTopicDiscovery(discovery), 'utf8');
    await writeFile(resolve(resolvedOutputDir, 'topic-discovery.json'), JSON.stringify(discovery, null, 2), 'utf8');
    return { success: true, data: discovery };
  } catch (error) {
    return { success: false, error: `联网选题失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function createFallbackDiscovery(area: string, works: Paper[], error: unknown): Omit<TopicDiscovery, 'works'> {
  const sourceIds = works.slice(0, 12).map((paper) => paper.id);
  const title = extractRequestedTitle(area);
  const scope = extractRequestedScope(area);
  const note = error instanceof Error ? error.message : String(error);
  return {
    selected: {
      title,
      researchQuestion: `How can current co-routing decisions for optical fiber and liquid-cooling infrastructure in AI data centers incorporate future expansion demand while reserving enough capacity to reduce costly future rerouting?`,
      novelty: `Focus the contribution on three linked decisions: current routing, future expansion, and capacity reservation. Fallback was used because the discovery model was unavailable: ${note}`,
      method: `Formulate an expansion-aware co-routing and space-reservation optimization model, identify public or reproducible benchmark data, implement computational experiments, and compare against no-reservation and current-only routing baselines.`,
      requiredData: `Public data center, network topology, facility-layout, or synthetic benchmark datasets calibrated from verifiable public sources; scope constraint: ${scope || 'current routing, future expansion, and capacity reservation'}.`,
      feasibility: 'The user supplied a precise title and innovation scope; live scholarly metadata is still retained as evidence for literature framing and later citation checks.',
      risks: [
        'Public datasets may need topology abstraction or synthetic expansion scenarios.',
        'Capacity reservation claims must be limited to computed experiments and not overstated as field deployment evidence.',
        'Literature novelty must be rechecked during citation verification.',
      ],
      sourceIds,
    },
    alternatives: [],
    searchQuery: buildSearchQueries(area)[0] || area,
  };
}

function extractRequestedTitle(area: string): string {
  const titleMatch = area.match(/题目[:：]\s*(.*?)(?=\s+(?:目标|范围|要求)[:：]|$)/);
  const fallback = area.split('; scope:')[0]?.trim();
  return (titleMatch?.[1] || fallback || area).trim();
}

function extractRequestedScope(area: string): string {
  const scopeMatch = area.match(/scope:\s*([^。.\n]+)/i)
    || area.match(/核心创新[^:：]*[:：]\s*([^。.\n]+)/)
    || area.match(/范围[:：]\s*([^。.\n]+)/);
  return scopeMatch?.[1]?.trim() || '';
}

/** Create a frozen, reviewable protocol before any experiment is allowed to run. */
export async function createResearchProtocol(topic: string, papers: Paper[], notes: Map<string, PaperNote>, journalInstructions: string, outputDir = DEFAULT_OUTPUT_DIR): Promise<ToolResult<string>> {
  try {
    const evidence = papers.slice(0, 30).map((paper) => `${paper.id}: ${paper.title}; ${notes.get(paper.id)?.keyFindings || paper.abstract.slice(0, 300)}`).join('\n');
    const protocol = await getModelClient().generate(
      'You are an independent methods editor. Produce an executable research protocol. Never fabricate data. Explicitly mark missing inputs BLOCKED.',
      `Topic: ${topic}\nJournal: ${journalInstructions}\nEvidence:\n${evidence}\n\nWrite Markdown with: research question; falsifiable hypotheses; variables and operational definitions; datasets/sampling; explicit real/synthetic/simulated data labels; frozen inclusion/exclusion rules; baselines and controls; ablations; sensitivity/robustness; statistical analysis and uncertainty; causal-identification limits; leakage prevention; compute/software/seeds; ethics and data governance; figures/tables planned; acceptance criteria; failure/stop rules; reproducibility outputs; result-provenance schema linking every numeric claim to a machine output.`,
      { task: 'protocol', temperature: 0.1, maxTokens: 6000 },
    );
    const path = resolve(outputDir, 'analysis-plan.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `# Frozen Research Protocol\n\n- Frozen at: ${new Date().toISOString()}\n- Changes after this point require a documented protocol amendment and complete data revalidation.\n\n${protocol.trim()}\n`, 'utf8');
    return { success: true, data: path };
  } catch (error) {
    return { success: false, error: `研究方案生成失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Run an explicitly supplied experiment command and preserve its complete audit log. */
export async function runExperiment(command: string, outputDir = DEFAULT_OUTPUT_DIR, resultsFile?: string): Promise<ToolResult<string>> {
  if (!command.trim()) return { success: false, error: '未配置实验命令；请使用 --experiment-command 提供可复现的程序入口' };
  try {
    const resolvedOutputDir = resolve(outputDir);
    await mkdir(resolvedOutputDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: Number(process.env.EXPERIMENT_TIMEOUT_MS || 3_600_000),
      maxBuffer: 100 * 1024 * 1024,
      windowsHide: true,
    });
    const resultPath = resultsFile ? resolve(resultsFile) : undefined;
    if (!resultPath) throw new Error('实验命令完成，但未配置机器可读结果文件');
    const resultContent = await readFile(resultPath);
    const resultSha256 = createHash('sha256').update(resultContent).digest('hex');
    const logPath = resolve(resolvedOutputDir, 'experiment-run.log');
    await writeFile(logPath, [`started=${startedAt}`, `finished=${new Date().toISOString()}`, 'status=SUCCESS', `command=${command}`, `results_file=${resultPath}`, `result_sha256=${resultSha256}`, '', stdout, stderr].join('\n'), 'utf8');
    return { success: true, data: logPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(resolve(outputDir, 'experiment-run.log'), `finished=${new Date().toISOString()}\ncommand=${command}\nstatus=FAILED\nerror=${message}\n`, 'utf8');
    return { success: false, error: `实验程序失败: ${message}` };
  }
}

/** Require non-empty machine-produced results before results prose can be drafted. */
export async function validateExperimentResults(
  resultsFile: string,
  outputDir = DEFAULT_OUTPUT_DIR,
  options: ResultValidationOptions = {},
): Promise<ToolResult<string>> {
  if (!resultsFile.trim()) return { success: false, error: '未配置结果文件；请使用 --results-file 指向 CSV/JSON/TSV 结果' };
  const reportPath = resolve(outputDir, 'data-validation.md');
  const jsonPath = resolve(outputDir, 'data-validation.json');
  try {
    const path = resolve(resultsFile);
    const content = await readFile(path, 'utf8');
    const extension = path.split('.').pop()?.toLowerCase();
    if (!extension || !['csv', 'tsv', 'json'].includes(extension)) {
      throw new Error(`结果文件必须是 CSV、TSV 或 JSON: ${path}`);
    }
    const parsed = parseResults(content, extension);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const checks = validateParsedResults(parsed);
    checks.push(...await validateExecutionEvidence(path, sha256, options));
    const secondRead = await readFile(path, 'utf8');
    checks.push({
      name: 'repeat-read-fingerprint',
      passed: createHash('sha256').update(secondRead).digest('hex') === sha256,
      detail: '第二次独立读取必须与第一次校验哈希一致',
    });
    const passed = checks.every((check) => check.passed);
    const checkedAt = new Date().toISOString();
    const report = formatDataValidationReport({ path, extension, sha256, parsed, checks, checkedAt, passed });
    await mkdir(outputDir, { recursive: true });
    await writeFile(reportPath, report, 'utf8');
    await writeFile(jsonPath, JSON.stringify({ status: passed ? 'PASS' : 'BLOCKED', checkedAt, resultsFile: path, sha256, rows: parsed.rows.length, columns: parsed.headers, checks }, null, 2), 'utf8');
    await appendFile(resolve(outputDir, 'data-validation-history.tsv'), `${checkedAt}\t${sha256}\t${passed ? 'PASS' : 'BLOCKED'}\t${checks.filter((check) => !check.passed).map((check) => check.name).join(',')}\n`, 'utf8');
    if (!passed) throw new Error(`数据完整性检查未通过: ${checks.filter((check) => !check.passed).map((check) => check.name).join(', ')}`);
    return { success: true, data: reportPath };
  } catch (error) {
    return { success: false, error: `实验数据验收失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseResults(content: string, extension: string): ParsedResults {
  if (content.trim().length < 20) throw new Error('结果文件内容不足');
  if (extension !== 'json') {
    const records = parseDelimited(content, extension === 'tsv' ? '\t' : ',');
    return { headers: records[0] || [], rows: records.slice(1) };
  }
  const value = JSON.parse(content) as unknown;
  const records = Array.isArray(value) ? value : findJsonRecords(value);
  if (!records || records.length === 0 || records.some((row) => !isRecord(row))) {
    throw new Error('JSON 结果必须是对象数组，或在 results/data/records 字段中包含对象数组');
  }
  const headers = [...new Set(records.flatMap((row) => Object.keys(row as Record<string, unknown>)))];
  return { headers, rows: records.map((row) => headers.map((header) => formatCell((row as Record<string, unknown>)[header]))) };
}

function parseDelimited(content: string, separator: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char === '"' && quoted && content[index + 1] === '"') {
      field += '"';
      index++;
    } else if (char === '"') quoted = !quoted;
    else if (char === separator && !quoted) {
      record.push(field.trim());
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && content[index + 1] === '\n') index++;
      record.push(field.trim());
      if (record.some(Boolean)) records.push(record);
      record = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new Error('结果表包含未闭合的引号');
  record.push(field.trim());
  if (record.some(Boolean)) records.push(record);
  return records;
}

function validateParsedResults(parsed: ParsedResults): ValidationCheck[] {
  const headers = parsed.headers.map((header) => header.trim());
  const widthsValid = parsed.rows.every((row) => row.length === headers.length);
  const duplicateRows = parsed.rows.length - new Set(parsed.rows.map((row) => JSON.stringify(row))).size;
  const missingCells = parsed.rows.reduce((count, row) => count + row.filter((cell) => !cell.trim()).length, 0);
  const nonFiniteCells = parsed.rows.flat().filter((cell) => /^(?:nan|[+-]?inf(?:inity)?)$/i.test(cell)).length;
  const numericColumns = headers.filter((header, index) => !isTraceabilityHeader(header) && parsed.rows.every((row) => row[index] !== '' && Number.isFinite(Number(row[index]))));
  const varyingNumeric = numericColumns.filter((header) => {
    const index = headers.indexOf(header);
    return new Set(parsed.rows.map((row) => row[index])).size > 1;
  });
  const traceable = headers.some(isTraceabilityHeader);
  return [
    { name: 'schema', passed: headers.length >= 2 && headers.every(Boolean) && new Set(headers).size === headers.length, detail: `${headers.length} columns; headers must be non-empty and unique` },
    { name: 'row-count', passed: parsed.rows.length >= 3, detail: `${parsed.rows.length} data rows; at least 3 required` },
    { name: 'row-width', passed: widthsValid, detail: 'every row must match the declared schema' },
    { name: 'duplicate-records', passed: duplicateRows === 0, detail: `${duplicateRows} exact duplicate rows` },
    { name: 'missing-values', passed: missingCells === 0, detail: `${missingCells} empty cells; missing values require an explicit cleaned artifact` },
    { name: 'finite-values', passed: nonFiniteCells === 0, detail: `${nonFiniteCells} NaN/Infinity cells` },
    { name: 'row-traceability', passed: traceable, detail: 'requires an instance/sample/run/seed/fold/replicate identifier column' },
    { name: 'numeric-variation', passed: varyingNumeric.length > 0, detail: `varying numeric columns: ${varyingNumeric.join(', ') || 'none'}` },
  ];
}

async function validateExecutionEvidence(path: string, sha256: string, options: ResultValidationOptions): Promise<ValidationCheck[]> {
  if (!options.requireExecutionEvidence) return [];
  const checks: ValidationCheck[] = [];
  const logPath = resolve(options.experimentLogFile || '');
  const planPath = resolve(options.analysisPlanFile || '');
  const log = await readFile(logPath, 'utf8').catch(() => '');
  const plan = await readFile(planPath, 'utf8').catch(() => '');
  const started = log.match(/^started=(.+)$/m)?.[1];
  const recordedHash = log.match(/^result_sha256=([a-f0-9]{64})$/m)?.[1];
  const planStats = plan ? await stat(planPath) : undefined;
  checks.push({ name: 'successful-execution', passed: /^status=SUCCESS$/m.test(log) && /^command=.+$/m.test(log), detail: `verified from ${logPath}` });
  checks.push({ name: 'result-run-hash', passed: recordedHash === sha256 && log.includes(`results_file=${path}`), detail: 'result path and SHA256 must match the successful run log' });
  checks.push({ name: 'frozen-analysis-plan', passed: /^# Frozen Research Protocol/m.test(plan) && Boolean(started) && Boolean(planStats) && planStats!.mtimeMs <= Date.parse(started!), detail: 'analysis plan must exist and predate experiment execution' });
  checks.push(await validateAuditArtifact(options.statisticalAuditFile, sha256, 'scientific-statistical-audit'));
  checks.push(await validateAuditArtifact(options.reproductionCheckFile, sha256, 'independent-recomputation'));
  return checks;
}

async function validateAuditArtifact(file: string | undefined, sha256: string, name: string): Promise<ValidationCheck> {
  if (!file) return { name, passed: false, detail: 'required audit artifact path is missing' };
  try {
    const artifact = JSON.parse(await readFile(resolve(file), 'utf8')) as { status?: string; resultSha256?: string; command?: string; sourceHashes?: Record<string, string>; checks?: unknown[] };
    const checksValid = Array.isArray(artifact.checks) && artifact.checks.length > 0 && artifact.checks.every((check) => isRecord(check) && check.status === 'PASS' && typeof check.evidence === 'string' && check.evidence.trim());
    const hashesValid = isRecord(artifact.sourceHashes) && Object.keys(artifact.sourceHashes).length > 0 && Object.values(artifact.sourceHashes).every((hash) => /^[a-f0-9]{64}$/i.test(String(hash)));
    const passed = artifact.status === 'PASS' && artifact.resultSha256 === sha256 && Boolean(artifact.command?.trim()) && checksValid && hashesValid;
    return { name, passed, detail: `${resolve(file)} must contain PASS, current resultSha256, command, sourceHashes, and evidence-bearing PASS checks` };
  } catch (error) {
    return { name, passed: false, detail: `${resolve(file)} unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function formatDataValidationReport(input: { path: string; extension: string; sha256: string; parsed: ParsedResults; checks: ValidationCheck[]; checkedAt: string; passed: boolean }): string {
  const rows = input.checks.map((check) => `| ${check.name} | ${check.passed ? 'PASS' : 'BLOCKED'} | ${check.detail.replace(/\|/g, '\\|')} |`).join('\n');
  return `# Data Validation\n\n- Status: ${input.passed ? 'PASS' : 'BLOCKED'}\n- File: ${input.path}\n- Format: ${input.extension.toUpperCase()}\n- SHA256: ${input.sha256}\n- Data rows: ${input.parsed.rows.length}\n- Columns: ${input.parsed.headers.join(', ')}\n- Checked at: ${input.checkedAt}\n\n## Three-pass gate\n\n| Check | Status | Evidence |\n|---|---|---|\n${rows}\n\n1. Schema and row integrity.\n2. Scientific/statistical audit bound to this result hash.\n3. Independent recomputation artifact bound to this result hash, plus frozen protocol and successful run evidence.\n\nAny result-file change invalidates this PASS and requires all three passes again before manuscript prose is written.\n`;
}

function findJsonRecords(value: unknown): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['results', 'data', 'records']) if (Array.isArray(value[key])) return value[key] as unknown[];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function isTraceabilityHeader(header: string): boolean {
  return /(?:^|_)(?:id|seed|run|trial|fold|replicate|instance|sample)(?:_|$)/i.test(header);
}

async function searchOpenAlex(query: string, count: number): Promise<Paper[]> {
  const half = Math.max(5, Math.ceil(count / 2));
  const unique = new Map<string | undefined, OpenAlexWork>();
  for (const searchQuery of buildSearchQueries(query)) {
    const influential = await fetchOpenAlex(searchQuery, half, 'cited_by_count:desc');
    const recent = await fetchOpenAlex(searchQuery, half, 'publication_date:desc');
    for (const work of [...influential, ...recent]) {
      unique.set(work.id || work.doi || work.display_name, work);
    }
    if (unique.size >= count) break;
  }
  return [...unique.values()].map((work) => ({
    id: work.id || work.doi || work.display_name || 'unknown',
    title: work.display_name || 'Untitled',
    authors: (work.authorships || []).map((item) => item.author?.display_name || '').filter(Boolean),
    year: work.publication_year || 0,
    abstract: restoreAbstract(work.abstract_inverted_index),
    url: work.doi || work.primary_location?.landing_page_url || work.id,
    citations: work.cited_by_count || 0,
    source: 'manual' as const,
  }));
}

/** Search OpenAlex first and fill gaps from Crossref without spending model tokens. */
export async function searchScholarlyWorks(query: string, count: number): Promise<Paper[]> {
  let openAlex: Paper[] = [];
  try {
    openAlex = await searchOpenAlex(query, count);
  } catch (error) {
    console.warn(`OpenAlex 不可用，切换 Crossref: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (openAlex.length >= count) return openAlex.slice(0, count);

  let crossref: Paper[] = [];
  try {
    crossref = await searchCrossref(query, count - openAlex.length);
  } catch (error) {
    console.warn(`Crossref 检索失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const combined = new Map([...openAlex, ...crossref].map((paper) => [paper.id, paper]));
  return [...combined.values()].slice(0, count);
}

async function searchCrossref(query: string, count: number): Promise<Paper[]> {
  const unique = new Map<string, CrossrefWork>();
  for (const searchQuery of buildSearchQueries(query)) {
    const works = await fetchCrossref(searchQuery, Math.max(5, count));
    for (const work of works) {
      const id = work.DOI ? `https://doi.org/${work.DOI}` : work.URL;
      if (id) unique.set(id, work);
    }
    if (unique.size >= count) break;
  }
  return [...unique.entries()].map(([id, work]) => ({
    id,
    title: work.title?.[0] || 'Untitled',
    authors: (work.author || []).map((author) => [author.given, author.family].filter(Boolean).join(' ')),
    year: work.published?.['date-parts']?.[0]?.[0] || 0,
    abstract: stripMarkup(work.abstract || ''),
    url: work.URL || id,
    citations: work['is-referenced-by-count'] || 0,
    source: 'manual' as const,
  }));
}

function buildSearchQueries(query: string): string[] {
  const normalized = query
    .replace(/题目\s*[:：]/g, ' ')
    .replace(/(?:目标|范围|要求)\s*[:：][\s\S]*$/g, ' ')
    .replace(/[：:；;，。,]/g, ' ')
    .replace(/\b(Current routing|Future expansion|Capacity reservation)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const terms = normalized.match(/[A-Za-z][A-Za-z-]{2,}/g) || [];
  const meaningful = terms
    .filter((term) => !/^(aware|current|future|capacity|reservation|infrastructure|centers?)$/i.test(term))
    .slice(0, 12);
  const candidates = [
    normalized,
    meaningful.join(' '),
    'data center cooling',
    'liquid cooling data centers',
    'data center network routing',
    'optical fiber routing',
    'optical fiber liquid cooling AI data centers routing',
    'data center liquid cooling infrastructure routing',
    'data center optical fiber routing capacity reservation',
    'future expansion capacity reservation network routing',
  ];
  return [...new Set(candidates.map((item) => item.trim()).filter(Boolean))];
}

function restoreAbstract(index?: Record<string, number[]>): string {
  if (!index) return '';
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word]);
  }
  return words.sort((a, b) => a[0] - b[0]).map((item) => item[1]).join(' ');
}

async function fetchOpenAlex(query: string, count: number, sort: string): Promise<OpenAlexWork[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${count}&sort=${encodeURIComponent(sort)}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'paper-agent-dsh/0.2 (academic research workbench)' },
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);
  if (!contentType.includes('json') || body.trimStart().startsWith('<')) throw new Error('OpenAlex 返回了非 JSON 内容，可能是代理登录页或服务异常');
  const payload = JSON.parse(body) as { results?: OpenAlexWork[] };
  return payload.results || [];
}

async function fetchCrossref(query: string, count: number): Promise<CrossrefWork[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${count}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'paper-agent-dsh/0.2 (academic research workbench)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Crossref HTTP ${response.status}`);
  const payload = await response.json() as { message?: { items?: CrossrefWork[] } };
  return payload.message?.items || [];
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('选题模型未返回可解析 JSON');
  return JSON.parse(match[0]);
}

function validateDirection(direction: ResearchDirection, allowedIds: Set<string>): void {
  if (!direction?.title || !direction.researchQuestion || !direction.method) throw new Error('选题模型返回的研究方向字段不完整');
  if (!Array.isArray(direction.sourceIds) || direction.sourceIds.some((id) => !allowedIds.has(id))) throw new Error('选题模型使用了联网结果之外的文献 ID');
}

function formatTopicDiscovery(discovery: Omit<TopicDiscovery, 'works'> & { works: Paper[] }): string {
  const render = (title: string, item: ResearchDirection) => `## ${title}: ${item.title}\n\n- 研究问题：${item.researchQuestion}\n- 创新依据：${item.novelty}\n- 方法：${item.method}\n- 所需数据：${item.requiredData}\n- 可行性：${item.feasibility}\n- 风险：${item.risks.join('；')}\n- 证据 ID：${item.sourceIds.join(', ')}\n`;
  const alternatives = discovery.alternatives.map((item, index) => render(`备选 ${index + 1}`, item)).join('\n');
  const sources = discovery.works.map((paper) => `- ${paper.id} | ${paper.year} | ${paper.title} | ${paper.url || ''}`).join('\n');
  return `# Topic Discovery\n\n- 检索式：${discovery.searchQuery}\n- 生成时间：${new Date().toISOString()}\n\n${render('推荐方向', discovery.selected)}\n${alternatives}\n## 联网证据\n\n${sources}\n`;
}
