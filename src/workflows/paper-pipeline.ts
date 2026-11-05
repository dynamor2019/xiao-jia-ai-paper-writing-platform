/**
 * 科技论文研究生命周期（六个主流程，保留20个兼容子任务）
 *
 * 阶段流程：
 * 选题与方案 → 实验与结果验收 → 正式文献检索与精读 → 大纲与正文
 * → 引用核验与科学审查 → 格式检查与终稿引用复核 → 导出与作者确认
 *
 * 特性：
 * - 断点续跑：每阶段完成后自动保存状态
 * - 人工审批：关键阶段暂停等待用户确认
 * - 错误重试：单阶段失败可重试，不影响已完成阶段
 */

import { writeFile, readFile, mkdir, readdir, rename, rm, copyFile } from 'node:fs/promises';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, extname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createInitialState } from '../config/dsh.config.js';
import { PAPER_PHASES, paperStages, phaseForStage } from '../../config/dsh/web/paper-phases.js';
import { beginTask, finishTask, canDegradeTask, assertRecoverableContentFailure, resolveTaskMarkers, type ProgressState } from './phase-progress.js';
import { resultInterpretationInstructions } from './result-interpretation.js';
import { maintainPipelineArtifacts } from './artifact-inventory.js';
import { reconcileReproducibilityResult } from './result-artifact.js';
import { runExperimentPlan, type ExperimentPlan, type ExperimentPlanOptions, type ExperimentPlanCheckpoint } from './experiment-plan.js';
import { deliveryGateStatuses } from './delivery-gates.js';
import { pruneOldBackups } from '../lib/backup-retention.js';
import { polishWithCheckpoints } from './polish-checkpoint.js';
import { runQualityReviewRounds } from './quality-review-progress.js';
import { finalReviewFeedbackStarted, runFinalReviewFeedback } from './final-review-feedback.js';
import { assertPrimaryExperimentScope, researchInputInstructions } from './research-input-policy.js';
import { conditionalNetworkEvidence, isConditionalNetwork } from '../plugins/research/conditional-network-results.js';
import { integrateExperiment, integratedEvidence, integratedProtocol, type ExperimentIntegration } from './experiment-integration.js';
import { reconcileWritingStages, writingTasks } from './writing-stage-scope.js';
import { literatureRecencyStats, MIN_RECENT_REFERENCE_SHARE } from '../lib/literature-balance.js';
import { getRoute, printRoutingTable } from '../config/model-routing.js';
import { formatJournalInstructions, getJournalProfile, listJournalProfiles, type JournalProfile } from '../config/journal-profiles.js';
import type { PipelineState, PipelineStage, Paper, PaperNote, Outline, OutlineNode, Section } from '../types.js';

import { parseDocument } from '../plugins/literature/pdf-parser.js';
import { batchSummarizePapers } from '../plugins/literature/paper-summarizer.js';
import { createResearchProtocol, discoverResearchTopic, runExperiment, validateEmpiricalManifest, validateExperimentResults } from '../plugins/research/research-lifecycle.js';
import { validateTopicReview, type ResearchDirection, type TopicReview } from '../plugins/research/topic-evaluation.js';
import { generateOutline, flattenOutline } from '../plugins/writing/outline-generator.js';
import { writeSectionParagraph } from '../plugins/writing/section-writer.js';
import { checkCoherence } from '../plugins/writing/coherence-checker.js';
import { polishSection } from '../plugins/writing/polish-editor.js';
import { formatAcademicStyleReport } from '../plugins/writing/academic-style.js';
import { generateVerificationReport } from '../plugins/verification/citation-verifier.js';
import { recoverDraftCitations, verifyDraftCitations } from './citation-recovery.js';
import { outlineSections } from './outline-sections.js';
import { buildAuthorReviewSections } from './review-draft.js';
import { checkPlagiarism } from '../plugins/verification/plagiarism-checker.js';
import { formatPaperQualityReport, validateDocxFile, validateMarkdownPaper } from '../plugins/verification/paper-quality-validator.js';
import { formatCrossReviewRounds, formatScientificReview, manuscriptReviewBlocked, reviseSectionsFromReviews } from '../plugins/verification/scientific-quality-reviewer.js';
import { exportToDocx } from '../plugins/export/docx-exporter.js';
import { exportToLatex } from '../plugins/export/latex-exporter.js';
import { readFeedback } from '../../config/dsh/web/paper-feedback.js';
import { adoptCanonicalDraft, canonicalScope, renderCanonicalMarkdown, syncCanonicalDraft } from './canonical-draft.js';
import { renderAuthorBlock } from '../../config/dsh/web/manuscript-authors.mjs';
import { reviewWithAdjudication } from './scientific-review-gate.js';
import { deliveryReviewEvidence } from './delivery-review-evidence.js';
import { auditLiteratureCompleteness, formatLiteratureCompleteness } from './literature-completeness.js';
import { assertLiteratureRevisionIntegrity, authorizeLiteratureBillingResume, prepareLiteratureRevision, prepareResultLiterature, requestLiteratureRevision, runLiteratureRevision, type LiteratureRevisionState } from './literature-revision.js';

const STATE_FILE = 'paper-pipeline-state.json';
const LOCK_FILE = 'paper-pipeline.lock.json';

// 需要人工审批的阶段
const APPROVAL_STAGES: PipelineStage[] = ['topic-confirmation', 'protocol-design', 'outline-generation', 'submission-readiness'];

function collectArgumentNodes(nodes: OutlineNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const indent = '  '.repeat(depth);
    const argument = node.argument?.trim() || '待补充';
    const papers = node.supportingPapers?.length ? node.supportingPapers.join(', ') : '暂无文献线索，需说明原因';
    return [
      `${indent}- **${node.id} ${node.title}**`,
      `${indent}  - 核心论点：${argument}`,
      `${indent}  - 文献线索（尚待核验）：${papers}`,
      ...collectArgumentNodes(node.children || [], depth + 1),
    ];
  });
}

function readBlueprintSection(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return '';
  const bodyStart = markdown.indexOf('\n', start);
  if (bodyStart < 0) return '';
  const nextHeading = markdown.indexOf('\n## ', bodyStart + 1);
  return markdown.slice(bodyStart + 1, nextHeading < 0 ? undefined : nextHeading).trim();
}

/** Render the outline as an author-reviewable argument map without adding model calls. */
export function renderArgumentBlueprint(topic: string, outline: Outline, previous = ''): string {
  const authorAnswer = readBlueprintSection(previous, '中心回答（作者确认）') || '[待作者填写：用一至两句直接回答研究问题，明确结论范围。]';
  const alternatives = readBlueprintSection(previous, '替代解释与适用边界（作者确认）') || '[待作者填写：主要替代解释、结论边界与不确定性；如不适用，请说明原因。]';
  const claims = collectArgumentNodes(outline.nodes).join('\n') || '- 大纲尚无论点节点。';
  const roadmap = outline.nodes.map((node) => `${node.id} ${node.title}`).join(' → ') || '待补充';

  return [
    '# 论证蓝图（大纲阶段草案）',
    '',
    '> 由现有大纲自动整理；文献线索尚待核验，经验结果不得在数据门禁通过前写成发现。',
    '',
    '## 研究问题',
    topic,
    '',
    '## 中心回答（作者确认）',
    authorAnswer,
    '',
    '## 主张与证据路径（由大纲生成）',
    claims,
    '',
    '## 读者路线图',
    roadmap,
    '',
    '## 替代解释与适用边界（作者确认）',
    alternatives,
    '',
    '## 审批前核对',
    '- 每项主张都直接推进对研究问题的回答，取有深度的论证，不为覆盖面堆砌主题。',
    '- 文献综述综合研究之间的支持、冲突与局限，不把“缺少检索结果”直接当作研究空白。',
    '- 对经验或因果主张，明确可区分的替代解释与观测证据；假设不是研究发现。',
    '- 正文段落有清晰主张、支持证据和解释，并说明它对总论证的作用。',
    '- 结论回答研究问题，不引入未在正文论证的新主张。',
    '',
  ].join('\n');
}

type ApprovalMode = 'auto' | 'topic' | 'all';
export const PIPELINE_STAGES = paperStages() as PipelineStage[];

interface PipelineOptions {
  repairStage?: PipelineStage;
  billingRestored?: boolean;
  experimentResolution?: ExperimentPlanOptions['authorResolution'];
  inputDir?: string;
  journalId?: string;
  experimentCommand?: string;
  resultsFile?: string;
  outputDir?: string;
  paperProjectId?: string;
  researchDirection?: NonNullable<PipelineState['metadata']['researchDirection']>;
  decision?: string;
}

export interface PendingQuestion {
  id: string;
  stage: PipelineStage;
  question: string;
  choices: { id: string; label: string }[];
  answer?: string;
}

/** Pause with a concrete choice. A stored answer is consumed once; silence stays paused. */
export function stagePendingQuestion(state: PipelineState, id: string, stage: PipelineStage, question: string, choices: { id: string; label: string }[]): 'pause' | string {
  const pending = state.metadata.pendingQuestion;
  if (pending?.id === id && pending.answer && pending.choices.some((choice) => choice.id === pending.answer)) {
    const answer = pending.answer;
    delete state.metadata.pendingQuestion;
    delete state.metadata.awaitingApproval;
    return answer;
  }
  state.metadata.pendingQuestion = { id, stage, question, choices };
  state.metadata.awaitingApproval = stage;
  return 'pause';
}

/** Accept only one of the choices currently stored on the checkpoint. */
export function acceptPendingDecision(state: PipelineState, decision: string): boolean {
  const pending = state.metadata.pendingQuestion;
  if (!pending?.choices.some((choice) => choice.id === decision)) return false;
  pending.answer = decision;
  return true;
}

export class PaperPipeline {
  private state: PipelineState;
  private onApproval?: (stage: PipelineStage, state: PipelineState) => Promise<boolean>;
  private inputDir?: string;
  private journalProfile?: JournalProfile;
  private outputDir: string;
  private sharedDataRoot: string;
  private sharedDataScope: string;
  private stateDir: string;
  private milestoneDir: string;
  private runtimeDir: string;
  private workDir: string;
  private reportsDir: string;
  private logsDir: string;
  private finalDir: string;
  private extractedTextDir: string;
  private decision?: string;
  private experimentResolution?: ExperimentPlanOptions['authorResolution'];
  private billingRestored = false;
  private repairStage?: PipelineStage;

  constructor(topic?: string, onApproval?: (stage: PipelineStage, state: PipelineState) => Promise<boolean>, options: PipelineOptions = {}) {
    this.onApproval = onApproval;
    this.decision = options.decision;
    this.experimentResolution = options.experimentResolution;
    this.billingRestored = options.billingRestored === true;
    this.repairStage = options.repairStage;
    this.inputDir = options.inputDir;
    this.outputDir = normalizeOutputDir(options.outputDir || process.env.PAPER_OUTPUT_DIR || createPaperOutputDir(topic || 'paper', options.paperProjectId));
    this.sharedDataRoot = resolve(process.env.PAPER_SHARED_DATA_ROOT || join(paperOutputRoot(), 'shared'));
    this.sharedDataScope = safeFileBase(basename(this.outputDir));
    this.stateDir = join(this.outputDir, '.dsh-state');
    this.milestoneDir = join(this.outputDir, 'milestones');
    this.runtimeDir = join(this.stateDir, 'runtime');
    this.workDir = join(this.runtimeDir, 'work');
    this.reportsDir = this.milestoneDir;
    this.logsDir = join(this.milestoneDir, 'reproducibility', 'logs');
    this.finalDir = join(this.outputDir, 'final');
    this.extractedTextDir = join(this.milestoneDir, 'source-texts');
    // 尝试从断点恢复
    const saved = this.loadState();
    this.inputDir ||= saved?.metadata?.inputDir;
    const effectiveJournalId = options.journalId || saved?.metadata?.targetJournalId;
    this.journalProfile = getJournalProfile(effectiveJournalId);
    if (effectiveJournalId && effectiveJournalId !== 'general' && !this.journalProfile) {
      throw new Error(`未知目标期刊: ${effectiveJournalId}。可用值: ${listJournalProfiles().map((item) => item.id).join(', ')}`);
    }
    if (saved) {
      this.state = saved;
      console.log(`[恢复] 从断点继续，当前阶段: ${saved.stage}`);
    } else if (topic) {
      this.state = createInitialState(topic);
    } else {
      throw new Error('必须提供选题或存在已保存的状态');
    }
    this.state.metadata.targetJournalId = this.journalProfile?.id;
    this.state.metadata.originalTopic ||= topic || this.state.topic;
    this.state.metadata.experimentCommand = options.experimentCommand || this.state.metadata.experimentCommand;
    this.state.metadata.resultsFile = options.resultsFile || this.state.metadata.resultsFile;
    this.state.metadata.researchDirection = options.researchDirection || this.state.metadata.researchDirection;
    this.state.metadata.outputDir = this.outputDir;
    this.state.metadata.inputDir = options.inputDir || this.state.metadata.inputDir;
    this.state.metadata.paperProjectId = options.paperProjectId || this.state.metadata.paperProjectId;
    this.state.stage = migrateLegacyStage(this.state.stage);
  }

