/**
 * 论文 Agent 通用类型定义
 */

// ===== 文献相关 =====
export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number;
  abstract: string;
  url?: string;
  pdfPath?: string;
  fullTextPath?: string;
  citations?: number;
  source: 'arxiv' | 'cnki' | 'google-scholar' | 'manual';
  tags?: string[];
}

export interface PaperNote {
  paperId: string;
  researchQuestion: string;
  methodology: string;
  keyFindings: string;
  limitations: string;
  citablePoints: string[];
  summary: string;
}

// ===== 大纲相关 =====
export interface OutlineNode {
  id: string;
  level: 1 | 2 | 3;
  title: string;
  argument?: string;
  supportingPapers: string[]; // paper ids
  estimatedWords: number;
  children?: OutlineNode[];
}

export interface Outline {
  topic: string;
  nodes: OutlineNode[];
  totalEstimatedWords: number;
}

// ===== 写作相关 =====
export interface Section {
  id: string;
  nodeId: string;
  title: string;
  content: string;
  citations: Citation[];
  wordCount: number;
  status: 'pending' | 'drafting' | 'completed' | 'needs-review';
  paragraphsCompleted?: number;
  paragraphsPlanned?: number;
}

export interface Citation {
  paperId: string;
  marker: string; // e.g. "[1]" or "(Author, 2020)"
  page?: string;
  verified: boolean;
  rawText: string; // 正文中引用的原文片段
}

// ===== 工作流状态 =====
export type PipelineStage =
  | 'project-intake'
  | 'topic-discovery'
  | 'topic-confirmation'
  | 'literature-search'
  | 'literature-review'
  | 'protocol-design'
  | 'outline-generation'
  | 'introduction-writing'
  | 'experiment-execution'
  | 'data-validation'
  | 'methods-writing'
  | 'results-writing'
  | 'discussion-writing'
  | 'manuscript-completion'
  | 'citation-verification'
  | 'polishing'
  | 'quality-validation'
  | 'formatting'
  | 'submission-readiness'
  | 'export';

export interface PipelineState {
  topic: string;
  stage: PipelineStage;
  papers: Paper[];
  notes: Map<string, PaperNote>;
  outline?: Outline;
  sections: Section[];
  metadata: {
    startTime: string;
    currentStageStartTime: string;
    modelCalls: number;
    totalTokens: number;
    targetJournalId?: string;
    originalTopic?: string;
    experimentCommand?: string;
    resultsFile?: string;
    outputDir?: string;
    awaitingApproval?: PipelineStage;
    researchDirection?: {
      focus?: string;
      scope?: string;
      method?: string;
      constraints?: string;
    };
  };
}

// ===== 插件接口（适配 dsh 插件规范）=====
export interface PluginContext {
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  config: Record<string, unknown>;
  state: PipelineState;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
