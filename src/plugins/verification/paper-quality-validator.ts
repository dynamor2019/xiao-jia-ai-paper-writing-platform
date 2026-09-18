import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type QualitySeverity = 'error' | 'warning';

export interface QualityIssue {
  code: string;
  severity: QualitySeverity;
  message: string;
}

export interface PaperQualityMetrics {
  headings: number;
  mathExpressions: number;
  displayMath: number;
  tableReferences: number;
  tables: number;
  figureReferences: number;
  figures: number;
  theorems: number;
}

export interface PaperQualityReport {
  passed: boolean;
  issues: QualityIssue[];
  metrics: PaperQualityMetrics;
}

export interface MarkdownValidationOptions {
  requireReferences?: boolean;
  requireEmbeddedAssets?: boolean;
}

/** Run deterministic source checks before any submission-grade export. */
export function validateMarkdownPaper(markdown: string, options: MarkdownValidationOptions = {}): PaperQualityReport {
  const issues: QualityIssue[] = [];
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)];
  const referenceHeadings = headings.filter((match) => /^(?:references|参考文献)$/i.test(match[2].trim()));
  const firstReferenceIndex = referenceHeadings[0]?.index;
  const laterHeadings = firstReferenceIndex === undefined
    ? []
    : headings.filter((match) => (match.index ?? 0) > firstReferenceIndex);

  if ((options.requireReferences ?? true) && referenceHeadings.length !== 1) {
    issues.push(error('STRUCTURE_REFERENCES_COUNT', `References 标题应恰好出现一次，当前为 ${referenceHeadings.length} 次。`));
  }
  if (laterHeadings.length > 0) {
    issues.push(error('STRUCTURE_AFTER_REFERENCES', `References 后仍有章节标题：${laterHeadings.map((match) => match[2].trim()).join(', ')}。`));
  }
  if (/NEXT_PARAGRAPH|DSH checkpoint|\bTODO\b|to be verified/i.test(markdown)) {
    issues.push(error('STRUCTURE_RESIDUAL_MARKER', '终稿仍包含写作检查点、TODO 或待核验标记。'));
  }
  if (/manual(?:ly)?\s+(?:insert|convert|copy)|手动(?:插入|转换|复制|排版)|requires?\s+manual|remaining manual tasks/i.test(markdown)) {
    issues.push(error('SUBMISSION_MANUAL_ASSEMBLY', '终稿或交付说明仍要求人工插图、插表、转公式或手动装配；这不是一站式投稿稿。'));
  }
  if (/\b(?:strong accept|accept with minor revisions|expected decision)\b/i.test(markdown)) {
    issues.push(error('SUBMISSION_FALSE_REVIEW_PROMISE', '终稿材料不得预测接收结果或承诺审稿结论。'));
  }

  const displayMath = countMatches(markdown, /\$\$[\s\S]*?\$\$/g);
  const withoutDisplayMath = markdown.replace(/\$\$[\s\S]*?\$\$/g, '');
  const inlineMath = countMatches(withoutDisplayMath, /\$(?!\s)[^$\r\n]+?(?<!\s)\$/g);
  const tableReferences = countMatches(markdown, /\bTable\s+\d+[A-Za-z]?\b/gi);
  const tables = countMarkdownTables(markdown);
  const figureReferences = countMatches(markdown, /\b(?:Figure|Fig\.)\s+\d+[A-Za-z]?\b/gi);
  const figures = countMatches(markdown, /!\[[^\]]*\]\([^\)]+\)/g);
  const theorems = countMatches(markdown, /\bTheorem\s+\d+\b/gi);
  const referenceNumbers = extractReferenceNumbers(markdown);
  const citedNumbers = extractBodyCitationNumbers(markdown, firstReferenceIndex);

  if (options.requireEmbeddedAssets ?? true) {
    if (tableReferences > 0 && tables === 0) issues.push(error('PRESENTATION_MISSING_TABLE', '正文引用了 Table，但 Markdown 中没有真实表格。'));
    if (figureReferences > 0 && figures === 0) issues.push(error('PRESENTATION_MISSING_FIGURE', '正文引用了 Figure，但 Markdown 中没有真实图片。'));
  }
  const figureOrder = [...markdown.matchAll(/!\[(?:Figure|Fig\.)\s*(\d+)[^\]]*\]\([^\)]+\)/gi)].map((match) => Number(match[1]));
  if (figureOrder.some((number, index) => index > 0 && number <= figureOrder[index - 1])) {
    issues.push(error('PRESENTATION_FIGURE_ORDER', `图片编号必须严格递增，当前顺序为 ${figureOrder.join(', ')}。`));
  }
  if (new Set(figureOrder).size !== figureOrder.length) {
    issues.push(error('PRESENTATION_FIGURE_DUPLICATE', '检测到重复的图片编号。'));
  }
  if (referenceNumbers.length >= 10) {
    const citedReferenceNumbers = referenceNumbers.filter((number) => citedNumbers.has(number));
    const citationCoverage = citedReferenceNumbers.length / referenceNumbers.length;
    if (citationCoverage < 0.85) {
      issues.push(error('CITATION_BIBLIOGRAPHY_PADDING', `参考文献表有 ${referenceNumbers.length} 条，但正文只明确引用 ${citedReferenceNumbers.length} 条；不得用弱相关文献填充 bibliography。`));
    }
  }
  if (referenceNumbers.length > 0 && citedNumbers.size > 0) {
    const missingReferences = [...citedNumbers].filter((number) => !referenceNumbers.includes(number));
    if (missingReferences.length > 0) {
      issues.push(error('CITATION_MISSING_REFERENCE_ENTRY', `正文引用了不存在的参考文献编号：${missingReferences.join(', ')}。`));
    }
  }
  const paragraphs = markdown.split(/\r?\n\s*\r?\n/);
  const causalCorrelation = paragraphs.find((paragraph) =>
    /\b(?:correlat\w*|associat\w*|regression|observational)\b/i.test(paragraph)
    && /\b(?:caus\w*|driv(?:e|es|en)|lead(?:s)?\s+to|prov(?:e|es|ed)|confirm(?:s|ed)?\s+(?:that\s+)?\w*\s*mechanism)\b/i.test(paragraph)
  );
  if (causalCorrelation) {
    issues.push(error('INFERENCE_CAUSAL_FROM_ASSOCIATION', '同一段落用相关、回归或观察性证据推出因果结论；必须提供因果识别设计或改为关联性措辞。'));
  }
  if (/(?<!\*)\*{3}(?!\*)/.test(markdown)) {
    issues.push(error('STAT_SIGNIFICANCE_STARS', '检测到显著性星号；必须报告由分析脚本生成的精确 P 值、检验和多重比较处理。'));
  }
  if (theorems > 0 && displayMath === 0) issues.push(error('THEORY_INLINE_ONLY', '存在 Theorem，但没有独立陈列公式；定理与证明不能全部挤在普通行内文本中。'));

  const hasLagrangianCapacityContext = /Lagrangian/i.test(markdown) && /capacity constraint/i.test(markdown) && /\\lambda|λ/.test(markdown);
  const hasCapacityConstant = /[-−]\s*\\sum[^\r\n$]{0,180}(?:\\lambda|λ)[^\r\n$]{0,100}c_/i.test(markdown);
  if (hasLagrangianCapacityContext && !hasCapacityConstant) {
    issues.push(error('THEORY_LAGRANGIAN_CONSTANT', '容量约束拉格朗日松弛未检测到容量常数项 -sum(lambda_e c_e)，下界推导必须复核。'));
  }
  if (/strict inequality when a capacity constraint binds/i.test(markdown)) {
    issues.push(error('THEORY_STRICT_SEPARATION_CONDITIONS', '检测到“容量约束绑定即可严格分离”的定理表述；绑定性本身通常不足，必须补充严格不等式成立条件。'));
  }
  if (/(?:for each commodity|only commodities)[^\r\n.]{0,120}y_?k\s*(?:>|&gt;)\s*0/i.test(markdown)
    && /no negative[- ]reduced[- ]cost|lower bound|pool[- ]optimal|LP optimum/i.test(markdown)) {
    issues.push(error('THEORY_CG_PARTIAL_PRICING', 'Column generation 声称下界或无负 reduced-cost column，但文本显示只对 y_k>0 的 commodity 定价；必须证明等价或改为对所有 commodity 使用 assignment dual 定价并重跑。'));
  }
  if (/column generation|reduced[- ]cost|pricing subproblem/i.test(markdown)
    && /commodity/i.test(markdown)
    && !/(assignment dual|dual variable\s+\$?\\?alpha|\\alpha_k|α_k)/i.test(markdown)) {
    issues.push(error('THEORY_CG_ASSIGNMENT_DUAL_MISSING', 'Column generation/reduced-cost 描述缺少 commodity assignment constraint 的 dual variable；下界、LP optimum 或 pool-optimal 结论必须复核。'));
  }

  if (/synthetic|lattice/i.test(markdown) && !/real[- ]world|IFC|building information model|case stud/i.test(markdown)) {
    issues.push(warning('EXPERIMENT_EXTERNAL_VALIDATION', '实验看起来仅使用合成 lattice，未检测到真实 IFC/BIM 或外部案例验证。'));
  }
  if (/BIM|IFC|MEP|routing/i.test(markdown)
    && /synthetic unit capacity|random(?:ly)? seeded|seeded terminal|routing band|inferred connectivity/i.test(markdown)
    && !/real[- ]world|quasi[- ]real|case stud|equipment terminal|clearance|pipe diameter|duct width|as[- ]built/i.test(markdown)) {
    issues.push(error('EXPERIMENT_ENGINEERING_REALISM_ANCHOR', 'BIM/MEP routing 稿件使用合成容量、随机端点或推断连通性时，必须包含真实或准真实工程案例锚点，并说明设备端点、净距、管径/风管或现场语义边界。'));
  }
  if (/Automation in Construction|AiC|BIM|IFC|MEP|routing/i.test(markdown)
    && !/state[- ]of[- ]the[- ]art|SOTA|commercial software|CPLEX|Gurobi|recent graph[- ]based|path planning|clash/i.test(markdown)) {
    issues.push(warning('EXPERIMENT_SOTA_BASELINE', '未检测到面向目标期刊的近期 SOTA、商业软件或强外部 baseline 对照。'));
  }
  if (!/sensitivity analys|parameter sensitivit/i.test(markdown)) issues.push(warning('EXPERIMENT_SENSITIVITY', '未检测到参数敏感性分析。'));
  if (!/ablation/i.test(markdown)) issues.push(warning('EXPERIMENT_ABLATION', '未检测到消融实验。'));
  if (/solver|mixed-integer|MILP/i.test(markdown) && !/solver version|Gurobi\s+\d|CPLEX\s+\d|threads?|MIP gap/i.test(markdown)) {
    issues.push(warning('REPRO_SOLVER_CONFIGURATION', '提到求解器，但未检测到版本、线程、容差或 MIP gap 等关键配置。'));
  }
  if (!/code availability|data availability|github\.com|zenodo|repository/i.test(markdown)) {
    issues.push(warning('REPRO_AVAILABILITY', '未检测到代码或数据可用性声明。'));
  }
  if (/repository URL to be added|upon acceptance|available upon request|will be made available/i.test(markdown)) {
    issues.push(error('REPRO_REPOSITORY_NOT_AVAILABLE', '以可复现性为贡献的论文不能写 repository URL to be added / upon acceptance；投稿前必须提供匿名或公开可访问仓库、DOI 或哈希清单。'));
  }
  if (/all data, code, and validation scripts are provided/i.test(markdown)
    && !/github\.com|zenodo|osf\.io|doi\.org|sha-256|sha256/i.test(markdown)) {
    issues.push(error('REPRO_UNBACKED_AVAILABILITY_CLAIM', '正文声称已提供数据、代码和验证脚本，但未检测到仓库、DOI 或 SHA-256 证据。'));
  }
  if (/\bpreregistered\b/i.test(markdown)
    && !/timestamp|registration|registered protocol|osf\.io|protocol DOI|doi\.org/i.test(markdown)) {
    issues.push(error('REPRO_UNSUPPORTED_PREREGISTRATION', '未检测到时间戳或注册记录时不得使用 preregistered；应改为 pre-specified experimental design。'));
  }
  if (/\bfor the first time\b|first\s+(?:BIM|MEP|IFC|Lagrangian|column generation)/i.test(markdown)) {
    issues.push(error('CLAIM_UNVERIFIED_FIRSTNESS', 'first/for the first time 属高风险创新主张；除非有系统检索证据，否则应改成与已有方法的具体差异。'));
  }

  return buildReport(issues, {
    headings: headings.length,
    mathExpressions: displayMath + inlineMath,
    displayMath,
    tableReferences,
    tables,
    figureReferences,
    figures,
    theorems,
  });
}

