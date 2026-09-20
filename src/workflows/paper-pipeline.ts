/**
 * 科技论文研究生命周期（20阶段）
 *
 * 阶段流程：
 * [1]选题确认 → [2]文献检索 → [3]文献精读 → [4]大纲生成 → [5]逐段写作
 *      ↓                                                      ↓
 * [10]输出交付 ← [9]格式排版 ← [8]质量门禁 ← [7]润色降重 ← [6]引用核验
 *
 * 特性：
 * - 断点续跑：每阶段完成后自动保存状态
 * - 人工审批：关键阶段暂停等待用户确认
 * - 错误重试：单阶段失败可重试，不影响已完成阶段
 */

import { writeFile, readFile, mkdir, readdir, rename, rm, copyFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, extname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createInitialState } from '../config/dsh.config.js';
import { literatureRecencyStats, MIN_RECENT_REFERENCE_SHARE, selectBalancedLiterature } from '../lib/literature-balance.js';
import { getRoute, printRoutingTable } from '../config/model-routing.js';
import { formatJournalInstructions, getJournalProfile, listJournalProfiles, type JournalProfile } from '../config/journal-profiles.js';
import type { PipelineState, PipelineStage, Paper, PaperNote, Outline, Section } from '../types.js';

import { arxivSearch } from '../plugins/literature/arxiv-search.js';
import { parseDocument } from '../plugins/literature/pdf-parser.js';
import { batchSummarizePapers } from '../plugins/literature/paper-summarizer.js';
import { createResearchProtocol, discoverResearchTopic, runExperiment, searchScholarlyWorks, validateExperimentResults } from '../plugins/research/research-lifecycle.js';
import { generateOutline, flattenOutline } from '../plugins/writing/outline-generator.js';
import { writeSectionParagraph } from '../plugins/writing/section-writer.js';
import { checkCoherence } from '../plugins/writing/coherence-checker.js';
import { polishAllSections } from '../plugins/writing/polish-editor.js';
import { verifyCitations, generateVerificationReport } from '../plugins/verification/citation-verifier.js';
import { checkPlagiarism } from '../plugins/verification/plagiarism-checker.js';
import { formatPaperQualityReport, validateDocxFile, validateMarkdownPaper } from '../plugins/verification/paper-quality-validator.js';
import { formatCrossReviewRounds, formatScientificReview, reviewScientificQuality, reviseSectionsFromReviews, type CrossReviewRound } from '../plugins/verification/scientific-quality-reviewer.js';
import { exportToDocx } from '../plugins/export/docx-exporter.js';
import { exportToLatex } from '../plugins/export/latex-exporter.js';

const STATE_FILE = 'paper-pipeline-state.json';

// 需要人工审批的阶段
const APPROVAL_STAGES: PipelineStage[] = ['topic-confirmation', 'protocol-design', 'outline-generation', 'submission-readiness'];
export const PIPELINE_STAGES: PipelineStage[] = [
  'project-intake',
  'topic-discovery',
  'topic-confirmation',
  'literature-search',
  'literature-review',
  'protocol-design',
  'outline-generation',
  'experiment-execution',
  'data-validation',
  'introduction-writing',
  'methods-writing',
  'results-writing',
  'discussion-writing',
  'manuscript-completion',
  'citation-verification',
  'polishing',
  'quality-validation',
  'formatting',
  'export',
  'submission-readiness',
];

interface PipelineOptions {
  inputDir?: string;
  journalId?: string;
  experimentCommand?: string;
  resultsFile?: string;
  outputDir?: string;
  paperProjectId?: string;
  researchDirection?: NonNullable<PipelineState['metadata']['researchDirection']>;
}

export class PaperPipeline {
  private state: PipelineState;
  private onApproval?: (stage: PipelineStage, state: PipelineState) => Promise<boolean>;
  private inputDir?: string;
  private journalProfile?: JournalProfile;
  private outputDir: string;
  private stateDir: string;
  private milestoneDir: string;
  private runtimeDir: string;
  private workDir: string;
  private reportsDir: string;
  private logsDir: string;
  private finalDir: string;
  private extractedTextDir: string;

