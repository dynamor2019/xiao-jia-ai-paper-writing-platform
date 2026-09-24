import type { Paper } from '../../types.js';

export interface ResearchDirection {
  title: string;
  researchQuestion: string;
  novelty: string;
  method: string;
  requiredData: string;
  feasibility: string;
  risks: string[];
  sourceIds: string[];
  transfer: {
    homeDiscipline: string;
    sourceDiscipline: string;
    borrowedMethod: string;
    targetProblem: string;
    transferMechanism: string;
    assumptions: string[];
    boundaries: string[];
    failureConditions: string[];
    validationPlan: string;
    sourceIds: string[];
    targetIds: string[];
  };
  evidenceClaims: Array<{
    role: 'target-need' | 'source-method' | 'gap';
    claim: string;
    sourceIds: string[];
    limitation: string;
  }>;
  baseline: string;
  falsification: string;
  dataAccess: string;
}

export interface TopicReview {
  approved: boolean;
  checks: {
    homeDisciplineFit: boolean;
    crossDisciplineMechanism: boolean;
    evidenceAndGap: boolean;
    feasibilityAndData: boolean;
    falsifiabilityAndBoundaries: boolean;
  };
  issues: string[];
  limitations: string[];
}

const NON_EMPTY = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function requireText(value: unknown, field: string): void {
  if (!NON_EMPTY(value)) throw new Error(`选题缺少可核验内容: ${field}`);
}

function requireTextList(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length === 0 || !value.every(NON_EMPTY)) {
    throw new Error(`选题缺少可核验内容: ${field}`);
  }
}

function requireIds(value: unknown, allowed: Set<string>, field: string, minimum = 1): void {
  if (!Array.isArray(value) || new Set(value).size < minimum || !value.every((id) => NON_EMPTY(id) && allowed.has(id))) {
    throw new Error(`选题证据不足或引用了检索结果之外的文献: ${field}`);
  }
}

/** Structural gate; semantic support is reviewed separately and still needs human full-text reading. */
export function validateResearchDirection(direction: ResearchDirection, targetWorks: Paper[], sourceWorks: Paper[]): void {
  if (!direction || typeof direction !== 'object') throw new Error('选题模型没有返回研究方向');
  for (const field of ['title', 'researchQuestion', 'novelty', 'method', 'requiredData', 'feasibility', 'baseline', 'falsification', 'dataAccess'] as const) {
    requireText(direction[field], field);
  }
  requireTextList(direction.risks, 'risks');
  const targetIds = new Set(targetWorks.map((paper) => paper.id));
  const sourceIds = new Set(sourceWorks.map((paper) => paper.id));
  requireIds(direction.sourceIds, new Set([...targetIds, ...sourceIds]), 'sourceIds', 4);
  const transfer = direction.transfer;
  if (!transfer || typeof transfer !== 'object') throw new Error('选题缺少跨学科迁移说明');
  for (const field of ['homeDiscipline', 'sourceDiscipline', 'borrowedMethod', 'targetProblem', 'transferMechanism', 'validationPlan'] as const) {
    requireText(transfer[field], `transfer.${field}`);
  }
  if (transfer.homeDiscipline.trim().toLowerCase() === transfer.sourceDiscipline.trim().toLowerCase()) {
    throw new Error('借鉴学科与本专业相同，不能作为跨学科迁移');
  }
  for (const field of ['assumptions', 'boundaries', 'failureConditions'] as const) {
    requireTextList(transfer[field], `transfer.${field}`);
  }
  requireIds(transfer.targetIds, targetIds, 'transfer.targetIds', 2);
  requireIds(transfer.sourceIds, sourceIds, 'transfer.sourceIds', 2);
  if (!targetWorks.some((paper) => transfer.targetIds.includes(paper.id) && NON_EMPTY(paper.abstract))
    || !sourceWorks.some((paper) => transfer.sourceIds.includes(paper.id) && NON_EMPTY(paper.abstract))) {
    throw new Error('本专业和借鉴学科均需至少一篇带摘要的支撑文献');
  }
  const claims = direction.evidenceClaims;
  if (!Array.isArray(claims) || !['target-need', 'source-method', 'gap'].every((role) => claims.some((claim) => claim?.role === role))) {
    throw new Error('必须分别说明本专业问题、借鉴方法及待验证的研究空白');
  }
  for (const claim of claims) {
    requireText(claim.claim, 'evidenceClaims.claim');
    requireText(claim.limitation, 'evidenceClaims.limitation');
    const allowed = claim.role === 'source-method' ? sourceIds : targetIds;
    requireIds(claim.sourceIds, allowed, `evidenceClaims.${claim.role}`);
  }
}

export function validateTopicReview(review: TopicReview): void {
  const checks = review?.checks;
  if (!checks || !Array.isArray(review.issues) || !review.issues.every(NON_EMPTY)) {
    throw new Error('独立选题复核结果不完整');
  }
  requireTextList(review.limitations, 'review.limitations');
  const required = ['homeDisciplineFit', 'crossDisciplineMechanism', 'evidenceAndGap', 'feasibilityAndData', 'falsifiabilityAndBoundaries'] as const;
  if (required.some((key) => typeof checks[key] !== 'boolean') || typeof review.approved !== 'boolean') {
    throw new Error('独立选题复核缺少逐项判断');
  }
  if (!review.approved || required.some((key) => !checks[key]) || review.issues.length > 0) {
    throw new Error(`独立选题复核未通过: ${review.issues.join('；') || '存在未通过的科学性检查'}`);
  }
}

export function formatTopicEvidence(direction: ResearchDirection, review: TopicReview): string {
  const transfer = direction.transfer;
  const claims = direction.evidenceClaims.map((item) => `- ${item.role}: ${item.claim} [${item.sourceIds.join(', ')}]；局限：${item.limitation}`).join('\n');
  return [
    '## 跨学科迁移与科学性边界',
    `- 本专业：${transfer.homeDiscipline}；借鉴学科：${transfer.sourceDiscipline}`,
    `- 借鉴方法：${transfer.borrowedMethod}；本专业问题：${transfer.targetProblem}`,
    `- 迁移机理：${transfer.transferMechanism}`,
    `- 适用前提：${transfer.assumptions.join('；')}`,
    `- 适用边界：${transfer.boundaries.join('；')}`,
    `- 失效条件：${transfer.failureConditions.join('；')}`,
    `- 验证方案：${transfer.validationPlan}`,
    `- 本专业证据 ID：${transfer.targetIds.join(', ')}`,
    `- 借鉴学科证据 ID：${transfer.sourceIds.join(', ')}`,
    `- 基线对照：${direction.baseline}；证伪标准：${direction.falsification}`,
    `- 数据取得路径：${direction.dataAccess}`,
    '', '## 论断与证据（仅元数据/摘要，非全文核验）', claims,
    '', '## 独立复核',
    `- 机器初审：${review.approved ? '通过结构与独立复核，等待人工确认' : '未通过'}`,
    `- 仍需人工核查：${review.limitations.join('；') || '阅读关键文献全文、核对研究空白与实际数据可得性'}`,
    '- 方法依据：[NIH 科研严谨性指导](https://grants.nih.gov/policy-and-compliance/policy-topics/reproducibility/guidance)要求评估先前研究的强弱与设计偏差；[NSF 跨学科评审准则](https://www.nsf.gov/funding/opportunities/dcl-integrated-nsf-support-promoting-interdisciplinary-research/nsf14-106)强调学科整合而非简单拼接。这里仅借鉴评估原则，不代表通过其正式评审。',
  ].join('\n');
}
