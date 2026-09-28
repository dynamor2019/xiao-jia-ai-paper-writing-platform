import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FIELD_LENGTH = 500;

export function feedbackPath(projectDir) {
  return join(projectDir, 'milestones', 'research-feedback.jsonl');
}

export function readFeedback(projectDir) {
  const path = feedbackPath(projectDir);
  if (!existsSync(path)) return [];
  const items = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'add' && !items.has(event.id)) {
      items.set(event.id, { ...event, status: 'open' });
    } else if (event.type === 'resolve' && items.get(event.id)?.status === 'open') {
      Object.assign(items.get(event.id), { status: 'resolved', resolution: event.resolution, verification: event.verification, resolvedAt: event.at });
    } else {
      throw new Error('研究反馈台账含无效事件，需人工复核');
    }
  }
  return [...items.values()];
}

function checkedField(value, label) {
  const field = String(value || '').trim();
  if (!field || field.length > MAX_FIELD_LENGTH || /[\r\n]/.test(field)) {
    throw new Error(`${label}不能为空、换行或超过 ${MAX_FIELD_LENGTH} 字`);
  }
  return field;
}

export function addFeedback(projectDir, stage, claimId, issue, evidence) {
  const event = {
    type: 'add', id: randomUUID().slice(0, 8), at: new Date().toISOString(),
    stage: checkedField(stage, '阶段'), claimId: checkedField(claimId, '主张 ID'),
    issue: checkedField(issue, '异议'), evidence: checkedField(evidence, '证据线索'),
  };
  readFeedback(projectDir);
  mkdirSync(join(projectDir, 'milestones'), { recursive: true });
  appendFileSync(feedbackPath(projectDir), `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

export function resolveFeedback(projectDir, id, resolution, verification) {
  const item = readFeedback(projectDir).find((row) => row.id === id);
  if (!item || item.status !== 'open') throw new Error('找不到待处理的反馈 ID');
  const event = {
    type: 'resolve', id, at: new Date().toISOString(),
    resolution: checkedField(resolution, '处理说明'),
    verification: checkedField(verification, '复核依据'),
  };
  appendFileSync(feedbackPath(projectDir), `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

export function findClaimEvidence(projectDir, claimId) {
  const path = join(projectDir, 'milestones', 'claim-evidence-matrix.md');
  if (!existsSync(path)) return null;
  const id = checkedField(claimId, '主张 ID');
  const row = readFileSync(path, 'utf8').split(/\r?\n/)
    .find((line) => line.startsWith('|') && line.split('|')[1]?.trim() === id);
  return row ? { path, row } : null;
}