  /** Explicitly integrate audited work under the same project lock; no checkpoint shortcuts. */
  integrateExperiment(request: ExperimentIntegration): void {
    const releaseLock = this.acquireProjectLock();
    try {
      if (integrateExperiment(this.outputDir, this.state, request)) this.saveState();
    } finally { releaseLock(); }
  }

  private researchInstructions(): string {
    const sourceScope = canonicalScope(this.outputDir, this.state.sections);
    if (sourceScope) return [formatJournalInstructions(this.journalProfile), sourceScope, this.sharedDataInstructions(), researchInputInstructions(this.outputDir), resultInterpretationInstructions(this.outputDir, this.state.metadata.resultsFile)].filter(Boolean).join('\n\n');
    const direction = this.state.metadata.researchDirection;
    const controls = [
      direction?.focus && `Core focus and contribution: ${direction.focus}`,
      direction?.scope && `Scope and exclusions: ${direction.scope}`,
      direction?.method && `Method and experiment preference: ${direction.method}`,
      direction?.constraints && `Data and implementation constraints: ${direction.constraints}`,
    ].filter(Boolean);
    return [
      formatJournalInstructions(this.journalProfile),
      controls.length > 0 ? `Research direction controls:\n${controls.join('\n')}` : '',
      this.topicBoundaryInstructions(),
      this.sharedDataInstructions(),
      researchInputInstructions(this.outputDir),
      resultInterpretationInstructions(this.outputDir, this.state.metadata.resultsFile),
      integratedProtocol(this.state) && readFileSync(integratedProtocol(this.state)!, 'utf8'),
    ].filter(Boolean).join('\n\n');
  }

  private sharedDataInstructions(): string {
    return [
      `Shared immutable data root: ${this.sharedDataRoot}`,
      `Paper data scope: ${this.sharedDataScope}`,
      'Use @shared/datasets/<dataset>/<version>/... for shared source data and bind it in sourceFiles; never copy large source datasets into the paper project.',
      `Write experiment results under @shared/processed/${this.sharedDataScope}/<unique-run-id>/...; keep scripts, protocol, logs, checkpoints, manuscript and delivery files in the paper project.`,
      'Use a new run-id for each run; never overwrite another paper/run. Shared data references are hash-checked and symlinks/path traversal are rejected.',
    ].join('\n');
  }

  /** Bind scientific review and revision to the same validated results used for writing. */
  private async scientificReviewInstructions(): Promise<string> {
    const supportPath = join(this.outputDir, 'delivery', 'conditional-case-support-v1', 'support-evidence.md');
    const support = existsSync(supportPath) ? readFileSync(supportPath, 'utf8') : '';
    const approvedScopePath = join(this.outputDir, 'milestones', 'reproducibility', 'author-approved-scope.md');
    const approvedScope = existsSync(approvedScopePath) ? readFileSync(approvedScopePath, 'utf8') : '';
    const scopeInstructions = approvedScope
      ? `Current author-approved scope (supersedes historical ambitions, not evidence or integrity):\n${approvedScope}` : '';
    return [scopeInstructions, this.researchInstructions(), await this.loadValidatedResultEvidence(), support,
      deliveryReviewEvidence(this.outputDir)].filter(Boolean).join('\n\n');
  }

  private topicBoundaryInstructions(): string {
    const selected = this.loadSelectedTopic();
    if (!selected) return '';
    const transfer = selected.transfer;
    return [
      'Frozen interdisciplinary topic controls:',
      `- Final research question: ${selected.researchQuestion}`,
      `- Home discipline: ${transfer.homeDiscipline}`,
      `- Source discipline and borrowed method: ${transfer.sourceDiscipline}; ${transfer.borrowedMethod}`,
      `- Transfer mechanism to preserve: ${transfer.transferMechanism}`,
      `- Assumptions that must be tested or stated: ${transfer.assumptions.join('; ')}`,
      `- Boundaries that must not be exceeded: ${transfer.boundaries.join('; ')}`,
      `- Failure conditions to report: ${transfer.failureConditions.join('; ')}`,
      `- Baseline comparison: ${selected.baseline}`,
      `- Falsification standard: ${selected.falsification}`,
      `- Data access path: ${selected.dataAccess}`,
      'Do not broaden the claim beyond these controls; if evidence is missing, narrow the claim instead of filling gaps from model memory.',
    ].join('\n');
  }

  private loadSelectedTopic(): ResearchDirection | undefined {
    const discoveryPath = join(this.stateDir, 'topic-discovery.json');
    if (!existsSync(discoveryPath)) return undefined;
    try {
      const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { selected?: ResearchDirection };
      return discovery.selected;
    } catch {
      return undefined;
    }
  }

  private researchContext(): string {
    return [this.state.metadata.originalTopic || this.state.topic, this.researchInstructions()].filter(Boolean).join('\n\n');
  }

  private isEmpiricalProject(): boolean {
    const discoveryPath = join(this.stateDir, 'topic-discovery.json');
    let selectedMethod = '';
    if (existsSync(discoveryPath)) {
      const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { selected?: { method?: string } };
      selectedMethod = discovery.selected?.method || '';
    }
    const text = [
      this.state.topic,
      this.state.metadata.originalTopic,
      this.state.metadata.researchDirection?.focus,
      this.state.metadata.researchDirection?.method,
      this.state.metadata.researchDirection?.constraints,
      selectedMethod,
    ].filter(Boolean).join('\n');
    return /\b(?:did|iv|rdd?|rct|dml|causal|econometric|empirical|regression|panel|instrumental|event study)\b|因果|计量|实证|回归|面板|工具变量|双重差分|断点|随机实验/i.test(text);
  }

  /** 运行完整工作流 */
  async exportAuthorReviewDraft(): Promise<string> {
    const releaseLock = this.acquireProjectLock();
    try {
      assertPrimaryExperimentScope(this.outputDir, this.state.metadata.resultsFile);
      await this.loadValidatedResultEvidence();
      const sections = buildAuthorReviewSections(outlineSections(this.state.sections, this.state.outline), this.state.stage);
      const outputDir = join(this.outputDir, 'review-draft');
      const result = await exportToDocx(sections, this.state.papers, {
        title: 'AUTHOR REVIEW DRAFT - NOT VALIDATED - ' + this.state.topic,
        outputDir, projectDir: this.outputDir, citationStyle: 'GB-T-7714',
      });
      if (!result.success || !result.data) throw new Error(result.error || 'Author review draft export failed');
      await writeFile(join(outputDir, 'review-status.md'), sections[0].content + '\n', 'utf8');
      return result.data.filePath;
    } finally {
      releaseLock();
    }
  }

  /** Request a DSH-owned targeted literature repair while preserving all review history. */
  requestLiteratureRevision(reason: string): void {
    const releaseLock = this.acquireProjectLock();
    try {
      if (renderCanonicalMarkdown(this.state.sections)) throw new Error('Bound canonical draft requires an explicit stable-library migration before literature revision');
      const checkpoint = join(this.stateDir, STATE_FILE);
      if (existsSync(checkpoint)) {
        const backup = `${checkpoint}.before-literature-${createHash('sha256').update(readFileSync(checkpoint)).digest('hex').slice(0, 12)}.bak`;
        if (!existsSync(backup)) writeFileSync(backup, readFileSync(checkpoint));
        pruneOldBackups(checkpoint);
      }
      requestLiteratureRevision(this.state, reason);
      this.saveState();
    } finally { releaseLock(); }
  }

  /** Record a single author-confirmed billing recovery under the existing project lock. */
  confirmLiteratureBillingRestored(reason: string, confirmed: boolean): void {
    const releaseLock = this.acquireProjectLock();
    try {
      const checkpoint = join(this.stateDir, STATE_FILE);
      if (existsSync(checkpoint)) {
        const backup = `${checkpoint}.before-billing-resume-${createHash('sha256').update(readFileSync(checkpoint)).digest('hex').slice(0, 12)}.bak`;
        if (!existsSync(backup)) writeFileSync(backup, readFileSync(checkpoint));
        pruneOldBackups(checkpoint);
      }
      authorizeLiteratureBillingResume(this.state, reason, confirmed);
      this.saveState();
    } finally { releaseLock(); }
  }

  /** Ask for a choice and pause this stage until that exact choice is supplied. */
  private askPending(id: string, question: string, choices: { id: string; label: string }[]): 'pause' | string {
    if (this.decision && this.state.metadata.pendingQuestion?.id === id) {
      acceptPendingDecision(this.state, this.decision);
      this.decision = undefined;
    }
    const outcome = stagePendingQuestion(this.state, id, this.state.stage, question, choices);
    this.saveState();
    const pending = this.state.metadata.pendingQuestion;
    if (outcome === 'pause' && pending) {
      console.log(`[询问] ${pending.question}`);
      for (const choice of pending.choices) console.log(`  - ${choice.id}: ${choice.label}`);
      console.log('用 /paper-confirm <选项> 回答。标记会保留，稿件不会因此变成投稿就绪。');
    }
    return outcome;
  }

  /** Keep another open chain closed unless the author explicitly chooses to close it. */
  private resolveOpenWorkChain(): boolean {
    const chainPath = join(this.stateDir, 'work-chain.json');
    if (!existsSync(chainPath)) return true;
    const chain = JSON.parse(readFileSync(chainPath, 'utf8')) as { active?: { id?: string; status?: string; title?: string; note?: string; closedAt?: string } };
    const active = chain.active;
    if (!active || active.status === 'closed' || active.id === 'pipeline') return true;
    const outcome = this.askPending('work-chain', `当前工作链未结束：${active.title || active.id}（${active.status}）。写作不会自动开始，也不会编造结果。`, [
      { id: 'keep', label: '保持这条工作链，先不写作' },
      { id: 'close-and-continue', label: '关闭这条工作链，并从当前检查点继续' },
    ]);
    if (outcome !== 'close-and-continue') return false;
    active.status = 'closed';
    active.closedAt = new Date().toISOString();
    active.note = `${active.note || ''} 作者明确选择关闭这条工作链后再继续。`.trim();
    writeFileSync(chainPath, `${JSON.stringify(chain, null, 2)}\n`);
    return true;
  }