  constructor(topic?: string, onApproval?: (stage: PipelineStage, state: PipelineState) => Promise<boolean>, options: PipelineOptions = {}) {
    this.onApproval = onApproval;
    this.inputDir = options.inputDir;
    this.outputDir = normalizeOutputDir(options.outputDir || process.env.PAPER_OUTPUT_DIR || createPaperOutputDir(topic || 'paper', options.paperProjectId));
    this.stateDir = join(this.outputDir, '.dsh-state');
    this.milestoneDir = join(this.outputDir, 'milestones');
    this.runtimeDir = join(this.stateDir, 'runtime');
    this.workDir = join(this.runtimeDir, 'work');
    this.reportsDir = this.milestoneDir;
    this.logsDir = join(this.runtimeDir, 'logs');
    this.finalDir = join(this.outputDir, 'final');
    this.extractedTextDir = join(this.workDir, 'extracted-texts');
    // 尝试从断点恢复
    const saved = this.loadState();
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
    this.state.metadata.paperProjectId = options.paperProjectId || this.state.metadata.paperProjectId;
    this.state.stage = migrateLegacyStage(this.state.stage);
  }

  private researchInstructions(): string {
    const direction = this.state.metadata.researchDirection;
    const controls = [
      direction?.focus && `Core focus and contribution: ${direction.focus}`,
      direction?.scope && `Scope and exclusions: ${direction.scope}`,
      direction?.method && `Method and experiment preference: ${direction.method}`,
      direction?.constraints && `Data and implementation constraints: ${direction.constraints}`,
    ].filter(Boolean);
    return [formatJournalInstructions(this.journalProfile), controls.length > 0 ? `Research direction controls:\n${controls.join('\n')}` : ''].filter(Boolean).join('\n\n');
  }

  private researchContext(): string {
    return [this.state.metadata.originalTopic || this.state.topic, this.researchInstructions()].filter(Boolean).join('\n\n');
  }

  /** 运行完整工作流 */
  async run(): Promise<PipelineState> {
    // 启动时打印模型路由表
    printRoutingTable();
    console.log(`[目标期刊] ${this.journalProfile?.name || '通用论文模式'}`);
    console.log(`[论文工作目录] ${this.outputDir}`);

    const stages = PIPELINE_STAGES;

    // 从当前阶段开始
    const startIndex = stages.indexOf(this.state.stage);

    for (let i = startIndex; i < stages.length; i++) {
      const stage = stages[i];
      this.state.stage = stage;
      this.state.metadata.currentStageStartTime = new Date().toISOString();

      console.log(`\n${'='.repeat(60)}`);
      console.log(`[阶段 ${i + 1}/${stages.length}] ${stage}`);
      console.log(`${'='.repeat(60)}`);

      // 审批节点
      if (APPROVAL_STAGES.includes(stage) && this.onApproval) {
        const approved = await this.onApproval(stage, this.state);
        if (!approved) {
          this.state.metadata.awaitingApproval = stage;
          console.log(`[等待确认] ${stage}`);
          this.saveState();
          return this.state;
        }
        delete this.state.metadata.awaitingApproval;
      }

      try {
        await this.executeStage(stage);
        this.saveState();
        console.log(`[完成] ${stage}`);
      } catch (error) {
        console.error(`[失败] ${stage}:`, error);
        this.saveState();
        throw error;
      }
    }

    await this.cleanupRuntimeFiles();
    console.log('\n研究、写作、质量与投稿前交付阶段全部完成。');
    return this.state;
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
        await this.stageSectionWriting('前言与相关工作', /introduction|background|related work|literature review|引言|前言|背景|相关工作|文献综述/i);
        break;
      case 'experiment-execution':
        await this.stageExperimentExecution();
        break;
      case 'data-validation':
        await this.stageDataValidation();
        break;
      case 'methods-writing':
        await this.stageSectionWriting('方法与实验设置', /method|methodology|materials|data|experimental setup|framework|algorithm|方法|材料|数据|实验设置|模型|算法/i);
        break;
      case 'results-writing':
        await this.stageSectionWriting('研究结果', /results?|findings?|evaluation|performance|结果|发现|评估|性能/i);
        break;
      case 'discussion-writing':
        await this.stageSectionWriting('讨论与局限', /discussion|implication|limitation|threat|讨论|启示|局限|威胁/i);
        break;
      case 'manuscript-completion':
        await this.stageSectionWriting('摘要、结论及其余章节', /.*/, true);
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
    console.log(`选题: ${this.state.topic}`);
    console.log('请确认选题是否合适（审批节点）');
    // 实际审批由 onApproval 回调处理
  }