/** Inspect exported DOCX through Pandoc's AST instead of trusting file existence. */
export async function validateDocxFile(docxPath: string, sourceMetrics: PaperQualityMetrics): Promise<PaperQualityReport> {
  if (!existsSync(docxPath)) return buildReport([error('DOCX_MISSING', `DOCX 文件不存在: ${docxPath}`)], emptyMetrics());

  const { stdout } = await execFileAsync(resolvePandocPath(), [docxPath, '--to=json'], {
    timeout: 120000,
    maxBuffer: 30 * 1024 * 1024,
  });
  const ast = JSON.parse(stdout) as unknown;
  const counts = { math: 0, tables: 0, figures: 0 };
  const literalMath: string[] = [];
  walkPandoc(ast, (node) => {
    if (node.t === 'Math') counts.math++;
    if (node.t === 'Table') counts.tables++;
    if (node.t === 'Image') counts.figures++;
    if (node.t === 'Str' && typeof node.c === 'string' && /\$|\\(?:lambda|sum|leq|in|mathcal)/.test(node.c)) literalMath.push(node.c);
  });

  const issues: QualityIssue[] = [];
  if (sourceMetrics.mathExpressions > 0 && counts.math === 0) {
    issues.push(error('DOCX_MATH_NOT_CONVERTED', `源稿有 ${sourceMetrics.mathExpressions} 个公式，但 DOCX 中没有原生数学对象。`));
  }
  if (literalMath.length > 0) issues.push(error('DOCX_LITERAL_MATH', `DOCX 仍含未排版数学标记，例如：${literalMath.slice(0, 5).join(' | ')}`));
  if (sourceMetrics.tableReferences > 0 && counts.tables === 0) issues.push(error('DOCX_MISSING_TABLE', '正文引用了 Table，但 DOCX 中没有真实表格。'));
  if (sourceMetrics.figures > counts.figures) issues.push(error('DOCX_MISSING_FIGURE', `源稿有 ${sourceMetrics.figures} 张图，DOCX 仅检测到 ${counts.figures} 张。`));
  if (sourceMetrics.tableReferences > counts.tables) issues.push(error('DOCX_TABLE_REFERENCE_MISMATCH', `源稿引用了 ${sourceMetrics.tableReferences} 个 Table，DOCX 仅检测到 ${counts.tables} 个真实表格。`));
  if (sourceMetrics.figureReferences > counts.figures) issues.push(error('DOCX_FIGURE_REFERENCE_MISMATCH', `源稿引用了 ${sourceMetrics.figureReferences} 个 Figure，DOCX 仅检测到 ${counts.figures} 张真实图片。`));

  return buildReport(issues, { ...sourceMetrics, mathExpressions: counts.math, tables: counts.tables, figures: counts.figures });
}