  /** Run the gated workflow independently of author-only draft copies. */
  async run(): Promise<PipelineState> {
    const releaseLock = this.acquireProjectLock();
    try {
      if (this.repairStage) {
        if (!['citation-verification', 'polishing', 'quality-validation', 'formatting'].includes(this.repairStage)
          || !this.state.sections.length) throw new Error('Only an existing manuscript gate may be repaired');
        this.state.stage = this.repairStage;
        delete this.state.metadata.awaitingApproval;
        this.repairStage = undefined;
        this.saveState();
      }
      if (this.decision) {
        if (!acceptPendingDecision(this.state, this.decision)) console.log(`[询问] 不能使用 ${this.decision}。请从当前问题的选项里选择。`);
        this.decision = undefined;
        this.saveState();
      }
      if (!this.resolveOpenWorkChain()) return this.state;
      const revision = (this.state as LiteratureRevisionState).literatureRevision;
      if (revision && !['completed', 'marked'].includes(revision.status)
        && PIPELINE_STAGES.indexOf(this.state.stage) > PIPELINE_STAGES.indexOf('literature-search')) {
        this.state.stage = 'literature-search';
        console.log('[DSH phase correction] Incomplete literature revision resumes at literature search, not at a later delivery stage.');
      }
      if (PIPELINE_STAGES.indexOf(this.state.stage) >= PIPELINE_STAGES.indexOf('results-writing')) {
        assertPrimaryExperimentScope(this.outputDir, this.state.metadata.resultsFile);
      }
      if (adoptCanonicalDraft(this.outputDir, this.state)) {
        console.log('[现稿接续] 已接入经源审计的完整稿件；跳过已保存段落，继续引用、润色与质量门禁。');
      }
      if (!renderCanonicalMarkdown(this.state.sections)) reconcileWritingStages(this.state);
      this.saveState();
      return await this.runLocked();
    } finally {
      releaseLock();
    }
  }

  private async runLocked(): Promise<PipelineState> {
    // 启动时打印模型路由表
    printRoutingTable();
    console.log(`[目标期刊] ${this.journalProfile?.name || '通用论文模式'}`);
    console.log(`[论文工作目录] ${this.outputDir}`);

    const stages = PIPELINE_STAGES;

    // 从当前阶段开始
    const startIndex = stages.indexOf(this.state.stage);
    if (startIndex < 0) throw new Error(`Invalid workflow checkpoint stage: ${this.state.stage}`);

    for (let i = startIndex; i < stages.length; i++) {
      const stage = stages[i];
      this.state.stage = stage;
      this.state.metadata.currentStageStartTime = new Date().toISOString();

      console.log(`\n${'='.repeat(60)}`);
      console.log(`[阶段 ${i + 1}/${stages.length}] ${stage}`);
      const phase = phaseForStage(stage)!;
      console.log(`[主流程 ${PAPER_PHASES.indexOf(phase) + 1}/6] ${phase[1]}`);
      console.log(`${'='.repeat(60)}`);

      if (this.state.metadata.awaitingApproval === stage && this.state.metadata.pendingQuestion?.stage === stage) {
        if (!this.state.metadata.pendingQuestion.answer) {
          console.log(`[询问] ${this.state.metadata.pendingQuestion.question}`);
          this.saveState();
          return this.state;
        }
        delete this.state.metadata.awaitingApproval;
        this.saveState();
      } else if (this.state.metadata.awaitingApproval === stage && this.onApproval) {
        const approved = await this.onApproval(stage, this.state);
        if (!approved) {
          console.log(`[等待确认] ${stage}`);
          this.saveState();
          return this.state;
        }
        if (stage === 'protocol-design') await this.runPlannedExperiments('pilot');
        delete this.state.metadata.awaitingApproval;
        finishTask(this.state, stage, 'complete');
        if (stage !== 'submission-readiness' && stages[i + 1]) this.state.stage = stages[i + 1];
        this.saveState();
        console.log(`[确认通过] ${stage}`);
        if (stage !== 'submission-readiness') continue;
      }

      try {
        beginTask(this.state, stage, this.billingRestored);
        this.billingRestored = false;
        this.saveState();
        await this.executeStage(stage);
        this.saveState();
        if (this.state.stage !== stage) {
          finishTask(this.state, stage, 'waiting', `Handed off to ${this.state.stage}`);
          this.saveState();
          const nextIndex = stages.indexOf(this.state.stage);
          if (nextIndex < 0) throw new Error('Invalid workflow phase transition');
          console.log(`[阶段转交] ${stage} -> ${this.state.stage}；不在核验阶段执行检索或写作。`);
          i = nextIndex - 1;
          continue;
        }
        if (this.state.metadata.awaitingApproval === stage) {
          finishTask(this.state, stage, 'waiting');
          this.saveState();
          console.log(`[等待作者输入] ${stage}；已完成的稿件交付保持有效。`);
          return this.state;
        }
        console.log(`[完成] ${stage}`);
        if ((this.state as ProgressState).metadata.workflow?.tasks[stage]?.status !== 'degraded') {
          finishTask(this.state, stage, 'complete');
          resolveTaskMarkers(this.state, stage);
        }
        if (APPROVAL_STAGES.includes(stage) && this.onApproval) {
          const approved = await this.onApproval(stage, this.state);
          if (!approved) {
            this.state.metadata.awaitingApproval = stage;
            finishTask(this.state, stage, 'waiting');
            console.log(`[等待确认] ${stage}`);
            this.saveState();
            return this.state;
          }
          delete this.state.metadata.awaitingApproval;
        }
        if (stages[i + 1]) this.state.stage = stages[i + 1];
        this.saveState();
        if (phaseForStage(stages[i + 1])?.[0] !== phase[0]) await this.cleanupRuntimeFiles();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const degraded = canDegradeTask(stage, error);
        finishTask(this.state, stage, degraded ? 'degraded' : 'failed', message);
        console.error(`[失败] ${stage}:`, error);
        this.saveState();
        if (degraded) {
          await this.recordDraftMarker(`[${stage}] Unvalidated draft fallback: ${message}`);
          if (stages[i + 1]) this.state.stage = stages[i + 1];
          this.saveState();
          continue;
        }
        throw error;
      }
    }

    await this.cleanupRuntimeFiles();
    console.log('\n研究、写作、质量与投稿前交付阶段全部完成。');
    return this.state;
  }