  // ===== 阶段 2: 文献检索 =====
  private async stageLiteratureSearch(): Promise<void> {
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

      const papers: Paper[] = [];
      await mkdir(this.extractedTextDir, { recursive: true });
      for (const file of docFiles) {
        const docPath = join(this.inputDir, file);
        console.log(`解析: ${file}`);
        const result = await parseDocument(docPath);
        if (result.success && result.data) {
          const paperId = file.replace(/\.(pdf|docx|txt|md)$/i, '');
          const fullTextPath = join(this.extractedTextDir, `${safeFileBase(paperId)}.txt`);
          await writeFile(fullTextPath, result.data.text, 'utf-8');
          papers.push({
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
      this.state.papers = papers;
      console.log(`成功加载 ${papers.length} 篇本地文献`);
      return;
    }

    console.log('正在联网检索文献，并执行近五年文献配额...');

    // 从选题中提取关键词（简单实现：取前5个实词）
    const keywords = this.researchContext()
      .replace(/[的了是在和与及等]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 5)
      .join(' ');

    const scholarly = await searchScholarlyWorks(keywords, 45);
    const recentArxiv = await arxivSearch(keywords, { maxResults: 30, sortBy: 'submittedDate' });
    const candidates = [
      ...this.state.papers,
      ...scholarly,
      ...(recentArxiv.success && recentArxiv.data ? recentArxiv.data : []),
    ];
    this.state.papers = selectBalancedLiterature(candidates, 30);
    const recency = literatureRecencyStats(this.state.papers);
    if (recency.total === 0) throw new Error('联网文献检索没有返回可用结果');
    if (recency.share < MIN_RECENT_REFERENCE_SHARE) {
      throw new Error(`近五年文献仅 ${recency.recent}/${recency.total}，低于30%最低要求；需要扩展检索词后重试`);
    }
    await writeFile(join(this.milestoneDir, 'literature-recency-report.md'), [
      '# Literature Recency Report',
      '',
      '- Status: PASS',
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
    const route = getRoute('protocol');
    console.log(`正在设计可执行实验方案... [模型] ${route.provider.toUpperCase()} / ${route.model}`);
    const result = await createResearchProtocol(this.state.topic, this.state.papers, this.state.notes, this.researchInstructions(), this.milestoneDir);
    if (!result.success || !result.data) throw new Error(result.error || '实验设计没有返回结果');
    console.log(`冻结方案: ${result.data}`);
  }

  // ===== 阶段 4: 大纲生成 =====
  private async stageOutlineGeneration(): Promise<void> {
    const route = getRoute('outline');
    console.log('正在生成论文大纲...');
    console.log(`[模型] ${route.provider.toUpperCase()} / ${route.model}`);

    const result = await generateOutline(this.state.topic, this.state.papers, this.state.notes, {
      targetWords: this.journalProfile?.targetWords || 8000,
      language: this.journalProfile ? 'en' : 'zh',
      journalInstructions: this.researchInstructions(),
    });

    if (!result.success || !result.data) {
      throw new Error(`大纲生成失败: ${result.error}`);
    }

    this.state.outline = result.data;
    console.log(`大纲生成完成，共 ${result.data.nodes.length} 个一级节点`);
  }

  // ===== 阶段 5: 逐段写作 =====
  private async stageSectionWriting(label: string, matcher: RegExp, includeUnmatched = false): Promise<void> {
    if (!this.state.outline) {
      throw new Error('大纲不存在，无法开始写作');
    }

    const route = getRoute('writing');
    console.log(`[模型] ${route.provider.toUpperCase()} / ${route.model}`);

    const evidenceContext = await this.loadValidatedResultEvidence();
    const allNodes = flattenOutline(this.state.outline.nodes);
    // 只写三级节点（叶子节点）
    const allLeafNodes = allNodes.filter((n) => !n.children || n.children.length === 0);
    const leafNodes = allLeafNodes.filter((node) => {
      if (this.state.sections.some((section) => section.nodeId === node.id && section.status === 'completed')) return false;
      return includeUnmatched || matcher.test(node.title);
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
          this.saveState();
          throw new Error(`${node.title} 第 ${paragraphIndex}/${total} 段失败: ${result.error}`);
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
    const resultsFile = this.state.metadata.resultsFile;
    if (!resultsFile || !existsSync(resolve(resultsFile))) throw new Error('缺少实验结果，禁止开始论文行文');
    const validationPath = join(this.milestoneDir, 'data-validation.json');
    if (!existsSync(validationPath)) throw new Error('缺少机器可读数据验收报告，禁止开始论文行文');
    const validation = JSON.parse(await readFile(validationPath, 'utf8')) as { status?: string; sha256?: string };
    const content = await readFile(resolve(resultsFile), 'utf8');
    const currentHash = createHash('sha256').update(content).digest('hex');
    if (validation.status !== 'PASS' || validation.sha256 !== currentHash) {
      throw new Error('实验结果在验收后发生变化或验收未通过；必须重新执行全部数据门禁后才能行文');
    }
    const provenancePath = join(this.milestoneDir, 'reproducibility', 'result-provenance.tsv');
    if (!existsSync(provenancePath)) throw new Error('缺少 result-provenance.tsv，禁止开始论文行文');
    const provenance = await readFile(provenancePath, 'utf8');
    const provenanceRows = provenance.split(/\r?\n/).slice(1).filter((line) => line.trim());
    if (provenanceRows.length === 0 || provenanceRows.some((line) => !/\tVERIFIED\s*$/i.test(line))) {
      throw new Error('结果溯源表为空或含非 VERIFIED 主张，禁止开始论文行文');
    }
    const limit = 24000;
    const excerpt = content.length > limit ? `${content.slice(0, limit)}\n[TRUNCATED: do not infer omitted values]` : content;
    return `Source: ${resolve(resultsFile)}\n${excerpt}`;
  }

  // ===== 实验执行与数据验收 =====
  private async stageExperimentExecution(): Promise<void> {
    const result = await runExperiment(this.state.metadata.experimentCommand || '', this.logsDir, this.state.metadata.resultsFile);
    if (!result.success || !result.data) throw new Error(result.error || '实验程序未成功完成');
    console.log(`实验日志: ${result.data}`);
  }

  private async stageDataValidation(): Promise<void> {
    const result = await validateExperimentResults(this.state.metadata.resultsFile || '', this.milestoneDir, {
      analysisPlanFile: join(this.milestoneDir, 'analysis-plan.md'),
      experimentLogFile: join(this.logsDir, 'experiment-run.log'),
      reproductionCheckFile: join(this.milestoneDir, 'reproducibility', 'reproduction-check.json'),
      requireExecutionEvidence: true,
      statisticalAuditFile: join(this.milestoneDir, 'reproducibility', 'statistical-audit.json'),
    });
    if (!result.success || !result.data) throw new Error(result.error || '实验数据未通过验收');
    const resultsFile = this.state.metadata.resultsFile;
    if (resultsFile && existsSync(resolve(resultsFile))) {
      const resultsDir = join(this.milestoneDir, 'reproducibility', 'results');
      await mkdir(resultsDir, { recursive: true });
      await copyFile(resolve(resultsFile), join(resultsDir, safeFileBase(resultsFile)));
    }
    console.log(`数据验收: ${result.data}`);
  }

  // ===== 阶段 6: 引用核验 =====
  private async stageCitationVerification(): Promise<void> {
    const route = getRoute('citation');
    console.log('正在核验引用真实性...');
    console.log(`[模型] ${route.provider.toUpperCase()} / ${route.model}`);

    const result = await verifyCitations(this.state.sections, this.state.papers, this.state.notes);
    if (!result.success || !result.data) {
      throw new Error(`引用核验失败: ${result.error}`);
    }

    const verified = result.data.filter((r) => r.status === 'verified').length;
    const problems = result.data.filter((r) => r.status !== 'verified').length;

    console.log(`引用核验完成: ${verified} 条通过，${problems} 条有问题`);

    // 保存核验报告
    const recencyAudit = this.citationRecencyAudit();
    const report = `${generateVerificationReport(result.data)}\n${recencyAudit.report}`;
    await this.ensureProjectDirs();
    await writeFile(this.outputPath('citation-verification-report.md'), report, 'utf-8');

    if (problems > 0) {
      console.log(`⚠️  存在问题引用，请查看 ${this.outputPath('citation-verification-report.md')}`);
    }
    if (!recencyAudit.passed) {
      throw new Error(`引用时效性门禁未通过；近五年文献须不少于30%且不得集中在单一章节。查看 ${this.outputPath('citation-verification-report.md')}`);
    }
  }

  private citationRecencyAudit(): { passed: boolean; report: string } {
    const paperById = new Map(this.state.papers.map((paper) => [paper.id, paper]));
    const citedIds = new Set(this.state.sections.flatMap((section) => section.citations.map((citation) => citation.paperId)));
    const citedPapers = [...citedIds].map((id) => paperById.get(id)).filter(Boolean) as Paper[];
    const stats = literatureRecencyStats(citedPapers);
    const evidenceSections = this.state.sections.filter((section) => section.citations.length > 0);
    const sectionsWithRecent = evidenceSections.filter((section) => section.citations.some((citation) => {
      const paper = paperById.get(citation.paperId);
      return paper ? paper.year >= stats.cutoffYear && paper.year <= new Date().getFullYear() : false;
    })).length;
    const distributionRequired = evidenceSections.length < 3 ? evidenceSections.length : Math.ceil(evidenceSections.length * 0.5);
    const passed = stats.share >= MIN_RECENT_REFERENCE_SHARE && sectionsWithRecent >= distributionRequired;
    const report = [
      '## Literature Recency and Distribution Gate',
      '',
      `- Status: ${passed ? 'PASS' : 'BLOCKED'}`,
      `- Recent window: ${stats.cutoffYear}-${new Date().getFullYear()}`,
      `- Recent cited works: ${stats.recent}/${stats.total} (${(stats.share * 100).toFixed(1)}%)`,
      `- Evidence-bearing sections with recent support: ${sectionsWithRecent}/${evidenceSections.length}`,
      `- Required: at least 30% recent cited works and recent support in at least ${distributionRequired} evidence-bearing sections.`,
      '',
    ].join('\n');
    return { passed, report };
  }

  // ===== 阶段 7: 润色降重 =====
  private async stagePolishing(): Promise<void> {
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
      const sectionsForPolish = this.state.sections.map((s) => ({
        id: s.id,
        title: s.title,
        content: s.content,
      }));

      const polishedSections = await polishAllSections(
        sectionsForPolish,
        this.state.topic,
        this.researchInstructions()
      );

      // 更新 state 中的章节内容
      for (let i = 0; i < this.state.sections.length; i++) {
        const polished = polishedSections.find((p) => p.id === this.state.sections[i].id);
        if (polished) {
          this.state.sections[i].content = polished.content;
        }
      }

      console.log('自动润色完成');
    } else {
      console.log('没有可润色的章节');
    }
  }

  // ===== 阶段 8: 投稿质量门禁 =====
  private async stageQualityValidation(): Promise<void> {
    console.log('正在执行确定性结构检查与两轮跨模型评审改稿...');
    await this.ensureProjectDirs();
    const rounds: CrossReviewRound[] = [];

    for (let round = 1; round <= 2; round++) {
      console.log(`[交叉评审] 第 ${round}/2 轮：评审模型给出意见，写作模型据此改稿`);
      const primary = await reviewScientificQuality(this.state.sections, this.researchInstructions(), 'quality');
      if (!primary.success || !primary.data) throw new Error(primary.error || '第一评审模型没有返回结果');

      const secondary = await reviewScientificQuality(this.state.sections, this.researchInstructions(), 'qualityCrossReview');
      if (!secondary.success || !secondary.data) throw new Error(secondary.error || '第二评审模型没有返回结果');

      const revision = await reviseSectionsFromReviews(
        this.state.sections,
        [primary.data, secondary.data],
        this.researchInstructions()
      );
      if (!revision.success || !revision.data) throw new Error(revision.error || '写作模型未能根据评审意见完成改稿');

      this.state.sections = revision.data.sections;
      this.saveState();
      rounds.push({
        round,
        primary: primary.data,
        secondary: secondary.data,
        revisionSummary: revision.data.summary,
      });
      await writeFile(this.outputPath(`scientific-review-round-${round}.md`), formatCrossReviewRounds([rounds[rounds.length - 1]]), 'utf-8');
    }

    const markdown = buildSectionsMarkdown(this.state.sections);
    const deterministic = validateMarkdownPaper(markdown, { requireReferences: false, requireEmbeddedAssets: false });
    await writeFile(this.outputPath('paper-quality-report.md'), formatPaperQualityReport('Pre-export Paper Quality Gate', deterministic), 'utf-8');

    const scientific = await reviewScientificQuality(this.state.sections, this.researchInstructions(), 'quality');
    if (!scientific.success || !scientific.data) throw new Error(scientific.error || '独立科技审查没有返回结果');
    await writeFile(this.outputPath('scientific-review.md'), formatScientificReview(scientific.data), 'utf-8');
    await writeFile(this.outputPath('cross-model-review-report.md'), formatCrossReviewRounds(rounds), 'utf-8');
    const semanticBlocked = scientific.data.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'major');
    if (!deterministic.passed || semanticBlocked || scientific.data.verdict !== 'pass') {
      throw new Error(`论文质量门禁未通过；查看 ${this.outputPath('paper-quality-report.md')} 和 ${this.outputPath('scientific-review.md')}`);
    }
  }

  // ===== 阶段 9: 格式排版 =====
  private async stageFormatting(): Promise<void> {
    console.log('格式排版：统一标题层级、引用格式、图表编号');
    // 格式调整主要在导出阶段处理
    // 这里可以添加统一的格式检查
  }

  // ===== 投稿包门禁 =====
  private async stageSubmissionReadiness(): Promise<void> {
    const required = [
      this.outputPath('research-brief.md'),
      this.outputPath('topic-discovery.md'),
      this.outputPath('analysis-plan.md'),
      this.outputPath('data-validation.md'),
      this.outputPath('citation-verification-report.md'),
      this.outputPath('paper-quality-report.md'),
      this.outputPath('scientific-review.md'),
      this.outputPath('docx-quality-report.md'),
      this.outputPath('research-integrity.md'),
      this.outputPath('cover-letter.md'),
    ];
    const missing = required.filter((path) => !existsSync(path));
    const checklist = `# Submission Readiness\n\n- [x] 联网选题与方向证据\n- [x] 冻结研究方案\n- [x] 实验数据验收\n- [x] 引用核验\n- [x] 独立科技质量审查\n- [${missing.includes(this.outputPath('research-integrity.md')) ? ' ' : 'x'}] 作者、基金、伦理、利益冲突及 AI 使用声明\n- [${missing.includes(this.outputPath('cover-letter.md')) ? ' ' : 'x'}] Cover letter 与投稿材料\n- [ ] 期刊官网当天要求复核\n\nStatus: ${missing.length > 0 ? 'BLOCKED' : 'READY FOR AUTHOR CONFIRMATION'}\n`;
    await writeFile(this.outputPath('submission-manifest.md'), checklist, 'utf8');
    if (missing.length > 0) throw new Error(`投稿前仍缺少产物: ${missing.join(', ')}`);
    console.log('投稿清单已生成；作者声明和实时期刊要求仍需人工确认。');
  }

  // ===== 阶段 10: 输出交付 =====
  private async stageExport(): Promise<void> {
    console.log('正在导出论文...');

    const title = this.state.topic;

    // 导出 Word
    const docxResult = await exportToDocx(this.state.sections, this.state.papers, {
      title,
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
    if (!docxQuality.passed) throw new Error(`Word 导出后质量门禁未通过；查看 ${this.outputPath('docx-quality-report.md')}`);
    const finalReview = await reviewScientificQuality(markdownToReviewSections(exportedMarkdown), this.researchInstructions(), 'quality');
    if (!finalReview.success || !finalReview.data) throw new Error(finalReview.error || '最终稿外审没有返回结果');
    await writeFile(this.outputPath('final-scientific-review.md'), formatScientificReview(finalReview.data), 'utf-8');
    const finalBlocked = finalReview.data.verdict !== 'pass'
      || finalReview.data.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'major');
    if (finalBlocked) throw new Error(`最终稿外审未通过；查看 ${this.outputPath('final-scientific-review.md')}`);
    console.log(`Word 文档: ${docxResult.data.filePath} (${docxResult.data.format})`);

    // 导出 LaTeX
    const latexResult = await exportToLatex(this.state.sections, this.state.papers, {
      title,
      outputDir: this.finalDir,
      template: 'ctex',
    });

    if (latexResult.success && latexResult.data) {
      console.log(`LaTeX 源文件: ${latexResult.data.texPath}`);
      console.log(`BibTeX: ${latexResult.data.bibPath}`);
    } else throw new Error(latexResult.error || 'LaTeX 导出失败');

    // 保存完整 Markdown
    const mdContent = this.state.sections.map((s) => `## ${s.title}\n\n${s.content}`).join('\n\n');
    await writeFile(this.outputPath('paper-full.md'), mdContent, 'utf-8');
    console.log(`完整 Markdown: ${this.outputPath('paper-full.md')}`);
  }

  // ===== 状态持久化 =====
  private saveState(): void {
    try {
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
    } catch {
      return null;
    }
  }

  private outputPath(fileName: string): string {
    return join(this.projectSubdirFor(fileName) || this.workDir, fileName);
  }

  private projectSubdirFor(fileName: string): string | undefined {
    if (/^(paper-full|.*\.docx$|.*\.tex$|.*\.bib$)/i.test(fileName)) return this.finalDir;
    if (/(quality-report|scientific-review|cross-model-review|citation-verification|submission-manifest)/i.test(fileName)) return this.reportsDir;
    if (/(experiment-run\.log)$/i.test(fileName)) return this.logsDir;
    if (/^(research-brief|revision-log|publication-record|topic-discovery|analysis-plan|data-validation|claim-evidence-matrix)\.md$/i.test(fileName)) return this.milestoneDir;
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
    await rm(this.runtimeDir, { recursive: true, force: true });
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
  return sections.map((section) => `## ${section.title}\n\n${section.content.trim()}`).join('\n\n');
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

function safeFileBase(name: string): string {
  return basename(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .slice(0, 120)
    .replace(/[. ]+$/, '') || 'paper';
}

function createPaperOutputDir(topic: string, paperProjectId?: string): string {
  if (paperProjectId) {
    return join(paperOutputRoot(), 'paper-projects', safeFileBase(paperProjectId));
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
  const researchDirection: NonNullable<PipelineState['metadata']['researchDirection']> = {};
  let approvalMode: 'auto' | 'topic' = 'auto';

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
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i] === '--project-id' && args[i + 1]) {
      paperProjectId = args[++i];
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
      if (mode !== 'auto' && mode !== 'topic') throw new Error(`未知审批模式: ${mode}`);
      approvalMode = mode;
    } else if (!args[i].startsWith('--')) {
      topic = args[i];
    }
  }

  if (!topic) {
    console.error('用法: npm run paper -- "宽泛研究领域" [--focus "核心贡献"] [--scope "范围边界"] [--method "方法偏好"] [--constraints "数据约束"] [--journal "期刊ID"]');
    process.exit(1);
  }

  // 加载 .env
  try {
    const dotenv = await import('dotenv');
    dotenv.config();
  } catch {
    // dotenv 未安装时忽略
  }

  const pipeline = new PaperPipeline(topic, async (stage, state) => {
    console.log(`\n[审批节点] 阶段: ${stage}`);
    console.log('当前进度摘要:');
    console.log(`  文献数: ${state.papers.length}`);
    console.log(`  已完成节数: ${state.sections.length}`);
    if (approvalMode === 'topic' && stage === 'topic-confirmation') {
      console.log(`  等待用户确认最终研究问题: ${state.topic}`);
      return false;
    }
    console.log('  自动通过审批');
    return true;
  }, { inputDir, journalId, experimentCommand, resultsFile, outputDir, paperProjectId, researchDirection });

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