export function formatPaperQualityReport(title: string, report: PaperQualityReport): string {
  const lines = [`# ${title}`, '', `Status: ${report.passed ? 'PASS' : 'BLOCKED'}`, '', '## Metrics', '', ...Object.entries(report.metrics).map(([key, value]) => `- ${key}: ${value}`), '', '## Findings', ''];
  if (report.issues.length === 0) lines.push('- None');
  for (const issue of report.issues) lines.push(`- [${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}`);
  return `${lines.join('\n')}\n`;
}

function countMarkdownTables(markdown: string): number {
  return countMatches(markdown, /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/gm);
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function extractReferenceNumbers(markdown: string): number[] {
  return [...markdown.matchAll(/^\s*\[(\d+)\]\s+\S/gm)].map((match) => Number(match[1]));
}

function extractBodyCitationNumbers(markdown: string, firstReferenceIndex: number | undefined): Set<number> {
  const body = firstReferenceIndex === undefined ? markdown : markdown.slice(0, firstReferenceIndex);
  const numbers = new Set<number>();
  for (const match of body.matchAll(/\[(\d+(?:\s*[-,]\s*\d+)*)\]/g)) {
    const parts = match[1].split(',').map((part) => part.trim());
    for (const part of parts) {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        for (let value = start; value <= end; value++) numbers.add(value);
      } else {
        numbers.add(Number(part));
      }
    }
  }
  return numbers;
}

function buildReport(issues: QualityIssue[], metrics: PaperQualityMetrics): PaperQualityReport {
  return { passed: !issues.some((issue) => issue.severity === 'error'), issues, metrics };
}

function emptyMetrics(): PaperQualityMetrics {
  return { headings: 0, mathExpressions: 0, displayMath: 0, tableReferences: 0, tables: 0, figureReferences: 0, figures: 0, theorems: 0 };
}

function error(code: string, message: string): QualityIssue {
  return { code, severity: 'error', message };
}

function warning(code: string, message: string): QualityIssue {
  return { code, severity: 'warning', message };
}

function resolvePandocPath(): string {
  const configured = process.env.PANDOC_PATH?.trim();
  if (configured && !existsSync(configured)) throw new Error(`PANDOC_PATH 不存在: ${configured}`);
  return configured || 'pandoc';
}

function walkPandoc(value: unknown, visit: (node: { t?: string; c?: unknown }) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkPandoc(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as { t?: string; c?: unknown; [key: string]: unknown };
  visit(node);
  for (const child of Object.values(node)) walkPandoc(child, visit);
}