  private acquireProjectLock(): () => void {
    mkdirSync(this.stateDir, { recursive: true });
    const lockPath = join(this.stateDir, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, 'wx');
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        } catch (writeError) {
          closeSync(fd);
          unlinkSync(lockPath);
          throw writeError;
        }
        closeSync(fd);
        return () => unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let ownerPid: number | undefined;
        try {
          ownerPid = JSON.parse(readFileSync(lockPath, 'utf8')).pid;
          if (Number.isInteger(ownerPid)) process.kill(ownerPid!, 0);
          else ownerPid = undefined;
        } catch (checkError) {
          if ((checkError as NodeJS.ErrnoException).code === 'EPERM') throw new Error(`论文项目正由进程 ${ownerPid} 使用`);
          ownerPid = undefined;
        }
        if (ownerPid) throw new Error(`论文项目正由进程 ${ownerPid} 使用`);
        try {
          unlinkSync(lockPath);
        } catch (removeError) {
          if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError;
        }
      }
    }
    throw new Error(`无法取得论文项目锁: ${lockPath}`);
  }

  /** 执行单个阶段 */
  private async executeStage(stage: PipelineStage): Promise<void> {
    switch (stage) {
      case 'project-intake':
        await this.stageProjectIntake();
        break;
      case 'topic-discovery':
        await this.stageTopicDiscovery();
        break;
      case 'topic-confirmation':
        await this.stageTopicConfirmation();
        break;
      case 'literature-search':
        await this.stageLiteratureSearch();
        break;
      case 'literature-review':
        await this.stageLiteratureReview();
        break;
      case 'protocol-design':
        await this.stageProtocolDesign();
        break;
      case 'outline-generation':
        await this.stageOutlineGeneration();
        break;
      case 'introduction-writing':
        await this.stageSectionWriting('前言与相关工作');
        break;
      case 'experiment-execution':
        await this.stageExperimentExecution();
        break;
      case 'data-validation':
        await this.stageDataValidation();
        break;
      case 'methods-writing':
        await this.stageSectionWriting('方法与实验设置');
        break;
      case 'results-writing':
        await this.stageSectionWriting('研究结果');
        break;
      case 'discussion-writing':
        await this.stageSectionWriting('讨论与局限');
        break;
      case 'manuscript-completion':
        if (this.state.outline && !flattenOutline(this.state.outline.nodes).some((node) => /abstract|摘要/i.test(node.title))) {
          this.state.outline.nodes.unshift({ id: 'abstract', level: 1, title: 'Abstract', estimatedWords: 250, supportingPapers: [] });
        }
        await this.stageSectionWriting('摘要、结论及其余章节', true);
        reconcileWritingStages(this.state);
        break;
      case 'citation-verification':
        await this.stageCitationVerification();
        break;
      case 'polishing':
        await this.stagePolishing();
        break;
      case 'quality-validation':
        await this.stageQualityValidation();
        break;
      case 'formatting':
        await this.stageFormatting();
        break;
      case 'submission-readiness':
        await this.stageSubmissionReadiness();
        break;
      case 'export':
        await this.stageExport();
        break;
    }
  }

  // ===== 阶段 1: 项目建档 =====
  private async stageProjectIntake(): Promise<void> {
    await this.ensureProjectDirs();
    const path = this.outputPath('research-brief.md');
    if (!existsSync(path)) {
      const direction = this.state.metadata.researchDirection;
      await writeFile(path, `# Research Brief\n\n- 宽泛研究领域：${this.state.metadata.originalTopic || this.state.topic}\n- 核心重点与贡献：${direction?.focus || '由联网选题阶段细化'}\n- 研究范围与排除项：${direction?.scope || '由联网选题阶段细化'}\n- 方法与实验偏好：${direction?.method || '由研究方案阶段确定'}\n- 数据与实施约束：${direction?.constraints || '由研究方案阶段确定'}\n- 目标期刊：${this.journalProfile?.name || '待选择'}\n- 最终研究问题：由联网选题阶段确定\n- 完成定义：研究、数据、稿件、质量与投稿门禁全部通过\n`, 'utf8');
    }
    const lifecycleFiles: Array<[string, string]> = [
      [this.outputPath('revision-log.md'), '# Revision Log\n\n| Version | Date | Trigger | Changes | Evidence rerun | Quality status |\n|---|---|---|---|---|---|\n'],
      [this.outputPath('publication-record.md'), `# Publication Record\n\n- 目标期刊：${this.journalProfile?.name || '待选择'}\n- 投稿日期：待填写\n- Manuscript ID：待填写\n- 编辑决定：未投稿\n- 审稿轮次：0\n- 接收日期：待填写\n- DOI / 正式链接：待填写\n`],
    ];
    for (const [file, content] of lifecycleFiles) {
      if (!existsSync(file)) await writeFile(file, content, 'utf8');
    }
  }

  // ===== 阶段 2: 联网选题 =====
  private async stageTopicDiscovery(): Promise<void> {
    const route = getRoute('discovery');
    console.log(`正在联网检索并评估研究方向... [模型] ${route.provider.toUpperCase()} / ${route.model}`);
    const result = await discoverResearchTopic(this.researchContext(), this.researchInstructions(), this.milestoneDir);
    if (!result.success || !result.data) throw new Error(result.error || '联网选题没有返回结果');
    const discoveryJson = join(this.milestoneDir, 'topic-discovery.json');
    const storedDiscoveryJson = join(this.stateDir, 'topic-discovery.json');
    if (existsSync(discoveryJson)) {
      await rm(storedDiscoveryJson, { force: true });
      await rename(discoveryJson, storedDiscoveryJson);
    }
    this.state.topic = result.data.selected.title;
    this.state.papers = result.data.works;
    console.log(`推荐方向: ${this.state.topic}`);
    console.log(`选题证据: ${this.outputPath('topic-discovery.md')}`);
  }

  // ===== 阶段 1: 选题确认 =====
  private async stageTopicConfirmation(): Promise<void> {
    const discoveryPath = join(this.stateDir, 'topic-discovery.json');
    if (!existsSync(discoveryPath)) throw new Error('缺少选题证据与独立复核记录，不能继续论文流程');
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { selected?: { title?: string }; review?: TopicReview };
    if (discovery.selected?.title !== this.state.topic || !discovery.review) throw new Error('选题与复核记录不一致，不能继续论文流程');
    validateTopicReview(discovery.review);
    console.log(`选题: ${this.state.topic}`);
    console.log('请确认选题是否合适（审批节点）');
    // 实际审批由 onApproval 回调处理
  }

  // ===== 阶段 2: 文献检索 =====
  private async stageLiteratureSearch(): Promise<void> {
    const evidence = await this.loadValidatedResultEvidence();
    const options = { instructions: await this.scientificReviewInstructions(), evidence, save: () => this.saveState() };
    const revision = (this.state as LiteratureRevisionState).literatureRevision;
    if (revision) {
      if (revision.status === 'marked') return;
      let preparing = true;
      while (preparing) {
        try {
          await prepareLiteratureRevision(this.state, options);
          preparing = false;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          assertRecoverableContentFailure(message);
          const outcome = this.state.metadata.pendingQuestion?.id === 'literature-revision' ? this.askPending('literature-revision', `${message}。不合格内容没有写入。`, [
            { id: 'continue-marked', label: '保留标记，继续后面的步骤' },
            { id: 'retry', label: '再试一次这一步' },
          ]) : 'continue-marked';
          if (outcome === 'retry') continue;
          if (outcome !== 'continue-marked') return;
          revision.markers = [...new Set([...(revision.markers || []), message])];
          revision.status = 'marked';
          revision.error = message;
          this.saveState();
          preparing = false;
        }
      }
      return;
    }
    // 如果指定了本地目录，从本地读取文献
    if (this.inputDir) {
      console.log(`从本地目录加载文献: ${this.inputDir}`);
      if (!existsSync(this.inputDir)) {
        throw new Error(`输入目录不存在: ${this.inputDir}`);
      }
      const files = await readdir(this.inputDir);
      const supportedExts = ['.pdf', '.docx', '.txt', '.md'];
      const docFiles = files.filter((f) => supportedExts.includes(extname(f).toLowerCase()));
      if (docFiles.length === 0) {
        throw new Error(`目录中没有支持的文献文件（.pdf/.docx/.txt/.md）: ${this.inputDir}`);
      }
      console.log(`找到 ${docFiles.length} 个文献文件`);

      const localPapers: Paper[] = [];
      await mkdir(this.extractedTextDir, { recursive: true });
      for (const file of docFiles) {
        const docPath = join(this.inputDir, file);
        console.log(`解析: ${file}`);
        const result = await parseDocument(docPath);
        if (result.success && result.data) {
          const paperId = file.replace(/\.(pdf|docx|txt|md)$/i, '');
          const fullTextPath = join(this.extractedTextDir, `${safeFileBase(paperId)}.txt`);
          await writeFile(fullTextPath, result.data.text, 'utf-8');
          localPapers.push({
            id: paperId,
            title: result.data.title || paperId,
            authors: [],
            year: new Date().getFullYear(),
            abstract: result.data.text.substring(0, 2000),
            url: '',
            pdfPath: docPath,
            fullTextPath,
            source: 'manual',
          });
        } else {
          console.warn(`  解析失败: ${result.error}`);
        }
      }
      if (localPapers.length === 0) throw new Error('本地文献全部解析失败，不能进入后续写作');
      this.state.papers = mergePapersById([...localPapers, ...this.state.papers]);
      console.log(`成功加载 ${localPapers.length} 篇本地文献，并保留联网选题证据文献 ${this.state.papers.length - localPapers.length} 篇`);
      return;
    }

    console.log('根据已验收结果定向检索正式写作所需文献，不改变冻结方案或实验结果。');
    await prepareResultLiterature(this.state, options);
    const recency = literatureRecencyStats(this.state.papers);
    if (recency.total === 0) throw new Error('联网文献检索没有返回可用结果');
    const recencyShort = recency.share < MIN_RECENT_REFERENCE_SHARE;
    if (recencyShort) await this.recordDraftMarker(`近五年文献仅 ${recency.recent}/${recency.total}，低于30%；写作继续，交付仍阻断`);
    await writeFile(join(this.milestoneDir, 'literature-recency-report.md'), [
      '# Literature Recency Report',
      '',
      `- Status: ${recencyShort ? 'BLOCKED' : 'PASS'}`,
      `- Recent window: ${recency.cutoffYear}-${new Date().getFullYear()}`,
      `- Recent papers: ${recency.recent}/${recency.total}`,
      `- Recent share: ${(recency.share * 100).toFixed(1)}%`,
      '- Distribution policy: recent and established studies are interleaved before outlining and section assignment.',
      '',
    ].join('\n'), 'utf8');
    console.log(`检索并平衡 ${this.state.papers.length} 篇文献；近五年占比 ${(recency.share * 100).toFixed(1)}%`);
  }

  // ===== 阶段 3: 文献精读 =====
  private async stageLiteratureReview(): Promise<void> {
    if ((this.state as LiteratureRevisionState).literatureRevision) {
      await prepareLiteratureRevision(this.state, { instructions: await this.scientificReviewInstructions(),
        evidence: await this.loadValidatedResultEvidence(), save: () => this.saveState() });
      console.log('[DSH literature evidence] Primary abstract passages and relevance assignments retained; targeted prose begins only in introduction-writing.');
      return;
    }
    const route = getRoute('summary');
    console.log(`正在精读 ${this.state.papers.length} 篇文献...`);
    console.log(`[模型] ${route.provider.toUpperCase()} / ${route.model}`);
    console.log('（每篇文献需要调用模型生成结构化笔记，文献较长时可能需要几分钟）');

    const fullTexts = await this.loadFullTexts();

    // 批量生成笔记（并发2，降低中转站限流概率）
    const notes = await batchSummarizePapers(this.state.papers, fullTexts, 2);
    this.state.notes = notes;

    console.log(`完成 ${notes.size} 篇文献的结构化笔记`);

    // 保存文献笔记到文件
    await mkdir(this.stateDir, { recursive: true });
    const notesPath = join(this.stateDir, 'literature-notes.json');
    const notesObj = Object.fromEntries(notes);
    await writeFile(notesPath, JSON.stringify(notesObj, null, 2), 'utf-8');
    const evidenceRows = [...notes.entries()].flatMap(([paperId, note], index) =>
      (note.citablePoints || []).slice(0, 3).map((claim, claimIndex) => `| C${index + 1}.${claimIndex + 1} | ${claim.replace(/\|/g, '\\|')} | ${paperId} | 文献笔记 | 中 | 待与实验结果交叉核验 | VERIFIED-SOURCE |`)
    );
    const matrix = ['# Claim-Evidence Matrix', '', '| ID | 核心主张 | 证据来源 | 数据/结果位置 | 证据强度 | 冲突或缺口 | 状态 |', '|---|---|---|---|---|---|---|', ...evidenceRows].join('\n');
    await writeFile(this.outputPath('claim-evidence-matrix.md'), `${matrix}\n`, 'utf8');
  }

  // ===== 研究方案冻结 =====
  private async stageProtocolDesign(): Promise<void> {
    const protocol = integratedProtocol(this.state) || join(this.milestoneDir, 'analysis-plan.md');
    if (existsSync(protocol)) {
      console.log(`保留已冻结方案: ${protocol}`);
      await this.runPlannedExperiments('pilot');
      return;
    }
    const route = getRoute('protocol');
    console.log(`正在设计可执行实验方案... [模型] ${route.provider.toUpperCase()} / ${route.model}`);
    const result = await createResearchProtocol(this.state.topic, this.state.papers, this.state.notes, this.researchInstructions(), this.milestoneDir);
    if (!result.success || !result.data) throw new Error(result.error || '实验设计没有返回结果');
    console.log(`冻结方案: ${result.data}`);
    await this.runPlannedExperiments('pilot');
  }

  // ===== 阶段 4: 大纲生成 =====
  private async stageOutlineGeneration(): Promise<void> {
    if ((this.state as LiteratureRevisionState).literatureRevision && this.state.outline) {
      console.log('[DSH targeted repair] Existing approved outline retained.');
      return;
    }
    const route = getRoute('outline');
    console.log('正在生成论文大纲...');
    console.log(`[模型] ${route.provider.toUpperCase()} / ${route.model}`);

    const result = await generateOutline(this.state.topic, this.state.papers, this.state.notes, {
      targetWords: this.journalProfile?.targetWords || 8000,
      language: this.journalProfile ? 'en' : 'zh',
      responseFile: join(this.stateDir, 'outline-response.json'),
      journalInstructions: [this.researchInstructions(), await this.loadValidatedResultEvidence(),
        'Use the actual accepted results, including negative or null findings. Distribute at least 15 distinct, directly relevant research sources across the substantive literature-supported sections. Manuals and software docs do not count. Do not change the frozen experiment, retrofit hypotheses or inflate novelty.'].filter(Boolean).join('\n\n'),
    });

    if (!result.success || !result.data) {
      throw new Error(`大纲生成失败: ${result.error}`);
    }

    this.state.outline = result.data;
    const blueprintPath = join(this.milestoneDir, 'argument-blueprint.md');
    const previousBlueprint = existsSync(blueprintPath) ? readFileSync(blueprintPath, 'utf8') : '';
    await writeFile(blueprintPath, renderArgumentBlueprint(this.state.topic, result.data, previousBlueprint), 'utf8');
    console.log(`大纲生成完成，共 ${result.data.nodes.length} 个一级节点`);
  }

  // ===== 阶段 5: 逐段写作 =====
  private async stageSectionWriting(label: string, includeUnmatched = false): Promise<void> {
    if ((this.state as LiteratureRevisionState).literatureRevision) {
      if (this.state.stage === 'introduction-writing') {
        let literaturePending = true;
        while (literaturePending) {
          try {
            await runLiteratureRevision(this.state, {
              instructions: await this.scientificReviewInstructions(), evidence: await this.loadValidatedResultEvidence(), save: () => this.saveState() });
            literaturePending = false;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            assertRecoverableContentFailure(message);
            const outcome = this.state.metadata.pendingQuestion?.id === 'literature-revision' ? this.askPending('literature-revision', `${message}。不合格段落没有写入。`, [
              { id: 'continue-marked', label: '保留标记，继续后面的写作' },
              { id: 'retry', label: '再试一次这一步' },
            ]) : 'continue-marked';
            if (outcome === 'retry') continue;
            if (outcome !== 'continue-marked') return;
            await this.recordDraftMarker(`文献补写未完成，正文未插入不合格段落：${message}`);
            literaturePending = false;
          }
        }
      }
      return;
    }
    if (!this.state.outline) {
      throw new Error('大纲不存在，无法开始写作');
    }

    const route = getRoute('writing');
    console.log(`[模型] ${route.provider.toUpperCase()} / ${route.model}`);

    const evidenceContext = await this.loadValidatedResultEvidence();
    // 只写三级节点（叶子节点）
    const tasks = writingTasks(this.state.outline.nodes);
    const allLeafNodes = tasks.filter((task) => includeUnmatched || task.stage === this.state.stage).map((task) => task.node);
    const leafNodes = allLeafNodes.filter((node) => {
      if (this.state.sections.some((section) => section.nodeId === node.id && section.status === 'completed')) return false;
      return true;
    });

    console.log(`开始撰写${label}，共 ${leafNodes.length} 个小节；每完成一段立即保存`);

    for (let i = 0; i < leafNodes.length; i++) {
      const node = leafNodes[i];
      let section = this.state.sections.find((item) => item.nodeId === node.id);
      if (section?.status === 'completed') {
        console.log(`  [${i + 1}/${leafNodes.length}] 已保存，跳过: ${node.title}`);
        continue;
      }

      const language = this.journalProfile ? 'en' : 'zh';
      const paragraphPlan = createParagraphPlan(node.estimatedWords, language);
      if (!section) {
        section = {
          id: node.id,
          nodeId: node.id,
          title: node.title,
          content: '',
          citations: [],
          wordCount: 0,
          status: 'drafting',
          paragraphsCompleted: 0,
          paragraphsPlanned: paragraphPlan.total,
        };
        this.state.sections.push(section);
        this.saveState();
      }

      const completed = section.paragraphsCompleted ?? countSavedParagraphs(section.content);
      const total = section.paragraphsPlanned ?? paragraphPlan.total;
      section.paragraphsCompleted = completed;
      section.paragraphsPlanned = total;
      console.log(`  [${i + 1}/${leafNodes.length}] 撰写: ${node.title}（从第 ${completed + 1}/${total} 段继续）`);

      for (let paragraphIndex = completed + 1; paragraphIndex <= total; paragraphIndex++) {
        const previousSections = this.state.sections.filter((item) => item.nodeId !== node.id);
        const result = await writeSectionParagraph(node, {
          previousSections,
          currentSection: section.content,
          papers: this.state.papers,
          notes: this.state.notes,
          language,
          journalInstructions: this.researchInstructions(),
          evidenceContext,
          paragraphIndex,
          totalParagraphs: total,
          targetWords: paragraphPlan.wordsPerParagraph,
        });

        if (!result.success || !result.data) {
          assertRecoverableContentFailure(result.error || 'No body prose returned');
          this.saveState();
          const questionId = `paragraph:${node.id}:${paragraphIndex}`;
          const outcome = this.state.metadata.pendingQuestion?.id === questionId ? this.askPending(questionId, `${node.title} 第 ${paragraphIndex}/${total} 段没有写成：${result.error || '没有返回正文'}。已保存的段落保持不变，失败说明不会写进正文。`, [
            { id: 'skip-marked', label: '跳过这一段，留下标记，继续写下一段' },
            { id: 'retry', label: '停在这里，处理后再试这一段' },
          ]) : 'skip-marked';
          if (outcome === 'retry') {
            paragraphIndex -= 1;
            continue;
          }
          if (outcome !== 'skip-marked') return;
          await this.recordDraftMarker(`${node.title} 第 ${paragraphIndex}/${total} 段未写成，已跳过：${result.error || '没有返回正文'}`);
          section.paragraphsCompleted = paragraphIndex;
          section.status = paragraphIndex === total ? 'completed' : 'drafting';
          this.saveState();
          continue;
        }

        section.content = [section.content.trim(), result.data.content].filter(Boolean).join('\n\n');
        section.citations.push(...result.data.citations);
        section.wordCount += result.data.wordCount;
        section.paragraphsCompleted = paragraphIndex;
        section.status = paragraphIndex === total ? 'completed' : 'drafting';
        this.state.metadata.modelCalls++;
        this.saveState();
        console.log(`    [已保存] 第 ${paragraphIndex}/${total} 段 -> ${join(this.stateDir, STATE_FILE)}`);
      }

      // 每写完3节做一次连贯性检查
      const completedSections = this.state.sections.filter((item) => item.status === 'completed');
      if (completedSections.length % 3 === 0) {
        const coherenceRoute = getRoute('coherence');
        console.log(`  [连贯性检查] 模型: ${coherenceRoute.provider.toUpperCase()} / ${coherenceRoute.model}`);
        const coherence = await checkCoherence(completedSections);
        if (coherence.success && coherence.data && coherence.data.length > 0) {
          console.log(`  连贯性检查: 发现 ${coherence.data.length} 个问题`);
        }
      }
    }

    console.log(`写作完成，共 ${this.state.sections.length} 节`);
  }

  private async loadValidatedResultEvidence(): Promise<string> {
    assertPrimaryExperimentScope(this.outputDir, this.state.metadata.resultsFile);
    const resultsFile = this.state.metadata.resultsFile;
    if (!resultsFile || !existsSync(resolve(resultsFile))) throw new Error('缺少实验结果，禁止开始论文行文');
    const validationPath = join(this.milestoneDir, 'data-validation.json');
    if (!existsSync(validationPath)) throw new Error('缺少机器可读数据验收报告，禁止开始论文行文');
    const validation = JSON.parse(await readFile(validationPath, 'utf8')) as { status?: string; sha256?: string; empiricalManifestSha256?: string };
    const content = await readFile(resolve(resultsFile), 'utf8');
    const currentHash = createHash('sha256').update(content).digest('hex');
    if (validation.status !== 'PASS' || validation.sha256 !== currentHash) {
      throw new Error('实验结果在验收后发生变化或验收未通过；必须重新执行全部数据门禁后才能行文');
    }
    const manifestPath = join(this.milestoneDir, 'reproducibility', 'empirical-manifest.json');
    const manifestBytes = await readFile(manifestPath).catch(() => undefined);
    const manifestHash = manifestBytes ? createHash('sha256').update(manifestBytes).digest('hex') : undefined;
    if (manifestHash !== validation.empiricalManifestSha256 || (this.isEmpiricalProject() && !manifestHash)) {
      throw new Error('实证清单在数据验收后发生变化或缺失；必须重新执行数据验收后才能行文');
    }
    const empiricalChecks = await validateEmpiricalManifest(manifestPath, currentHash, this.isEmpiricalProject());
    if (empiricalChecks.some((check) => !check.passed)) {
      throw new Error(`实证证据在数据验收后发生变化：${empiricalChecks.filter((check) => !check.passed).map((check) => check.name).join(', ')}`);
    }
    const provenancePath = integratedEvidence(this.state, 'result-provenance.tsv') || join(this.milestoneDir, 'reproducibility', 'result-provenance.tsv');
    if (!existsSync(provenancePath)) throw new Error('缺少 result-provenance.tsv，禁止开始论文行文');
    const provenance = await readFile(provenancePath, 'utf8');
    const provenanceRows = provenance.split(/\r?\n/).slice(1).filter((line) => line.trim());
    if (provenanceRows.length === 0 || provenanceRows.some((line) => !/\tVERIFIED\s*$/i.test(line))) {
      throw new Error('结果溯源表为空或含非 VERIFIED 主张，禁止开始论文行文');
    }
    const structured = resultsFile.toLowerCase().endsWith('.json') ? JSON.parse(content) : undefined;
    if (isConditionalNetwork(structured)) {
      const evidence = conditionalNetworkEvidence(structured);
      if (evidence.length > 24000) throw new Error('结构化实验写作证据超过上下文预算；请生成可核验的精简汇总，禁止截断关键结果');
      return `Source: ${resolve(resultsFile)}\nResult SHA256: ${currentHash}\n${evidence}`;
    }
    const limit = 24000;
    const excerpt = content.length > limit ? `${content.slice(0, limit)}\n[TRUNCATED: do not infer omitted values]` : content;
    return `Source: ${resolve(resultsFile)}\n${excerpt}`;
  }

  // ===== 实验执行与数据验收 =====
  private async stageExperimentExecution(): Promise<void> {
    if (await this.runPlannedExperiments('formal')) return;
    const result = await runExperiment(this.state.metadata.experimentCommand || '', this.logsDir, this.state.metadata.resultsFile);
    if (!result.success || !result.data) throw new Error(result.error || '实验程序未成功完成');
    console.log(`实验日志: ${result.data}`);
  }

  /** Execute a project-owned pilot/batch plan without inventing commands or rerunning accepted work. */
  private async runPlannedExperiments(phase: 'pilot' | 'formal'): Promise<boolean> {
    const planFile = join(this.milestoneDir, 'experiment-plan.json');
    if (!existsSync(planFile)) return false;
    const plan = JSON.parse(await readFile(planFile, 'utf8')) as ExperimentPlan;
    if (phase === 'pilot' && plan.executionMode === 'provided-data') {
      console.log(`[已有数据] 已绑定 ${plan.sourceFiles?.length || 0} 个源文件并记录哈希；跳过实验 pilot，后续执行预先说明的分析批次。`);
    }
    const resolution = this.experimentResolution;
    const applicable = resolution && (phase === 'pilot' ? resolution.taskId === 'pilot' : resolution.taskId !== 'pilot');
    const paths = await runExperimentPlan({
      projectDir: this.outputDir, phase, planFile: 'milestones/experiment-plan.json',
      sharedDataRoot: this.sharedDataRoot, sharedDataScope: this.sharedDataScope,
      protocolFile: integratedProtocol(this.state) || 'milestones/analysis-plan.md',
      expectedResearchQuestion: this.loadSelectedTopic()?.researchQuestion,
      resultsFile: this.state.metadata.resultsFile,
      timeoutMs: Number(process.env.EXPERIMENT_TIMEOUT_MS || 300_000),
      authorResolution: applicable ? resolution : undefined,
      run: (command, outputDir, resultsFile, budget) => runExperiment(command, outputDir, resultsFile, budget),
      validate: ({ resultsFile, outputDir }) => validateExperimentResults(resultsFile, outputDir),
    });
    if (applicable) this.experimentResolution = undefined;
    if (phase === 'formal' && paths.length) {
      this.state.metadata.resultsFile = paths.at(-1);
      const checkpoint = JSON.parse(await readFile(join(this.stateDir, 'experiment-plan-state.json'), 'utf8')) as ExperimentPlanCheckpoint;
      const task = checkpoint.tasks[plan.batches.at(-1)!.id];
      if (!task?.logFile) throw new Error('Formal batch has no accepted execution log');
      await mkdir(this.logsDir, { recursive: true });
      await copyFile(task.logFile, join(this.logsDir, 'experiment-run.log'));
    }
    this.saveState();
    return true;
  }

  private async stageDataValidation(): Promise<void> {
    const result = await validateExperimentResults(this.state.metadata.resultsFile || '', this.milestoneDir, {
      analysisPlanFile: integratedProtocol(this.state) || join(this.milestoneDir, 'analysis-plan.md'),
      empiricalManifestFile: join(this.milestoneDir, 'reproducibility', 'empirical-manifest.json'),
      experimentLogFile: join(this.logsDir, 'experiment-run.log'),
      requireEmpiricalManifest: this.isEmpiricalProject(),
      reproductionCheckFile: integratedEvidence(this.state, 'reproduction-check.json') || join(this.milestoneDir, 'reproducibility', 'reproduction-check.json'),
      requireExecutionEvidence: true,
      statisticalAuditFile: integratedEvidence(this.state, 'statistical-audit.json') || join(this.milestoneDir, 'reproducibility', 'statistical-audit.json'),
    });
    if (!result.success || !result.data) throw new Error(result.error || '实验数据未通过验收');
    const resultsFile = this.state.metadata.resultsFile;
    if (resultsFile && existsSync(resolve(resultsFile))) {
      const outcome = await reconcileReproducibilityResult(this.outputDir, resultsFile, {
        sharedDataRoot: this.sharedDataRoot, sharedDataScope: this.sharedDataScope,
      });
      if (outcome === 'different-copy-retained') {
        console.warn('[artifact retention] Same-name result copy differed from the validated source; retained without overwrite.');
      } else if (outcome === 'different-copy-archived') {
        console.log('[artifact retention] Different prior result moved to reproducibility/results/superseded and hash recorded.');
      } else if (outcome === 'duplicate-removed') {
        console.log('[artifact retention] Removed byte-identical result copy; source path and SHA-256 recorded.');
      }
    }
    console.log(`数据验收: ${result.data}`);
  }

  // ===== 阶段 6: 引用核验 =====
  private async stageCitationVerification(): Promise<void> {
    if (!auditLiteratureCompleteness(this.state).passed && !(this.state as LiteratureRevisionState).literatureRevision) {
      requestLiteratureRevision(this.state, 'Citation-stage completeness check requires a separate result-directed literature preparation and targeted writing phase.');
      return;
    }
    await this.assertLiteratureComplete();
    const route = getRoute('citation');
    console.log('正在核验引用真实性...');
    console.log(`[模型] ${route.provider.toUpperCase()} / ${route.model}`);

    const cacheDir = join(this.stateDir, 'citation-recovery');
    let assessments = await verifyDraftCitations(this.state, join(cacheDir, 'verification'));
    if (assessments.some((assessment) => assessment.status !== 'verified')) {
      const repaired = await recoverDraftCitations(this.state,
        assessments.filter((assessment) => assessment.status !== 'verified'),
        { evidence: await this.loadValidatedResultEvidence(), cacheDir: join(cacheDir, 'paragraphs') },
        () => this.saveState());
      if (repaired > 0) assessments = await verifyDraftCitations(this.state, join(cacheDir, 'verification'));
    }
    const result = { data: assessments };

    const verified = result.data.filter((r) => r.status === 'verified').length;
    const problems = result.data.filter((r) => r.status !== 'verified').length;

    console.log(`引用核验完成: ${verified} 条通过，${problems} 条有问题`);

    // 保存核验报告
    const recencyAudit = this.citationRecencyAudit();
    const report = `${generateVerificationReport(result.data)}\n${recencyAudit.report}`;
    await this.ensureProjectDirs();
    await writeFile(this.outputPath('citation-verification-report.md'), report, 'utf-8');

    if (problems > 0) await this.recordDraftMarker(`引用核验有 ${problems} 条未通过；见 citation-verification-report.md`);
    await this.assertLiteratureComplete();
  }

  private citationRecencyAudit(): { passed: boolean; report: string } {
    return { passed: auditLiteratureCompleteness(this.state).passed, report: formatLiteratureCompleteness(this.state) };
  }

  /** Keep a visible delivery mark without freezing the draft. */
  private async recordDraftMarker(message: string): Promise<void> {
    if (!message.startsWith('[')) message = `[${this.state.stage}] ${message}`;
    const markers = this.state.metadata.draftMarkers || [];
    if (!markers.includes(message)) markers.push(message);
    this.state.metadata.draftMarkers = markers;
    if (!['project-intake', 'topic-discovery', 'topic-confirmation', 'protocol-design', 'experiment-execution', 'data-validation', 'submission-readiness'].includes(this.state.stage)) {
      finishTask(this.state, this.state.stage, 'degraded', message);
    }
    this.saveState();
    await this.ensureProjectDirs();
    await writeFile(this.outputPath('draft-markers.md'), [
      '# Draft markers',
      '',
      'These items stay with the draft. Writing continues. None of them clears the delivery gate or marks the manuscript submission-ready.',
      '',
      ...markers.map((item) => `- ${item}`),
      '',
    ].join('\n'), 'utf8');
    console.log(`[draft marker] ${message}`);
  }

  /** Enforce completeness separately from attribution and scientific validity. */
  private async assertLiteratureComplete(): Promise<boolean> {
    await this.ensureProjectDirs();
    await writeFile(this.outputPath('literature-completeness-report.md'), formatLiteratureCompleteness(this.state), 'utf8');
    if (!auditLiteratureCompleteness(this.state).passed) {
      await this.recordDraftMarker(`Literature completeness is not met; see ${this.outputPath('literature-completeness-report.md')}`);
      return false;
    }
    return true;
  }

  // ===== 阶段 7: 润色降重 =====
  private async stagePolishing(): Promise<void> {
    if ((this.state as LiteratureRevisionState).literatureRevision?.status === 'completed') {
      console.log('[DSH literature repair] Targeted prose is ready for verification; no whole-manuscript rewriting.');
      await writeFile(this.outputPath('academic-style-audit.md'),
        formatAcademicStyleReport(this.state.sections, 'Targeted literature repair; audit only, no rewriting'), 'utf8');
      return;
    }
    const route = getRoute('polish');
    console.log('正在进行重复率检测...');
    console.log(`[模型] ${route.provider.toUpperCase()} / ${route.model}`);

    // 用文献摘要作为参考文本做基础重复率检测
    const referenceTexts = this.state.papers.slice(0, 20).map((p) => ({
      title: p.title,
      text: p.abstract,
    }));

    const result = await checkPlagiarism(this.state.sections, referenceTexts);
    if (result.success && result.data) {
      console.log(`重复率: ${result.data.duplicateRate}%（基础检测，仅供参考）`);
    }

    // 自动润色所有章节（使用 gpt-5.6-luna）
    if (this.state.sections.length > 0) {
      console.log('\n开始自动润色...');
      await polishWithCheckpoints(this.state.sections, async (section) => {
        const polished = await polishSection(section.id, section.title, section.content, this.state.topic, this.researchInstructions());
        return { content: polished.polishedContent, integrityIssues: polished.integrityIssues };
      }, () => this.saveState());

      console.log('自动润色完成');
    } else {
      console.log('没有可润色的章节');
    }
    await writeFile(this.outputPath('academic-style-audit.md'),
      formatAcademicStyleReport(this.state.sections, 'Checkpointed conservative polish; cached sections retained'), 'utf8');
  }

  // ===== 阶段 8: 投稿质量门禁 =====
  private async stageQualityValidation(): Promise<void> {
    assertLiteratureRevisionIntegrity(this.state);
    await this.assertLiteratureComplete();
    await this.ensureProjectDirs();
    const reviewInstructions = await this.scientificReviewInstructions();
    this.assertReviewContext(reviewInstructions);
    const feedbackContextHash = createHash('sha256').update(reviewInstructions).digest('hex');
    const evidenceOnly = Boolean((this.state as PipelineState & { deliveryEvidencePrepared?: unknown }).deliveryEvidencePrepared)
      || (this.state as LiteratureRevisionState).literatureRevision?.status === 'completed';
    console.log(evidenceOnly ? '正在执行终稿结构检查与科学复审；不触发整篇改稿。' : '正在执行确定性结构检查与两轮跨模型评审改稿...');
    const rounds = evidenceOnly || finalReviewFeedbackStarted(this.state, feedbackContextHash) ? [] : await runQualityReviewRounds(this.state, {
      contextHash: createHash('sha256').update(JSON.stringify({ reviewInstructions,
        primary: getRoute('quality'), secondary: getRoute('qualityCrossReview') })).digest('hex'),
      review: (task) => reviewWithAdjudication(this.state.sections, reviewInstructions, task, join(this.stateDir, 'scientific-review-responses')),
      revise: (reviews, save) => reviseSectionsFromReviews(this.state.sections, reviews, reviewInstructions, save),
      save: () => this.saveState(),
    });
    for (const result of rounds) {
      await writeFile(this.outputPath(`scientific-review-round-${result.round}.md`), formatCrossReviewRounds([result]), 'utf-8');
    }

    const scientific = evidenceOnly
      ? await reviewWithAdjudication(this.state.sections, reviewInstructions, 'quality', join(this.stateDir, 'scientific-review-responses'))
      : await runFinalReviewFeedback(this.state, {
      contextHash: feedbackContextHash,
      review: () => reviewWithAdjudication(this.state.sections, reviewInstructions, 'quality', join(this.stateDir, 'scientific-review-responses')),
      revise: (review, save) => reviseSectionsFromReviews(this.state.sections, [review], reviewInstructions, save),
      save: () => this.saveState(),
    });
    if (!scientific.success || !scientific.data) throw new Error(scientific.error || '独立科技审查没有返回结果');
    const markdown = buildSectionsMarkdown(outlineSections(this.state.sections, this.state.outline));
    const deterministic = validateMarkdownPaper(markdown, { requireReferences: false, requireEmbeddedAssets: false });
    await writeFile(this.outputPath('paper-quality-report.md'), formatPaperQualityReport('Pre-export Paper Quality Gate', deterministic), 'utf-8');
    await writeFile(this.outputPath('scientific-review.md'), formatScientificReview(scientific.data), 'utf-8');
    if (rounds.length) await writeFile(this.outputPath('cross-model-review-report.md'), formatCrossReviewRounds(rounds), 'utf-8');
    if (!deterministic.passed || manuscriptReviewBlocked(scientific.data)) {
      await this.recordDraftMarker(`论文质量门禁未通过；见 ${this.outputPath('paper-quality-report.md')} 和 ${this.outputPath('scientific-review.md')}`);
    }
  }

  // ===== 阶段 9: 格式排版 =====
  private async stageFormatting(): Promise<void> {
    await this.refreshFinalCitationEvidence();
    console.log('格式排版：统一标题层级、引用格式、图表编号');
    // 格式调整主要在导出阶段处理
    // 这里可以添加统一的格式检查
  }

  // ===== 投稿包门禁 =====
  private async stageSubmissionReadiness(): Promise<void> {
    await this.ensureSubmissionDocuments();

    // Core required documents (must exist)
    const coreRequired = [
      this.outputPath('data-validation.md'),
      this.outputPath('citation-verification-report.md'),
      this.outputPath('paper-quality-report.md'),
      this.outputPath('scientific-review.md'),
      this.outputPath('docx-quality-report.md'),
      this.outputPath('final-citation-verification-report.md'),
      this.outputPath('final-scientific-review.md'),
    ];

    // Optional documents (checked but not blocking)
    const optional = [
      this.outputPath('research-brief.md'),
      this.outputPath('topic-discovery.md'),
      this.outputPath('analysis-plan.md'),
      this.outputPath('final-citation-verification-report.md'),
      this.outputPath('research-integrity.md'),
      this.outputPath('cover-letter.md'),
    ];

    const missingCore = coreRequired.filter((path) => !existsSync(path));
    const missingOptional = optional.filter((path) => !existsSync(path));

    const openFeedback = readFeedback(this.outputDir).filter((item) => item.status === 'open');
    const literature = auditLiteratureCompleteness(this.state);
    const reportText = (name: string) => existsSync(this.outputPath(name)) ? readFileSync(this.outputPath(name), 'utf8') : '';
    const gates = deliveryGateStatuses({ data: reportText('data-validation.md'), citations: reportText('citation-verification-report.md'),
      quality: reportText('paper-quality-report.md'), scientific: reportText('scientific-review.md'), docx: reportText('docx-quality-report.md'),
      finalCitations: reportText('final-citation-verification-report.md'), finalScientific: reportText('final-scientific-review.md') });
    const deliveryBlocked = missingCore.length > 0 || openFeedback.length > 0
      || (this.state.metadata.draftMarkers?.length || 0) > 0 || !literature.passed || Object.values(gates).some((passed) => !passed);

    const checklist = `# Submission Readiness

## Core Quality Gates
- [${gates.data ? 'x' : ' '}] 实验数据验收
- [${gates.citations && gates.finalCitations ? 'x' : ' '}] 引用核验
- [${gates.scientific && gates.finalScientific ? 'x' : ' '}] 独立科技质量审查
- [${gates.docx && gates.quality ? 'x' : ' '}] DOCX 导出质量检查
- [${openFeedback.length ? ' ' : 'x'}] 研究者异议已处理（待处理 ${openFeedback.length} 项）

## Optional Documentation
- [${missingOptional.includes(this.outputPath('research-brief.md')) ? ' ' : 'x'}] 研究简介
- [${missingOptional.includes(this.outputPath('topic-discovery.md')) ? ' ' : 'x'}] 选题发现记录
- [${missingOptional.includes(this.outputPath('research-integrity.md')) ? ' ' : 'x'}] 研究诚信声明模板
- [${missingOptional.includes(this.outputPath('cover-letter.md')) ? ' ' : 'x'}] Cover letter 模板

## Author Actions Required
- [ ] 作者逐项确认声明、作者顺序、基金、伦理、利益冲突
- [ ] 核对目标期刊当天要求

Status: ${deliveryBlocked ? 'BLOCKED' : 'READY FOR AUTHOR CONFIRMATION'}
`;

    const pendingReview = ['scientific-review.md', 'final-scientific-review.md'].flatMap((name) => {
      const path = this.outputPath(name);
      return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line.includes('[SUBMISSION]')) : [];
    });

    await writeFile(this.outputPath('submission-manifest.md'), checklist
      + `\n## Literature Completeness\n\nStatus: ${literature.passed ? 'PASS' : 'BLOCKED'}\n${literature.issues.map((issue) => `- ${issue}`).join('\n')}\n`
      + (pendingReview.length ? `\n## Unresolved Submission Requirements\n\n${pendingReview.join('\n')}\n\nSubmission status: BLOCKED\n` : ''), 'utf8');

    if (missingCore.length > 0 && !this.state.metadata.draftMarkers?.length) throw new Error(`投稿前仍缺少产物: ${missingCore.join(', ')}`);
    if (openFeedback.length > 0) throw new Error(`投稿前仍有 ${openFeedback.length} 项研究者异议未处理；查看 ${join(this.milestoneDir, 'research-feedback.jsonl')}`);
    await this.assertLiteratureComplete();
    if (deliveryBlocked) {
      this.state.metadata.awaitingApproval = 'submission-readiness';
      console.log('草稿文件已保留；真实门禁尚未全部通过，投稿清单为 BLOCKED，等待定点修复或作者输入。');
      return;
    }
    if ((this.state.metadata.draftMarkers?.length || 0) > 0) {
      this.state.metadata.awaitingApproval = 'submission-readiness';
      console.log('本地稿已保留；交付状态为 BLOCKED，不是投稿就绪。查看 draft-markers.md 和 submission-manifest.md。');
      return;
    }

    if (pendingReview.length) {
      this.state.metadata.awaitingApproval = 'submission-readiness';
      console.log('稿件已完成本地交付；投稿要求待作者处理，查看 submission-manifest.md。');
      return;
    }

    if (missingOptional.length > 0) {
      console.log(`[info] 可选文档缺失 ${missingOptional.length} 项，不阻断流程。详见 submission-manifest.md`);
    }

    if (!this.onApproval) this.state.metadata.awaitingApproval = 'submission-readiness';
    console.log('投稿清单已生成；作者声明和实时期刊要求仍需人工确认。');
  }

  private async ensureSubmissionDocuments(): Promise<void> {
    await this.ensureProjectDirs();
    const selected = this.loadSelectedTopic();
    const integrityPath = this.outputPath('research-integrity.md');
    if (!existsSync(integrityPath)) {
      await writeFile(integrityPath, buildResearchIntegrityTemplate({
        topic: this.state.topic,
        journalName: this.journalProfile?.name,
        selected,
        resultsFile: this.state.metadata.resultsFile,
      }), 'utf8');
    }
    const coverPath = this.outputPath('cover-letter.md');
    if (!existsSync(coverPath)) {
      await writeFile(coverPath, buildCoverLetterTemplate({
        topic: this.state.topic,
        journalName: this.journalProfile?.name,
        selected,
      }), 'utf8');
    }
  }

  // ===== 阶段 10: 输出交付 =====
  private async stageExport(): Promise<void> {
    console.log('正在导出论文...');
    try { await this.refreshFinalCitationEvidence(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assertRecoverableContentFailure(message);
      await this.recordDraftMarker(`Final citation check incomplete; unvalidated draft only: ${message}`);
    }

    const title = this.state.metadata.draftMarkers?.length ? `UNVALIDATED DRAFT - ${this.state.topic}` : this.state.topic;
    const exportSections = outlineSections(this.state.sections, this.state.outline);
    const authorBlock = this.manuscriptAuthorBlock();

    // 导出 Word
    const docxResult = await exportToDocx(exportSections, this.state.papers, {
      title,
      authorBlock,
      outputDir: this.finalDir,
      projectDir: this.outputDir,
      citationStyle: 'GB-T-7714',
    });

    if (!docxResult.success || !docxResult.data) throw new Error(docxResult.error || 'Word 导出失败');
    const exportedMarkdownPath = docxResult.data.filePath.replace(/\.docx$/i, '.md');
    const exportedMarkdown = await readFile(exportedMarkdownPath, 'utf-8');
    const exportedSourceReport = validateMarkdownPaper(exportedMarkdown);
    const docxQuality = await validateDocxFile(docxResult.data.filePath, exportedSourceReport.metrics);
    await writeFile(this.outputPath('docx-quality-report.md'), formatPaperQualityReport('DOCX Quality Gate', docxQuality), 'utf-8');
    if (!docxQuality.passed) await this.recordDraftMarker(`Word 导出后质量门禁未通过；见 ${this.outputPath('docx-quality-report.md')}`);
    let finalReview: Awaited<ReturnType<typeof reviewWithAdjudication>>;
    try {
      const instructions = await this.scientificReviewInstructions();
      this.assertReviewContext(instructions);
      finalReview = await reviewWithAdjudication(markdownToReviewSections(exportedMarkdown), instructions, 'quality', join(this.stateDir, 'scientific-review-responses'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assertRecoverableContentFailure(message);
      finalReview = { success: false, error: message };
    }
    if (!finalReview.success || !finalReview.data) {
      assertRecoverableContentFailure(finalReview.error || 'Final scientific review unavailable');
      await this.recordDraftMarker(`Final scientific review unavailable; draft only: ${finalReview.error || 'No result'}`);
    } else await writeFile(this.outputPath('final-scientific-review.md'), formatScientificReview(finalReview.data), 'utf-8');
    const finalBlocked = !finalReview.data || manuscriptReviewBlocked(finalReview.data);
    if (finalBlocked) await this.recordDraftMarker(`最终稿外审未通过；见 ${this.outputPath('final-scientific-review.md')}`);
    console.log(`Word 文档: ${docxResult.data.filePath} (${docxResult.data.format})`);

    // 导出 LaTeX
    const latexResult = await exportToLatex(exportSections, this.state.papers, {
      title,
      authorBlock,
      outputDir: this.finalDir,
      template: 'ctex',
    });

    if (latexResult.success && latexResult.data) {
      console.log(`LaTeX 源文件: ${latexResult.data.texPath}`);
      console.log(`BibTeX: ${latexResult.data.bibPath}`);
    } else throw new Error(latexResult.error || 'LaTeX 导出失败');

    // 保存完整 Markdown
    const mdContent = [authorBlock, buildSectionsMarkdown(exportSections)].filter(Boolean).join('\n\n');
    await writeFile(this.outputPath('paper-full.md'), mdContent, 'utf-8');
    console.log(`完整 Markdown: ${this.outputPath('paper-full.md')}`);
  }

  private async refreshFinalCitationEvidence(): Promise<void> {
    this.state.sections = refreshCitationContexts(this.state.sections);
    this.saveState();
    const result = { data: await verifyDraftCitations(this.state, join(this.stateDir, 'citation-recovery', 'verification')) };
    const problems = result.data.filter((item) => item.status !== 'verified');
    const recencyAudit = this.citationRecencyAudit();
    const report = [
      generateVerificationReport(result.data),
      recencyAudit.report,
      '## Final Draft Citation Binding',
      '',
      `- Status: ${problems.length === 0 ? 'PASS' : 'BLOCKED'}`,
      '- Scope: exported manuscript after polishing and cross-model revision.',
      '',
    ].join('\n');
    await writeFile(this.outputPath('final-citation-verification-report.md'), report, 'utf-8');
    if (problems.length > 0) {
      await this.recordDraftMarker(`终稿引用核验未通过；见 ${this.outputPath('final-citation-verification-report.md')}`);
    }
    await this.assertLiteratureComplete();
  }

  /** A workflow upgrade cannot silently reset a paid cross-review budget. */
  private assertReviewContext(instructions: string): void {
    const previous = (this.state as PipelineState & { qualityReviewProgress?: { contextHash?: string; rounds?: unknown[] } }).qualityReviewProgress;
    if (!previous?.rounds?.length || !previous.contextHash) return;
    const expected = createHash('sha256').update(JSON.stringify({ reviewInstructions: instructions,
      primary: getRoute('quality'), secondary: getRoute('qualityCrossReview') })).digest('hex');
    if (previous.contextHash !== expected) throw new Error('Review context changed; previous budget retained. Author approval is required for a new audit, not an automatic paid reset.');
  }

  // ===== 状态持久化 =====
  private saveState(): void {
    try {
      syncCanonicalDraft(this.state.sections);
      if (!existsSync(this.stateDir)) {
        mkdirSync(this.stateDir, { recursive: true });
      }
      // Map 转普通对象
      const serializable = {
        ...this.state,
        notes: Object.fromEntries(this.state.notes),
      };
      const statePath = join(this.stateDir, STATE_FILE);
      const temporaryStatePath = `${statePath}.tmp`;
      writeFileSync(temporaryStatePath, JSON.stringify(serializable, null, 2), 'utf-8');
      renameSync(temporaryStatePath, statePath);
    } catch (e) {
      console.error('状态保存失败:', e);
      throw e;
    }
  }

  private loadState(): PipelineState | null {
    try {
      const path = join(this.stateDir, STATE_FILE);
      if (!existsSync(path)) return null;
      const data = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(data);
      return {
        ...parsed,
        notes: new Map(Object.entries(parsed.notes || {})),
      };
    } catch (error) {
      throw new Error(`Cannot read existing paper checkpoint; retain it for recovery: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private outputPath(fileName: string): string {
    return join(this.projectSubdirFor(fileName) || this.workDir, fileName);
  }

  private projectSubdirFor(fileName: string): string | undefined {
    if (/^(paper-full|.*\.docx$|.*\.tex$|.*\.bib$)/i.test(fileName)) return this.finalDir;
    if (fileName === 'draft-markers.md') return this.milestoneDir;
    if (/(quality-report|scientific-review|cross-model-review|citation-verification|literature-completeness|submission-manifest|academic-style-audit)/i.test(fileName)) return this.reportsDir;
    if (/(experiment-run\.log)$/i.test(fileName)) return this.logsDir;
    if (/^(research-brief|revision-log|publication-record|topic-discovery|analysis-plan|data-validation|claim-evidence-matrix|research-integrity|cover-letter)\.md$/i.test(fileName)) return this.milestoneDir;
    if (/^(topic-discovery)\.json$/i.test(fileName)) return this.stateDir;
    return undefined;
  }

  private async ensureProjectDirs(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    await mkdir(this.milestoneDir, { recursive: true });
    await mkdir(this.runtimeDir, { recursive: true });
    await mkdir(this.workDir, { recursive: true });
    await mkdir(this.logsDir, { recursive: true });
    await mkdir(this.finalDir, { recursive: true });
    await mkdir(this.stateDir, { recursive: true });
    await this.organizeLegacyRootFiles();
  }

  private async cleanupRuntimeFiles(): Promise<void> {
    try {
      const inventory = await maintainPipelineArtifacts(this.outputDir);
      for (const warning of inventory.warnings) console.warn(`[artifact retention] ${warning}`);
    } catch (error) {
      console.warn('[artifact retention] Inventory unavailable; all files retained:', error);
    }
  }

  private async organizeLegacyRootFiles(): Promise<void> {
    const entries = await readdir(this.outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const source = join(this.outputDir, entry.name);
      const subdir = this.projectSubdirFor(entry.name);
      if (!subdir) continue;
      const target = join(subdir, entry.name);
      if (source === target || existsSync(target)) continue;
      await rename(source, target);
    }
  }

  /** 获取当前状态 */
  getState(): PipelineState {
    return this.state;
  }

  /** Title-page text from the workbench form. Blank forms add nothing. */
  private manuscriptAuthorBlock(): string {
    const path = join(this.stateDir, 'manuscript-authors.json');
    if (!existsSync(path)) return '';
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { authors?: unknown };
      return renderAuthorBlock(parsed.authors ?? parsed);
    } catch {
      return '';
    }
  }

  private async loadFullTexts(): Promise<Map<string, string>> {
    const fullTexts = new Map<string, string>();
    for (const paper of this.state.papers) {
      if (paper.fullTextPath && existsSync(paper.fullTextPath)) {
        fullTexts.set(paper.id, await readFile(paper.fullTextPath, 'utf-8'));
        continue;
      }

      if (paper.pdfPath && existsSync(paper.pdfPath)) {
        const parsed = await parseDocument(paper.pdfPath);
        if (parsed.success && parsed.data) {
          fullTexts.set(paper.id, parsed.data.text);
        }
      }
    }
    return fullTexts;
  }
}

function buildSectionsMarkdown(sections: Section[]): string {
  const source = renderCanonicalMarkdown(sections);
  if (source) return source;
  return sections.map((section) => `${'#'.repeat(Math.min(section.nodeId.split('.').length + 1, 4))} ${section.title}\n\n${section.content.trim()}`).join('\n\n');
}

function markdownToReviewSections(markdown: string): Section[] {
  const matches = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)];
  if (matches.length === 0) return [createReviewSection('Full Manuscript', markdown, 0)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return createReviewSection(match[1].trim(), markdown.slice(start, end).trim(), index);
  });
}

function createReviewSection(title: string, content: string, index: number): Section {
  return {
    id: `final-review-${index}`,
    nodeId: `final-review-${index}`,
    title,
    content,
    citations: [],
    wordCount: content.split(/\s+/).filter(Boolean).length,
    status: 'needs-review',
  };
}

export function refreshCitationContexts(sections: Section[]): Section[] {
  return sections.map((section) => {
    const refreshed = section.citations.map((citation) => {
      const sentence = findCitationSentence(section.content, citation.marker);
      if (!sentence) {
        throw new Error(`终稿章节「${section.title}」缺少引用标记 ${citation.marker}，不能导出投稿稿`);
      }
      return {
        ...citation,
        rawText: sentence,
        verified: false,
      };
    });
    const knownMarkers = new Set(refreshed.map((citation) => citation.marker));
    const unboundMarkers = [...section.content.matchAll(/\[(\d+)\]/g)]
      .map((match) => match[0])
      .filter((marker) => !knownMarkers.has(marker));
    if (unboundMarkers.length > 0) {
      throw new Error(`终稿章节「${section.title}」存在未绑定文献库的引用标记: ${[...new Set(unboundMarkers)].join(', ')}`);
    }
    return { ...section, citations: refreshed };
  });
}

function findCitationSentence(content: string, marker: string): string | undefined {
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const before = content.slice(0, markerIndex);
  const after = content.slice(markerIndex + marker.length);
  const start = Math.max(before.lastIndexOf('。'), before.lastIndexOf('.'), before.lastIndexOf('\n'));
  const endCandidates = ['。', '.', '\n']
    .map((token) => after.indexOf(token))
    .filter((index) => index >= 0);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) + markerIndex + marker.length + 1 : content.length;
  return content.slice(start + 1, end).trim();
}

function safeFileBase(name: string): string {
  return basename(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .slice(0, 120)
    .replace(/[. ]+$/, '') || 'paper';
}

function mergePapersById(papers: Paper[]): Paper[] {
  const merged = new Map<string, Paper>();
  for (const paper of papers) {
    if (!merged.has(paper.id)) merged.set(paper.id, paper);
  }
  return [...merged.values()];
}

function buildResearchIntegrityTemplate(options: {
  topic: string;
  journalName?: string;
  selected?: ResearchDirection;
  resultsFile?: string;
}): string {
  const transfer = options.selected?.transfer;
  return [
    '# Research Integrity and Author Declarations',
    '',
    `- Manuscript title: ${options.topic}`,
    `- Target journal: ${options.journalName || 'To be selected'}`,
    `- Results file checked by pipeline: ${options.resultsFile || 'AUTHOR MUST ADD'}`,
    '',
    '## Author Confirmation Required',
    '',
    '- [ ] Author names, order, affiliations, and corresponding author are correct.',
    '- [ ] Funding statement is complete, including grant numbers or "no external funding".',
    '- [ ] Ethics approval, consent, IRB/IACUC review, or exemption status is complete.',
    '- [ ] Conflicts of interest are disclosed or explicitly declared absent.',
    '- [ ] Data, code, and material availability statements match the actual repository or archive.',
    '- [ ] AI assistance was used only for drafting/checking and all scholarly claims were verified by the authors.',
    '- [ ] The target journal instructions were checked on the journal website on the submission date.',
    '',
    '## Pipeline Evidence',
    '',
    '- Topic discovery, bounded interdisciplinary transfer, protocol freeze, data validation, citation verification, two-round scientific review, and export quality reports are recorded in this project.',
    transfer ? `- Interdisciplinary boundary: ${transfer.homeDiscipline} uses ${transfer.borrowedMethod} from ${transfer.sourceDiscipline} only under these assumptions: ${transfer.assumptions.join('; ')}.` : '- Interdisciplinary boundary: see topic-discovery.md.',
    transfer ? `- Failure conditions that must remain visible in the manuscript: ${transfer.failureConditions.join('; ')}.` : '- Failure conditions: see topic-discovery.md.',
    '',
    'This file is a submission template, not an author-signed declaration. The manuscript must not be submitted until every checkbox above is completed by the authors.',
    '',
  ].join('\n');
}

function buildCoverLetterTemplate(options: {
  topic: string;
  journalName?: string;
  selected?: ResearchDirection;
}): string {
  return [
    '# Cover Letter Draft',
    '',
    'Dear Editor,',
    '',
    `Please consider our manuscript, "${options.topic}", for publication in ${options.journalName || '[TARGET JOURNAL]'}.`,
    '',
    options.selected
      ? `The study examines ${options.selected.researchQuestion}. Its contribution is framed as a bounded cross-disciplinary adaptation: ${options.selected.transfer.borrowedMethod} from ${options.selected.transfer.sourceDiscipline} is applied to ${options.selected.transfer.targetProblem} in ${options.selected.transfer.homeDiscipline}, with explicit assumptions, boundaries, baseline comparison, and falsification criteria.`
      : 'The study contribution, methods, and boundaries are documented in the project topic-discovery and analysis-plan files.',
    '',
    'The manuscript has passed the platform checks for protocol freeze, data validation, citation verification, independent scientific review, and export quality. All author declarations, ethics statements, funding details, competing interests, data/code availability, and journal-specific requirements must be reviewed and completed by the authors before submission.',
    '',
    'Sincerely,',
    '',
    '[AUTHOR NAMES AND AFFILIATIONS]',
    '',
  ].join('\n');
}

function createPaperOutputDir(topic: string, paperProjectId?: string): string {
  if (paperProjectId) {
    return join(paperOutputRoot(), 'papers', safeFileBase(paperProjectId));
  }
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const baseDir = join(paperOutputRoot(), 'papers', `${stamp}-${safeFileBase(topic)}`);
  if (!existsSync(baseDir)) return baseDir;
  for (let index = 2; index < 100; index++) {
    const candidate = `${baseDir}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${baseDir}-${Date.now()}`;
}

function normalizeOutputDir(outputDir: string): string {
  return outputDir.replace(/[\\/]+$/, '') || join(paperOutputRoot(), 'papers', 'paper');
}

function paperOutputRoot(): string {
  const dataRoot = process.env.PAPER_DATA_ROOT || join(process.env.USERPROFILE || homedir(), 'Documents', 'XiaoJiaAI Data');
  return resolve(dataRoot, process.env.OUTPUT_DIR || 'output');
}

function createParagraphPlan(
  estimatedWords: number,
  language: 'zh' | 'en'
): { total: number; wordsPerParagraph: number } {
  const preferredLength = language === 'en' ? 180 : 300;
  const total = Math.max(1, Math.ceil(Math.max(estimatedWords, 1) / preferredLength));
  return {
    total,
    wordsPerParagraph: Math.max(1, Math.ceil(estimatedWords / total)),
  };
}

function countSavedParagraphs(content: string): number {
  if (!content.trim()) return 0;
  return content.trim().split(/\n\s*\n/).filter(Boolean).length;
}

// ===== CLI 入口 =====
async function main() {
  const args = process.argv.slice(2);
  let topic = '';
  let inputDir: string | undefined;
  let journalId: string | undefined;
  let experimentCommand: string | undefined;
  let resultsFile: string | undefined;
  let outputDir: string | undefined;
  let paperProjectId: string | undefined;
  let revisionReference = '';
  let revisionProtocol = '';
  let revisionReason = '';
  const researchDirection: NonNullable<PipelineState['metadata']['researchDirection']> = {};
  let approvalMode: ApprovalMode = 'topic';
  let approvedStage: PipelineStage | undefined;
  let decision = '';
  let experimentResolution: ExperimentPlanOptions['authorResolution'];
  let billingRestored = false;
  let repairStage: PipelineStage | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input-dir' && args[i + 1]) {
      inputDir = args[i + 1];
      i++;
    } else if (args[i] === '--journal' && args[i + 1]) {
      journalId = args[i + 1];
      i++;
    } else if (args[i] === '--experiment-command' && args[i + 1]) {
      experimentCommand = args[++i];
    } else if (args[i] === '--results-file' && args[i + 1]) {
      resultsFile = args[++i];
    } else if (args[i] === '--experiment-resolution' && args[i + 1]) {
      experimentResolution = JSON.parse(args[++i]) as ExperimentPlanOptions['authorResolution'];
      if (!experimentResolution?.taskId || !['retry', 'validate', 'stop'].includes(experimentResolution.action)
        || !experimentResolution.reason?.trim()) throw new Error('Explicit experiment task, action and author reason are required');
    } else if (args[i] === '--billing-restored') {
      billingRestored = true;
    } else if (args[i] === '--repair-stage' && args[i + 1]) {
      repairStage = args[++i] as PipelineStage;
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i] === '--project-id' && args[i + 1]) {
      paperProjectId = args[++i];
    } else if (args[i] === '--experiment-revision-reference' && args[i + 1]) {
      revisionReference = args[++i];
    } else if (args[i] === '--experiment-revision-protocol' && args[i + 1]) {
      revisionProtocol = args[++i];
    } else if (args[i] === '--experiment-revision-reason' && args[i + 1]) {
      revisionReason = args[++i];
    } else if (args[i] === '--focus' && args[i + 1]) {
      researchDirection.focus = args[++i];
    } else if (args[i] === '--scope' && args[i + 1]) {
      researchDirection.scope = args[++i];
    } else if (args[i] === '--method' && args[i + 1]) {
      researchDirection.method = args[++i];
    } else if (args[i] === '--constraints' && args[i + 1]) {
      researchDirection.constraints = args[++i];
    } else if (args[i] === '--approval-mode' && args[i + 1]) {
      const mode = args[++i];
      if (mode !== 'auto' && mode !== 'topic' && mode !== 'all') throw new Error(`未知审批模式: ${mode}`);
      approvalMode = mode;
    } else if (args[i] === '--approved-stage' && args[i + 1]) {
      const stage = args[++i] as PipelineStage;
      if (!APPROVAL_STAGES.includes(stage)) throw new Error(`不能确认非审批阶段: ${stage}`);
      approvedStage = stage;
    } else if (args[i] === '--decision' && args[i + 1]) {
      decision = args[++i];
    } else if (!args[i].startsWith('--')) {
      topic = args[i];
    }
  }

  if (!topic) {
    console.error('用法: npm run paper -- "宽泛研究领域" [--focus "核心贡献"] [--scope "范围边界"] [--method "方法偏好"] [--constraints "数据约束"] [--journal "期刊ID"]');
    process.exit(1);
  }

  if (!outputDir && !paperProjectId) paperProjectId = `paper-${randomUUID()}`;

  // Load application options without shadowing credentials managed by Web settings.
  await import('../../scripts/project-env.mjs');

  const pipeline = new PaperPipeline(topic, async (stage, state) => {
    console.log(`\n[审批节点] 阶段: ${stage}`);
    console.log('当前进度摘要:');
    console.log(`  文献数: ${state.papers.length}`);
    console.log(`  已完成节数: ${state.sections.length}`);
    if (approvedStage === stage) {
      console.log(`  已收到用户确认: ${stage}`);
      return true;
    }
    if (stage === 'submission-readiness') {
      console.log('  投稿需要作者明确确认，不能自动批准');
      return false;
    }
    if (approvalMode === 'auto') {
      console.log('  自动通过审批');
      return true;
    }
    if (approvalMode === 'topic' && stage === 'topic-confirmation') {
      console.log(`  等待用户确认最终研究问题: ${state.topic}`);
      return false;
    }
    if (approvalMode === 'topic') {
      console.log('  自动通过审批');
      return true;
    }
    console.log(`  等待用户确认阶段产物: ${stage}`);
    return false;
  }, { inputDir, journalId, experimentCommand, resultsFile, outputDir, paperProjectId, researchDirection, decision, experimentResolution, billingRestored, repairStage });

  if (paperProjectId) console.log(`[论文项目ID] ${paperProjectId}`);

  if (revisionReference || revisionProtocol || revisionReason) {
    if (!revisionReference || !revisionProtocol || !revisionReason) throw new Error('实验接续需要同时提供已审计结果、冻结协议和修改理由');
    pipeline.integrateExperiment({ referenceResult: revisionReference, protocolFile: revisionProtocol, reason: revisionReason });
  }

  const finalState = await pipeline.run();
  if (finalState.metadata.awaitingApproval) process.exitCode = 3;
}

function migrateLegacyStage(stage: PipelineStage | 'section-writing'): PipelineStage {
  if (stage === 'section-writing') return 'introduction-writing';
  return stage;
}

// 直接运行时执行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
