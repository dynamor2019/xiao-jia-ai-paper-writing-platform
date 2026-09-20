/**
 * DeepSeek Harness 运行配置
 *
 * 注意：dsh 目前处于开发者预览版，具体配置字段可能随版本变化。
 * 以下配置基于 dsh v0.1.0-rc.x 的插件化架构设计。
 * 实际运行时请以 dsh 官方文档为准，必要时调整字段名。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PipelineState } from '../types.js';

const DEFAULT_DATA_ROOT = join(process.env.USERPROFILE || homedir(), 'Documents', 'XiaoJiaAI Data');

export const dshConfig = {
  // 服务端口（dsh 默认 3080，如需修改请用系统环境变量 DSH_PORT，不要放 .env）
  port: 3080,

  // 沙箱配置（论文写作需要文件读写，建议启用）
  sandbox: {
    enabled: true,
    // 允许访问的目录
    allowedPaths: [
      './knowledge-base',
      process.env.PAPER_DATA_ROOT || DEFAULT_DATA_ROOT,
      './temp',
    ],
    // 允许执行的命令
    allowedCommands: ['python3', 'pandoc', 'latexmk'],
  },

  // 模型适配器配置（dsh 万物皆插件，模型也是插件）
  // 双模型：OpenAI + Claude，通过中转站 code.rayinai.com
  modelAdapters: [
    {
      id: 'openai-primary',
      type: 'openai-compatible',
      config: {
        baseUrl: process.env.OPENAI_BASE_URL || 'https://code.rayinai.com/v1',
        apiKey: process.env.OPENAI_API_KEY || '',
        model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
        reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'max',
      },
    },
    {
      id: 'claude-primary',
      type: 'anthropic',
      config: {
        baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://code.rayinai.com',
        apiKey: process.env.ANTHROPIC_API_KEY || '',
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        anthropicVersion: '2023-06-01',
      },
    },
    {
      id: 'openai-light',
      type: 'openai-compatible',
      config: {
        baseUrl: process.env.OPENAI_BASE_URL || 'https://code.rayinai.com/v1',
        apiKey: process.env.OPENAI_API_KEY || '',
        model: 'gpt-4o-mini',
      },
    },
  ],

  // 要加载的插件列表
  plugins: [
    // 文献阶段
    'arxiv-search',
    'pdf-parser',
    'paper-summarizer',
    // 写作阶段
    'outline-generator',
    'section-writer',
    'coherence-checker',
    // 核验阶段
    'citation-verifier',
    'plagiarism-checker',
    // 输出阶段
    'docx-exporter',
    'latex-exporter',
  ],

  // 工作流配置
  workflows: {
    paperPipeline: {
      entry: 'src/workflows/paper-pipeline.ts',
      defaults: {
        targetWords: Number(process.env.PAPER_TARGET_WORDS || 9000),
        language: process.env.PAPER_LANGUAGE || 'zh',
        citationStyle: process.env.PAPER_CITATION_STYLE || 'GB-T-7714',
        evidencePolicy: 'cite-only-from-provided-papers',
        minEvidencePerClaim: 1,
        preferLocalCorpus: true,
        requireLimitationsSection: true,
        requireContributionStatement: true,
      },
      // 需要人工审批的阶段
      approvalStages: [
        'topic-discovery',
        'topic-confirmation',
        'protocol-design',
        'outline-generation',
        'submission-readiness',
      ],
    },
  },

  // 持久化配置（断点续跑）
  persistence: {
    enabled: true,
    stateDir: process.env.PAPER_STATE_DIR || join(DEFAULT_DATA_ROOT, '.dsh-state'),
    // 每完成一个阶段自动保存状态
    autoSaveOnStageComplete: true,
  },
};

/** 初始化工作流状态 */
export function createInitialState(topic: string): PipelineState {
  const now = new Date().toISOString();
  return {
    topic,
    stage: 'project-intake',
    papers: [],
    notes: new Map(),
    sections: [],
    metadata: {
      startTime: now,
      currentStageStartTime: now,
      modelCalls: 0,
      totalTokens: 0,
      originalTopic: topic,
    },
  };
}
