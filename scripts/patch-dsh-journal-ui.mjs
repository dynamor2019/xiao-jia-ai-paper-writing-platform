import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PAPER_PHASES } from '../config/dsh/web/paper-phases.js';

const CLIENT_BUNDLE = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-conversation',
  'lib',
  'client.js',
);
const LEGACY_MARKER = 'const JOURNAL_STORAGE_KEY = "dsh.paper.targetJournal";';
const CURRENT_MARKER = 'let activeTargetJournal = readStoredTargetJournal();';
const WORKBENCH_MARKER = 'function ResearchWorkbench({ locked, inputActions, sessionId })';
const CURRENT_INPUT_MODES_MARKER = 'children: [sessionId === void 0 ? null : renderSlot("conversation.input.permission", { locked }), sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]';

function upgradeJournalStateSync(source, eol) {
  if (!source.includes('function syncTargetJournal(journalId)')) {
    const anchor = '\t\tfunction journalizeDraft(draft) {';
    const syncHelper = [
      '\t\tfunction syncTargetJournal(journalId) {',
      '\t\t\treturn fetch("/dsh-paper-journal", {',
      '\t\t\t\tmethod: "POST",',
      '\t\t\t\theaders: { "content-type": "application/json" },',
      '\t\t\t\tbody: JSON.stringify({ journalId })',
      '\t\t\t}).catch(() => void 0);',
      '\t\t}',
      '',
    ].join(eol);
    source = replaceOnce(source, anchor, `${syncHelper}${anchor}`, '期刊后台同步');
  }

  const instructionStart = '\t\t\tconst instruction = `[目标期刊：${journal.name}；期刊 ID：${journal.id}。写作前必须加载 journal-${journal.id} skill，并从大纲阶段开始遵守该刊范围、结构、证据、声明和格式要求，不要在正文完成后才改格式。]`;';
  if (source.includes(instructionStart)) {
    const oldTail = [
      instructionStart,
      '\t\t\tif (/^\\[目标期刊：[^\\n]+\\]\\n?/.test(draft)) return draft.replace(/^\\[目标期刊：[^\\n]+\\]\\n?/, `${instruction}\\n`);',
      '\t\t\treturn `${instruction}\\n${draft}`;',
    ].join(eol);
    source = replaceOnce(source, oldTail, '\t\t\treturn draft;', '移除可见期刊提示词');
  }

  const selectedLine = '\t\t\tconst selected = JOURNAL_OPTIONS.find((journal) => journal.id === value);';
  if (!source.includes('(0, react.useEffect)(() => { void syncTargetJournal(value); }, []);')) {
    source = replaceOnce(
      source,
      selectedLine,
      `${selectedLine}${eol}\t\t\t(0, react.useEffect)(() => { void syncTargetJournal(value); }, []);`,
      '期刊初始同步',
    );
  }

  const storageLine = '\t\t\t\t\tglobalThis.localStorage?.setItem(JOURNAL_STORAGE_KEY, next);';
  const syncInTry = `${storageLine}${eol}\t\t\t\t\tvoid syncTargetJournal(next);`;
  if (source.includes(syncInTry)) {
    source = replaceOnce(source, syncInTry, storageLine, '移出期刊同步');
  }
  const catchLine = '\t\t\t\t} catch {}';
  const syncAfterCatch = `${catchLine}${eol}\t\t\t\tvoid syncTargetJournal(next);`;
  if (!source.includes(syncAfterCatch)) {
    source = replaceOnce(
      source,
      catchLine,
      syncAfterCatch,
      '期刊切换同步',
    );
  }
  return source;
}

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`无法定位 DSH UI ${label} 插入点`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`DSH UI ${label} 插入点不唯一`);
  }
  return source.replace(needle, replacement);
}

function maybeReplaceOnce(source, needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0) return source;
  return source.replace(needle, replacement);
}

function patchCurrentJournalSelector(source, eol) {
  const options = [
    { id: '', name: '通用论文（未指定期刊）', description: '不绑定具体期刊，采用通用科技论文规范。' },
    { id: 'automation-in-construction', name: 'Automation in Construction', impactFactor: '11.5', jcr: 'Q1', description: '建筑全生命周期自动化、BIM、施工与运维智能化，强调真实工程验证。' },
    { id: 'advanced-engineering-informatics', name: 'Advanced Engineering Informatics', impactFactor: '9.9', jcr: 'Q1', description: '知识表示、工程信息学和知识驱动决策；常规算法应用通常不足以构成贡献。' },
    { id: 'journal-of-computing-in-civil-engineering', name: 'Journal of Computing in Civil Engineering', impactFactor: '5.8', jcr: 'Q1', description: '土木工程中的计算、人工智能、BIM、传感与机器人应用。' },
    { id: 'computer-aided-civil-and-infrastructure-engineering', name: 'Computer-Aided Civil and Infrastructure Engineering', impactFactor: '9.1', jcr: 'Q1', description: '高水平计算方法创新，以及在土木与基础设施中的严格外部验证。' },
    { id: 'building-and-environment', name: 'Building and Environment', impactFactor: '7.6', jcr: 'Q1', description: '建筑环境、室内环境质量、HVAC、热舒适与建筑物理研究。' },
    { id: 'energy-and-buildings', name: 'Energy and Buildings', impactFactor: '8.0', jcr: 'Q1 / Q2', description: '建筑能耗、负荷预测、控制优化、减碳及舒适与能耗权衡；2024 JCR 中建筑/土木类别 Q1，能源与燃料类别 Q2。' },
    { id: 'journal-of-building-engineering', name: 'Journal of Building Engineering', impactFactor: '7.4', jcr: 'Q1', description: '建筑工程全生命周期，适合具有明确工程价值的 AI 与 MEP 研究。' },
    { id: 'science-and-technology-for-the-built-environment', name: 'Science and Technology for the Built Environment', impactFactor: '1.7', jcr: 'Q3', description: 'HVAC&R、控制、故障诊断和经过验证的系统仿真。' },
    { id: 'building-services-engineering-research-and-technology', name: 'Building Services Engineering Research and Technology', impactFactor: '1.8', jcr: 'Q3', description: '建筑服务工程、HVAC、供配电、给排水与工程实践。' },
    { id: 'engineering-applications-of-artificial-intelligence', name: 'Engineering Applications of Artificial Intelligence', impactFactor: '9.0', jcr: 'Q1', description: '人工智能方法创新与真实工程应用均须有充分贡献。' },
    { id: 'ieee-transactions-on-automation-science-and-engineering', name: 'IEEE Transactions on Automation Science and Engineering', impactFactor: '7.9', jcr: 'Q1', description: '自动化科学的理论、算法、系统方法与实际工程部署。' },
    { id: 'expert-systems-with-applications', name: 'Expert Systems with Applications', impactFactor: '7.5', jcr: 'Q1', description: '专家系统、智能决策和可解释 AI 应用，避免单纯模型对比。' },
  ];
  const helper = [
    '\t\tconst JOURNAL_OPTIONS = ' + JSON.stringify(options) + ';',
    '\t\tfunction JournalSelect({ locked }) {',
    '\t\t\tconst [value, setValue] = (0, react.useState)(() => globalThis.localStorage?.getItem("dsh.paper.targetJournal") ?? "");',
    '\t\t\tconst selected = JOURNAL_OPTIONS.find((journal) => journal.id === value);',
    '\t\t\tconst change = (event) => {',
    '\t\t\t\tconst next = event.target.value;',
    '\t\t\t\tsetValue(next);',
    '\t\t\t\ttry { globalThis.localStorage?.setItem("dsh.paper.targetJournal", next); } catch {}',
    '\t\t\t\tvoid fetch("/dsh-paper-journal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ journalId: next }) });',
    '\t\t\t};',
    '\t\t\treturn (0, react_jsx_runtime.jsx)("select", { className: InputBar_module_css_default.select, value, "aria-label": "目标期刊", title: selected ? `2024 JCR：${selected.jcr || "未核实"}；${selected.description}` : "选择目标期刊", onChange: change, children: JOURNAL_OPTIONS.map((journal) => (0, react_jsx_runtime.jsx)("option", { value: journal.id, title: journal.id ? `2024 JCR：${journal.jcr || "未核实"}；${journal.description}` : journal.description, children: journal.impactFactor ? `${journal.name}（JCR ${journal.jcr || "未核实"} · IF：${journal.impactFactor}）` : journal.name }, journal.id || "general")) });',
    '\t\t}',
    '',
  ].join(eol);
  const helperStart = source.indexOf('\t\tconst JOURNAL_OPTIONS = ');
  const componentAnchor = '\t\t//#region lib/types/client/skeleton/InputBar.js';
  const helperEnd = source.indexOf(componentAnchor, helperStart);
  if (helperStart >= 0 && helperEnd >= 0) {
    source = `${source.slice(0, helperStart)}${helper}${source.slice(helperEnd)}`;
  } else {
    source = replaceOnce(source, componentAnchor, `${helper}${componentAnchor}`, '恢复期刊选择器');
  }
  const workbenchNode = '(0, react_jsx_runtime.jsx)(ResearchWorkbench, { locked, inputActions, sessionId })';
  const withSelector = '(0, react_jsx_runtime.jsx)(JournalSelect, { locked }), ' + workbenchNode;
  return source.includes(withSelector) ? source : replaceOnce(source, workbenchNode, withSelector, '输入框期刊选择器');
}

export function patchResearchWorkbench(source, eol) {
  const workbenchJournal = [
    '\t\t\tconst journalId = globalThis.localStorage?.getItem("dsh.paper.targetJournal") ?? "";',
    '\t\t\tconst journal = { id: journalId, name: journalId || "通用论文（未指定期刊）" };',
  ].join(eol);
  const oldWorkbenchJournal = '\t\t\tconst journal = JOURNAL_OPTIONS.find((item) => item.id === readTargetJournal()) ?? JOURNAL_OPTIONS[0];';
  if (source.includes(oldWorkbenchJournal)) {
    source = replaceOnce(
      source,
      oldWorkbenchJournal,
      workbenchJournal,
      '期刊工作台状态隔离',
    );
  }
  const isolatedWorkbenchJournal = [
    '\t\t\tconst journalId = globalThis.localStorage?.getItem("dsh.paper.targetJournal") ?? "";',
    '\t\t\tconst journal = { id: journalId, name: journalId || "通用论文（未指定期刊）" };',
  ].join(eol);
  if (source.includes(isolatedWorkbenchJournal)) {
    source = replaceOnce(
      source,
      isolatedWorkbenchJournal,
      workbenchJournal,
      '期刊工作台本地状态',
    );
  }
  const helper = [
    '\t\tfunction workbenchPhases(snapshot) {',
    '\t\t\tconst groups = ' + JSON.stringify(PAPER_PHASES) + ';',
    '\t\t\tconst stages = Array.isArray(snapshot?.stages) ? snapshot.stages : [];',
    '\t\t\tconst provided = Array.isArray(snapshot?.phases) ? snapshot.phases : [];',
    '\t\t\tif (provided.length > 0 && provided.length <= 6) return provided;',
    '\t\t\tif (!stages.length) return [];',
    '\t\t\tif (stages.length <= 6 && stages.every((stage) => groups.some((group) => group[0] === stage.id))) return stages;',
    '\t\t\treturn groups.map(([id, label, ids]) => {',
    '\t\t\t\tconst members = stages.filter((stage) => ids.includes(stage.id));',
    '\t\t\t\tconst statusOf = (stage) => stage.status || (stage.passed ? "complete" : "pending");',
    '\t\t\t\tconst status = members.some((stage) => statusOf(stage) === "error") ? "error" : members.some((stage) => statusOf(stage) === "active") ? "active" : members.some((stage) => statusOf(stage) === "degraded") ? "degraded" : members.length === ids.length && members.every((stage) => statusOf(stage) === "complete") ? "complete" : members.some((stage) => statusOf(stage) === "complete") ? "active" : "pending";',
    '\t\t\t\tconst current = members.find((stage) => statusOf(stage) === "active" || statusOf(stage) === "error");',
    '\t\t\t\treturn { id, label, status, passed: status === "complete", detail: current ? current.label : "" };',
    '\t\t\t});',
    '\t\t}',
    '\t\tconst WORKBENCH_STORAGE_KEY = "dsh.paper.workbench.topic";',
    '\t\tconst WORKBENCH_ACTIONS = [',
    '\t\t\t{ title: "刷新真实状态", detail: "读取核心流水线断点、质量门禁和当前论文目录。", command: "/paper-workbench" },',
    '\t\t\t{ title: "恢复中断流程", detail: "从同一论文目录和断点继续，不重新创建项目。", command: "/paper-resume" },',
    '\t\t\t{ title: "运行质量门禁", detail: "检查源稿、图表、公式、引用、实验和 Word。", command: "/paper-validate" },',
    '\t\t\t{ title: "查看里程碑产物", detail: "只列出当前论文的里程碑与最终交付文件。", command: "/paper-artifacts" },',
    '\t\t\t{ title: "研究反馈", detail: "查看待处理异议；可在对话中使用 /paper-feedback add 登记。", command: "/paper-feedback list" },',
    '\t\t\t{ title: "导出正式 Word", detail: "从当前终稿导出并执行 DOCX 二次检查。", command: "/paper-export" },',
    '\t\t\t{ title: "检查投稿包", detail: "依据同一质量状态列出投稿阻断项。", command: "/paper-submission" }',
    '\t\t];',
    '\t\tconst WORKBENCH_DIRECTION_FIELDS = [',
    '\t\t\t{ key: "focus", label: "核心创新与贡献", placeholder: "例如：只聚焦三个核心创新，不扩展到其他问题" },',
    '\t\t\t{ key: "scope", label: "研究范围与排除项", placeholder: "研究对象、场景、边界，以及明确不讨论的内容" },',
    '\t\t\t{ key: "method", label: "方法与实验偏好", placeholder: "优化、仿真、统计方法、基线或消融实验要求" },',
    '\t\t\t{ key: "constraints", label: "数据与实施约束", placeholder: "公开数据集、编程语言、算力、可复现或合规要求" }',
    '\t\t];',
    '\t\tconst AUTHOR_RANK_OPTIONS = [',
    '\t\t\t{ id: "1", label: "第一作者" }, { id: "1c", label: "第一作者（通讯作者）" },',
    '\t\t\t{ id: "2", label: "第二作者" }, { id: "2c", label: "第二作者（通讯作者）" },',
    '\t\t\t{ id: "3", label: "第三作者" }, { id: "3c", label: "第三作者（通讯作者）" },',
    '\t\t\t{ id: "4", label: "第四作者" }, { id: "4c", label: "第四作者（通讯作者）" },',
    '\t\t\t{ id: "5", label: "第五作者" }, { id: "5c", label: "第五作者（通讯作者）" },',
    '\t\t\t{ id: "6", label: "第六作者" }, { id: "6c", label: "第六作者（通讯作者）" },',
    '\t\t\t{ id: "7", label: "其他作者" }, { id: "7c", label: "其他作者（通讯作者）" }',
    '\t\t];',
    '\t\tfunction blankAuthor(rank = "1") { return { name: "", rank, email: "", affiliation: "" }; }',
    '\t\tfunction ensureWorkbenchStyles() {',
    '\t\t\tif (document.querySelector("style[data-dsh-paper-workbench]")) return;',
    '\t\t\tconst style = document.createElement("style");',
    '\t\t\tstyle.dataset.dshPaperWorkbench = "true";',
    '\t\t\tstyle.textContent = `.dsh-wb-trigger{height:28px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 9px;font:500 13px/26px var(--dsw-font-family);cursor:pointer;white-space:nowrap}.dsh-wb-trigger:hover,.dsh-wb-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsh-wb-panel{position:absolute;left:8px;right:8px;bottom:58px;z-index:40;max-height:min(560px,70vh);overflow:auto;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:8px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}.dsh-wb-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l3)}.dsh-wb-title{font-size:14px;font-weight:650}.dsh-wb-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:1}.dsh-wb-close{width:28px;height:28px;border:0;background:transparent;color:inherit;cursor:pointer;font-size:20px}.dsh-wb-brief{display:grid;grid-template-columns:minmax(160px,1.5fr) minmax(160px,1fr);gap:10px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l3)}.dsh-wb-field{display:flex;flex-direction:column;gap:4px;min-width:0}.dsh-wb-field label{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dsh-wb-field input,.dsh-wb-readonly{box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l3);border-radius:5px;background:transparent;color:inherit;padding:0 9px;font-size:13px;min-width:0}.dsh-wb-field input:disabled{opacity:.7}.dsh-wb-readonly{display:flex;align-items:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-wb-status{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l3);font-size:12px}.dsh-wb-status strong{font-size:13px}.dsh-wb-status span{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-wb-primary{margin-left:auto;border:0;border-radius:5px;background:var(--dsw-alias-state-business-primary);color:white;padding:7px 11px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}.dsh-wb-primary:disabled{opacity:.55;cursor:default}.dsh-wb-progress{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;padding:12px 14px;background:var(--dsw-alias-border-l3)}.dsh-wb-stage{min-width:0;background:var(--dsw-specific-input-major);padding:8px 9px;font-size:11px;color:var(--dsw-alias-label-tertiary)}.dsh-wb-stage[data-pass=true]{color:var(--dsw-alias-label-primary);box-shadow:inset 3px 0 var(--dsw-alias-state-business-primary)}.dsh-wb-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;padding:8px 14px 14px}.dsh-wb-action{min-width:0;text-align:left;border:0;border-left:3px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;padding:9px 10px;cursor:pointer}.dsh-wb-action:hover{background:var(--dsw-alias-interactive-bg-hover);border-left-color:var(--dsw-alias-state-business-primary)}.dsh-wb-action:disabled{opacity:.5;cursor:default}.dsh-wb-action strong{display:block;font-size:13px;font-weight:600}.dsh-wb-action span{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dsh-wb-foot{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:11px}@media(max-width:720px){.dsh-wb-panel{left:4px;right:4px;bottom:64px}.dsh-wb-brief,.dsh-wb-actions,.dsh-wb-progress{grid-template-columns:1fr}.dsh-wb-sub{display:none}.dsh-wb-status{align-items:flex-start;flex-wrap:wrap}.dsh-wb-primary{margin-left:0}}`;',
    '\t\t\tstyle.textContent += `.dsh-wb-panel{max-height:min(620px,74vh)}.dsh-wb-progress-wrap{padding:11px 14px 13px;border-bottom:1px solid var(--dsw-alias-border-l3)}.dsh-wb-progress-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px;font-weight:600}.dsh-wb-progress-head span{color:var(--dsw-alias-label-tertiary);font-weight:500}.dsh-wb-progress{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:0;background:transparent}.dsh-wb-stage{display:grid;grid-template-columns:12px minmax(0,1fr);column-gap:7px;align-items:center;min-height:36px;border:1px solid var(--dsw-alias-border-l3);border-radius:5px;padding:7px 8px;box-shadow:none}.dsh-wb-stage-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-border-l3)}.dsh-wb-stage-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-wb-stage small{grid-column:2;color:inherit;font-size:10px}.dsh-wb-stage[data-status=complete]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}.dsh-wb-stage[data-status=complete] .dsh-wb-stage-dot,.dsh-wb-stage[data-status=active] .dsh-wb-stage-dot{background:var(--dsw-alias-state-business-primary)}.dsh-wb-stage[data-status=active]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}.dsh-wb-stage[data-status=error]{color:#d86666;border-color:#d86666}.dsh-wb-stage[data-status=error] .dsh-wb-stage-dot{background:#d86666}@media(max-width:720px){.dsh-wb-progress{grid-template-columns:1fr}}`;',
    '\t\t\tstyle.textContent += `.dsh-wb-direction{padding:11px 14px 13px;border-bottom:1px solid var(--dsw-alias-border-l3)}.dsh-wb-direction-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}.dsh-wb-direction-head strong{font-size:12px}.dsh-wb-direction-head span{font-size:10px;color:var(--dsw-alias-label-tertiary)}.dsh-wb-direction-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.dsh-wb-direction textarea{box-sizing:border-box;width:100%;min-height:54px;resize:vertical;border:1px solid var(--dsw-alias-border-l3);border-radius:5px;background:transparent;color:inherit;padding:7px 8px;font:400 11px/16px var(--dsw-font-family)}.dsh-wb-direction textarea:disabled{opacity:.65}.dsh-wb-direction label{display:block;margin-bottom:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}@media(max-width:720px){.dsh-wb-direction-grid{grid-template-columns:1fr}}`;',
    '\t\t\tstyle.textContent += `.dsh-wb-authors{padding:11px 14px 13px;border-bottom:1px solid var(--dsw-alias-border-l3)}.dsh-wb-author-row{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(132px,.9fr) minmax(0,1fr) minmax(0,1.2fr) auto;gap:6px;margin-bottom:8px}.dsh-wb-author-row input,.dsh-wb-author-row select{box-sizing:border-box;width:100%;height:32px;border:1px solid var(--dsw-alias-border-l3);border-radius:5px;background:transparent;color:inherit;padding:0 8px;font:400 12px/30px var(--dsw-font-family)}.dsh-wb-author-row button,.dsh-wb-author-actions button{height:32px;border:1px solid var(--dsw-alias-border-l3);border-radius:5px;background:transparent;color:inherit;padding:0 8px;font-size:12px;cursor:pointer}.dsh-wb-author-actions{display:flex}@media(max-width:720px){.dsh-wb-author-row{grid-template-columns:1fr}}`;',
    '\t\t\tstyle.textContent += `.dsh-wb-preview{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l3);font-size:12px}.dsh-wb-preview span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}.dsh-wb-preview button{border:1px solid var(--dsw-alias-border-l3);border-radius:5px;background:transparent;color:inherit;padding:6px 10px;font-size:12px;cursor:pointer}.dsh-wb-preview button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-wb-preview button:disabled{opacity:.55;cursor:default}`;',
    '\t\t\tdocument.head.appendChild(style);',
    '\t\t}',
    '\t\tfunction ResearchWorkbench({ locked, inputActions, sessionId }) {',
    '\t\t\tconst [open, setOpen] = (0, react.useState)(false);',
    '\t\t\tconst topicStorageKey = `${WORKBENCH_STORAGE_KEY}.${sessionId || "draft"}`;',
    '\t\t\tconst directionStorageKey = `${topicStorageKey}.direction`;',
    '\t\t\tconst authorsStorageKey = `${topicStorageKey}.authors`;',
    '\t\t\tconst [topic, setTopic] = (0, react.useState)(() => { try { return globalThis.localStorage?.getItem(topicStorageKey) ?? ""; } catch { return ""; } });',
    '\t\t\tconst [direction, setDirection] = (0, react.useState)(() => { try { return JSON.parse(globalThis.localStorage?.getItem(directionStorageKey) || "{}"); } catch { return {}; } });',
    '\t\t\tconst [authors, setAuthors] = (0, react.useState)(() => { try { const saved = JSON.parse(globalThis.localStorage?.getItem(authorsStorageKey) || "[]"); return Array.isArray(saved) && saved.length ? saved : [blankAuthor()]; } catch { return [blankAuthor()]; } });',
    '\t\t\tconst [snapshot, setSnapshot] = (0, react.useState)(null);',
    '\t\t\tconst [statusError, setStatusError] = (0, react.useState)("");',
    '\t\t\t(0, react.useEffect)(ensureWorkbenchStyles, []);',
    '\t\t\t(0, react.useEffect)(() => { try { setTopic(globalThis.localStorage?.getItem(topicStorageKey) ?? ""); setDirection(JSON.parse(globalThis.localStorage?.getItem(directionStorageKey) || "{}")); const saved = JSON.parse(globalThis.localStorage?.getItem(authorsStorageKey) || "[]"); setAuthors(Array.isArray(saved) && saved.length ? saved : [blankAuthor()]); } catch { setTopic(""); setDirection({}); setAuthors([blankAuthor()]); } setSnapshot(null); }, [topicStorageKey, directionStorageKey, authorsStorageKey]);',
    '\t\t\t(0, react.useEffect)(() => {',
    '\t\t\t\tif (!open || !sessionId) return void 0;',
    '\t\t\t\tlet active = true;',
    '\t\t\t\tconst refresh = () => fetch(`/dsh-paper-workbench?sessionId=${encodeURIComponent(sessionId)}`).then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }).then((data) => { if (!active) return; setSnapshot(data); setStatusError(""); if (data.project && data.topic) setTopic(data.topic); if (data.project && data.researchDirection) setDirection(data.researchDirection); if (Array.isArray(data.authors)) setAuthors((current) => current.some((row) => row.name || row.email || row.affiliation) ? current : data.authors); }).catch((error) => { if (active) setStatusError(error.message); });',
    '\t\t\t\trefresh();',
    '\t\t\t\tconst timer = setInterval(refresh, 3000);',
    '\t\t\t\treturn () => { active = false; clearInterval(timer); };',
    '\t\t\t}, [open, sessionId]);',
    '\t\t\tconst journalId = globalThis.localStorage?.getItem("dsh.paper.targetJournal") ?? "";',
    '\t\t\tconst journal = { id: journalId, name: journalId || "通用论文（未指定期刊）" };',
    '\t\t\tconst updateTopic = (event) => {',
    '\t\t\t\tconst next = event.target.value;',
    '\t\t\t\tsetTopic(next);',
    '\t\t\t\ttry { globalThis.localStorage?.setItem(topicStorageKey, next); } catch {}',
    '\t\t\t};',
    '\t\t\tconst saveAuthors = (next) => {',
    '\t\t\t\tconst rows = next.length ? next.slice(0, 12) : [blankAuthor()];',
    '\t\t\t\tsetAuthors(rows);',
    '\t\t\t\ttry { globalThis.localStorage?.setItem(authorsStorageKey, JSON.stringify(rows)); } catch {}',
    '\t\t\t\tif (sessionId) void fetch("/dsh-paper-authors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, authors: rows }) });',
    '\t\t\t};',
    '\t\t\tconst updateAuthor = (index, key, value) => saveAuthors(authors.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));',
    '\t\t\tconst addAuthor = () => saveAuthors([...authors, blankAuthor(String(Math.min(authors.length + 1, 7)))]);',
    '\t\t\tconst removeAuthor = (index) => saveAuthors(authors.filter((_, rowIndex) => rowIndex !== index));',
    '\t\t\tconst updateDirection = (key, value) => {',
    '\t\t\t\tconst next = { ...direction, [key]: value };',
    '\t\t\t\tsetDirection(next);',
    '\t\t\t\ttry { globalThis.localStorage?.setItem(directionStorageKey, JSON.stringify(next)); } catch {}',
    '\t\t\t};',
    '\t\t\tconst toggleWorkbench = (event) => {',
    '\t\t\t\tevent?.preventDefault?.();',
    '\t\t\t\tevent?.stopPropagation?.();',
    '\t\t\t\tsetOpen((value) => !value);',
    '\t\t\t};',
    '\t\t\tconst closeWorkbench = (event) => {',
    '\t\t\t\tevent?.preventDefault?.();',
    '\t\t\t\tevent?.stopPropagation?.();',
    '\t\t\t\tsetOpen(false);',
    '\t\t\t};',
    '\t\t\tconst stopWorkbenchEvent = (event) => {',
    '\t\t\t\tevent?.stopPropagation?.();',
    '\t\t\t};',
    '\t\t\tconst runCommand = (command) => {',
    '\t\t\t\tif (locked || inputActions === void 0) return;',
    '\t\t\t\tinputActions.setDraft(command);',
    '\t\t\t\tsetOpen(false);',
    '\t\t\t\tsetTimeout(() => inputActions.submit(), 0);',
    '\t\t\t};',
    '\t\t\tconst openWordPreview = () => {',
    '\t\t\t\tif (!snapshot?.latestWordPreviewUrl) return;',
    '\t\t\t\tglobalThis.open(snapshot.latestWordPreviewUrl, "_blank", "noopener");',
    '\t\t\t};',
    '\t\t\tconst safeTopic = topic.trim().replaceAll(`"`, `\'`);',
    '\t\t\tconst directionArgs = WORKBENCH_DIRECTION_FIELDS.map((field) => { const value = String(direction[field.key] || "").trim().replaceAll(`"`, `\'`); return value ? ` --${field.key} "${value}"` : ""; }).join("");',
    '\t\t\tconst startCommand = safeTopic ? `/paper "${safeTopic}"${directionArgs}${journal.id ? ` --journal ${journal.id}` : ""}` : "";',
    '\t\t\tconst primary = snapshot?.manuscriptPrepared && snapshot.runStatus !== "running" ? { label: "核对投稿清单", command: "/paper-submission" } : !snapshot?.project || snapshot.runStatus === "initialized" ? { label: "开始完整流程", command: startCommand } : snapshot.runStatus === "awaiting-confirmation" ? { label: "确认研究问题并继续", command: "/paper-confirm" } : snapshot.runStatus === "failed" ? { label: "从断点继续", command: "/paper-resume" } : snapshot.runStatus === "completed" ? { label: "复核最终稿", command: "/paper-validate" } : { label: "流程运行中", command: "" };',
    '\t\t\tconst continueCommand = snapshot?.runStatus === "awaiting-confirmation" ? "/paper-confirm" : snapshot?.runStatus === "failed" ? "/paper-resume" : snapshot?.project ? "" : "继续";',
    '\t\t\tconst isAutoRecovery = snapshot?.runStatus === "running" && snapshot?.stage === "auto-recovery-wait";',
    '\t\t\tconst statusLabel = !snapshot ? "正在读取状态" : !snapshot.project ? "尚未建立论文项目" : isAutoRecovery ? "后台等待自动续跑" : snapshot.runStatus === "running" ? "后台流程运行中" : snapshot.manuscriptPrepared ? "稿件已生成，请核对最终核验与投稿清单" : snapshot.runStatus === "awaiting-confirmation" ? "等待作者确认或处理阻断项" : snapshot.runStatus === "completed" ? "流程已完成" : snapshot.runStatus === "failed" ? "流程已中断" : "项目已建立";',
    '\t\t\tconst phases = workbenchPhases(snapshot);',
    '\t\t\tconst currentStep = phases.find((phase) => phase.status === "active" || phase.status === "error" || phase.status === "degraded");',
    '\t\t\tconst statusDetail = statusError ? `状态读取失败：${statusError}` : snapshot?.openFeedback ? `${snapshot.openFeedback} 项研究异议待处理` : isAutoRecovery && snapshot?.nextRetryAt ? `下次自动续跑：${snapshot.nextRetryAt}` : currentStep ? `现在：${currentStep.label}${currentStep.detail ? ` / ${currentStep.detail}` : ""}` : snapshot?.project && snapshot?.stageLabel ? `现在：${snapshot.stageLabel}` : snapshot?.recommendedTopic ? `研究问题：${snapshot.recommendedTopic}` : "同一对话对应同一论文目录";',
    '\t\t\tconst h = react.createElement;',
    '\t\t\treturn h(react.Fragment, null,',
    '\t\t\t\th("button", { type: "button", className: "dsh-wb-trigger", "aria-expanded": open, title: "打开论文流程控制台", onMouseDown: (event) => event.preventDefault(), onClick: toggleWorkbench }, "论文工作台"),',
    '\t\t\t\topen && h("section", { className: "dsh-wb-panel", "aria-label": "论文研究工作台", onMouseDown: stopWorkbenchEvent, onClick: stopWorkbenchEvent },',
    '\t\t\t\t\th("header", { className: "dsh-wb-head" }, h("div", { className: "dsh-wb-title" }, "论文研究工作台"), h("div", { className: "dsh-wb-sub" }, "问题 → 方案小实验 → 正式实验 → 文献成文 → 审查 → 交付"), h("button", { type: "button", className: "dsh-wb-close", "aria-label": "关闭", onClick: closeWorkbench }, "×")),',
    '\t\t\t\t\th("div", { className: "dsh-wb-brief" }, h("div", { className: "dsh-wb-field" }, h("label", null, "研究领域或题目"), h("input", { value: topic, disabled: snapshot?.project, onChange: updateTopic, placeholder: "填写后直接启动完整流程" })), h("div", { className: "dsh-wb-field" }, h("label", null, "目标期刊"), h("div", { className: "dsh-wb-readonly", title: snapshot?.journalName || journal.description }, snapshot?.project ? snapshot.journalName : journal.impactFactor ? `${journal.name}（IF：${journal.impactFactor}）` : journal.name))),',
    '\t\t\t\t\th("div", { className: "dsh-wb-authors" }, h("div", { className: "dsh-wb-direction-head" }, h("strong", null, "作者信息"), h("span", null, "姓名、排名、邮箱和单位会写入论文草稿，未填写的不会编造")), ...authors.map((author, index) => h("div", { key: `author-${index}`, className: "dsh-wb-author-row" }, h("input", { value: author.name || "", placeholder: "作者姓名", onChange: (event) => updateAuthor(index, "name", event.target.value) }), h("select", { value: AUTHOR_RANK_OPTIONS.some((rank) => rank.id === author.rank) ? author.rank : "7", "aria-label": "作者排名", onChange: (event) => updateAuthor(index, "rank", event.target.value) }, ...AUTHOR_RANK_OPTIONS.map((rank) => h("option", { key: rank.id, value: rank.id }, rank.label))), h("input", { value: author.email || "", placeholder: "邮箱", onChange: (event) => updateAuthor(index, "email", event.target.value) }), h("input", { value: author.affiliation || "", placeholder: "单位", onChange: (event) => updateAuthor(index, "affiliation", event.target.value) }), h("button", { type: "button", disabled: authors.length < 2, onClick: () => removeAuthor(index) }, "删除"))), h("div", { className: "dsh-wb-author-actions" }, h("button", { type: "button", disabled: authors.length >= 12, onClick: addAuthor }, "添加作者"))),',
    '\t\t\t\t\th("div", { className: "dsh-wb-direction" }, h("div", { className: "dsh-wb-direction-head" }, h("strong", null, "研究方向控制"), h("span", null, "可选；用于约束选题、检索、实验、写作和评审")), h("div", { className: "dsh-wb-direction-grid" }, ...WORKBENCH_DIRECTION_FIELDS.map((field) => h("div", { key: field.key }, h("label", null, field.label), h("textarea", { value: direction[field.key] || "", disabled: snapshot?.project, placeholder: field.placeholder, onChange: (event) => updateDirection(field.key, event.target.value) }))))),',
    '\t\t\t\t\th("div", { className: "dsh-wb-status" }, h("strong", null, statusLabel), h("span", { title: snapshot?.recommendedTopic || snapshot?.outputDir || statusError || snapshot?.nextRetryAt }, statusDetail), h("button", { type: "button", className: "dsh-wb-primary", disabled: locked || !primary.command, onClick: () => runCommand(primary.command) }, primary.label)),',
    '\t\t\t\t\th("div", { className: "dsh-wb-preview" }, h("strong", null, "Word 预览"), h("span", { title: snapshot?.latestWord || "" }, snapshot?.latestWord ? snapshot.latestWord : "当前论文还没有生成 Word 文件"), h("button", { type: "button", disabled: !snapshot?.latestWordPreviewUrl, onClick: openWordPreview }, "预览")),',
    '\t\t\t\t\tphases.length > 0 && h("div", { className: "dsh-wb-progress-wrap" }, h("div", { className: "dsh-wb-progress-head" }, h("strong", null, "核心进度"), h("span", null, `${phases.filter((phase) => phase.passed).length}/${phases.length}`)), h("div", { className: "dsh-wb-progress", "aria-label": "论文核心进度" }, ...phases.map((stage) => { const stageStatus = stage.status || (stage.passed ? "complete" : "pending"); const stateLabel = stageStatus === "complete" ? "已完成" : stageStatus === "active" ? "进行中" : stageStatus === "error" ? "需处理" : stageStatus === "degraded" ? "降级待核验" : "待完成"; return h("div", { key: stage.id || stage.label, className: "dsh-wb-stage", "data-status": stageStatus, title: stage.detail ? `${stage.label}：${stage.detail}` : `${stage.label}：${stateLabel}` }, h("span", { className: "dsh-wb-stage-dot", "aria-hidden": "true" }), h("span", { className: "dsh-wb-stage-text" }, stage.label), h("small", null, stage.detail || stateLabel)); }))),',
    '\t\t\t\t\th("div", { className: "dsh-wb-actions" }, ...WORKBENCH_ACTIONS.map((action) => h("button", { key: action.title, type: "button", className: "dsh-wb-action", disabled: locked || !snapshot?.project, onClick: () => runCommand(action.command) }, h("strong", null, action.title), h("span", null, action.detail)))),',
    '\t\t\t\t\tsnapshot?.quality === "BLOCKED" && h("div", { className: "dsh-wb-foot" }, "科学核验：未通过")',
    '\t\t\t\t)',
    '\t\t\t);',
    '\t\t}',
    '',
  ].join(eol);
  const componentAnchor = '\t\t//#region lib/types/client/skeleton/InputBar.js';
  const helperStart = source.indexOf('\t\tfunction workbenchPhases(snapshot) {');
  const existingStart = helperStart >= 0 ? helperStart : source.indexOf('\t\tconst WORKBENCH_STORAGE_KEY = "dsh.paper.workbench.topic";');
  if (existingStart >= 0) {
    const existingEnd = source.indexOf(componentAnchor, existingStart);
    if (existingEnd < 0) throw new Error('无法定位旧论文工作台结束位置');
    const refreshed = `${source.slice(0, existingStart)}${helper}${source.slice(existingEnd)}`;
    const legacyInvocation = '(0, react_jsx_runtime.jsx)(ResearchWorkbench, { locked, inputActions })';
    return refreshed.includes(legacyInvocation)
      ? refreshed.replace(legacyInvocation, '(0, react_jsx_runtime.jsx)(ResearchWorkbench, { locked, inputActions, sessionId })')
      : refreshed;
  }
  source = replaceOnce(source, componentAnchor, `${helper}${componentAnchor}`, '论文工作台组件');
  const currentModesPatch = 'children: [sessionId === void 0 ? null : renderSlot("conversation.input.permission", { locked }), (0, react_jsx_runtime.jsx)(ResearchWorkbench, { locked, inputActions, sessionId }), sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]';
  if (source.includes(currentModesPatch)) return source;
  const currentModes = maybeReplaceOnce(source, CURRENT_INPUT_MODES_MARKER, currentModesPatch);
  if (currentModes !== source) return currentModes;
  const rowAnchor = 'children: [accessSelect, (0, react_jsx_runtime.jsx)(JournalSelect, { locked }), renderSlot("conversation.input.plan", { locked })]';
  const rowPatch = 'children: [accessSelect, (0, react_jsx_runtime.jsx)(JournalSelect, { locked }), (0, react_jsx_runtime.jsx)(ResearchWorkbench, { locked, inputActions, sessionId }), renderSlot("conversation.input.plan", { locked })]';
  if (source.includes(rowPatch)) return source;
  const next = maybeReplaceOnce(source, rowAnchor, rowPatch);
  if (next !== source) return next;
  const newRowAnchor = 'children: [accessSelect, sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]';
  const newRowPatch = 'children: [accessSelect, (0, react_jsx_runtime.jsx)(JournalSelect, { locked }), (0, react_jsx_runtime.jsx)(ResearchWorkbench, { locked, inputActions, sessionId }), sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]';
  const newNext = maybeReplaceOnce(source, newRowAnchor, newRowPatch);
  if (newNext !== source) return newNext;
  const journalNewRowAnchor = 'children: [accessSelect, (0, react_jsx_runtime.jsx)(JournalSelect, { locked }), sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]';
  const journalNewRowPatch = 'children: [accessSelect, (0, react_jsx_runtime.jsx)(JournalSelect, { locked }), (0, react_jsx_runtime.jsx)(ResearchWorkbench, { locked, inputActions, sessionId }), sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]';
  return replaceOnce(source, journalNewRowAnchor, journalNewRowPatch, '论文工作台入口');
}

export function patchJournalSelector() {
  let source = readFileSync(CLIENT_BUNDLE, 'utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  if (source.includes('const InputBar = (0, react.memo)(function InputBar(')
    && (source.includes(CURRENT_INPUT_MODES_MARKER) || source.includes(WORKBENCH_MARKER))) {
    const patched = patchCurrentJournalSelector(patchResearchWorkbench(source, eol), eol);
    if (patched === source) return false;
    writeFileSync(CLIENT_BUNDLE, patched, 'utf8');
    return true;
  }
  if (source.includes(CURRENT_MARKER)) {
    const patched = patchCurrentJournalSelector(patchResearchWorkbench(upgradeJournalStateSync(source, eol), eol), eol);
    if (patched === source) return false;
    writeFileSync(CLIENT_BUNDLE, patched, 'utf8');
    return true;
  }

  if (source.includes(LEGACY_MARKER)) {
    const legacyReader = [
      '\t\tfunction readTargetJournal() {',
      '\t\t\ttry {',
      '\t\t\t\treturn localStorage.getItem(JOURNAL_STORAGE_KEY) ?? "";',
      '\t\t\t} catch {',
      '\t\t\t\treturn "";',
      '\t\t\t}',
      '\t\t}',
    ].join(eol);
    const currentReader = [
      '\t\tfunction readStoredTargetJournal() {',
      '\t\t\ttry {',
      '\t\t\t\treturn globalThis.localStorage?.getItem(JOURNAL_STORAGE_KEY) ?? "";',
      '\t\t\t} catch {',
      '\t\t\t\treturn "";',
      '\t\t\t}',
      '\t\t}',
      '\t\tlet activeTargetJournal = readStoredTargetJournal();',
      '\t\tfunction readTargetJournal() {',
      '\t\t\treturn activeTargetJournal;',
      '\t\t}',
    ].join(eol);
    source = replaceOnce(
      source,
      legacyReader,
      currentReader,
      '期刊状态升级',
    );
    const legacyChange = ['\t\t\t\tconst next = event.target.value;', '\t\t\t\tsetValue(next);'].join(eol);
    const currentChange = ['\t\t\t\tconst next = event.target.value;', '\t\t\t\tactiveTargetJournal = next;', '\t\t\t\tsetValue(next);'].join(eol);
    source = replaceOnce(
      source,
      legacyChange,
      currentChange,
      '期刊状态同步',
    );
    source = patchCurrentJournalSelector(patchResearchWorkbench(source, eol), eol);
    source = upgradeJournalStateSync(source, eol);
    writeFileSync(CLIENT_BUNDLE, source, 'utf8');
    return true;
  }

  const helper = [
    '\t\tconst JOURNAL_STORAGE_KEY = "dsh.paper.targetJournal";',
    '\t\tconst JOURNAL_OPTIONS = [',
    '\t\t\t{ id: "", name: "通用论文（未指定期刊）", description: "不绑定具体期刊，使用通用的证据驱动研究论文结构。" },',
    '\t\t\t{ id: "automation-in-construction", name: "Automation in Construction", impactFactor: "11.5", description: "面向建筑全生命周期自动化、BIM、施工与运维智能化，强调真实工程验证。" },',
    '\t\t\t{ id: "advanced-engineering-informatics", name: "Advanced Engineering Informatics", impactFactor: "9.9", description: "面向知识表示、工程信息学和知识驱动决策，常规算法应用通常不足以构成贡献。" },',
    '\t\t\t{ id: "journal-of-computing-in-civil-engineering", name: "Journal of Computing in Civil Engineering", impactFactor: "5.8", description: "面向土木工程中的计算、人工智能、BIM、传感与机器人应用。" },',
    '\t\t\t{ id: "computer-aided-civil-and-infrastructure-engineering", name: "Computer-Aided Civil and Infrastructure Engineering", impactFactor: "9.1", description: "强调高水平计算方法创新，以及在土木与基础设施中的严格外部验证。" },',
    '\t\t\t{ id: "building-and-environment", name: "Building and Environment", impactFactor: "7.6", description: "面向建筑环境、室内环境质量、HVAC、热舒适与建筑物理研究。" },',
    '\t\t\t{ id: "energy-and-buildings", name: "Energy and Buildings", impactFactor: "8.0", description: "面向建筑能耗、负荷预测、控制优化、减碳及舒适与能耗权衡。" },',
    '\t\t\t{ id: "journal-of-building-engineering", name: "Journal of Building Engineering", impactFactor: "7.4", description: "覆盖建筑工程全生命周期，适合具有明确工程价值的 AI 与 MEP 研究。" },',
    '\t\t\t{ id: "science-and-technology-for-the-built-environment", name: "Science and Technology for the Built Environment", impactFactor: "1.7", description: "ASHRAE 期刊，聚焦 HVAC&R、控制、故障诊断和经过验证的系统仿真。" },',
    '\t\t\t{ id: "building-services-engineering-research-and-technology", name: "Building Services Engineering Research and Technology", impactFactor: "1.8", description: "CIBSE 相关期刊，聚焦建筑服务工程、HVAC、供配电、给排水与工程实践。" },',
    '\t\t\t{ id: "engineering-applications-of-artificial-intelligence", name: "Engineering Applications of Artificial Intelligence", impactFactor: "9.0", description: "要求人工智能方法创新与真实工程应用两方面都具有充分贡献。" },',
    '\t\t\t{ id: "ieee-transactions-on-automation-science-and-engineering", name: "IEEE Transactions on Automation Science and Engineering", impactFactor: "7.9", description: "面向自动化科学的理论、算法、系统方法与实际工程部署。" },',
    '\t\t\t{ id: "expert-systems-with-applications", name: "Expert Systems with Applications", impactFactor: "7.5", description: "面向专家系统、智能决策和可解释 AI 应用，避免单纯模型对比。" }',
    '\t\t];',
    '\t\tfunction readStoredTargetJournal() {',
    '\t\t\ttry {',
    '\t\t\t\treturn globalThis.localStorage?.getItem(JOURNAL_STORAGE_KEY) ?? "";',
    '\t\t\t} catch {',
    '\t\t\t\treturn "";',
    '\t\t\t}',
    '\t\t}',
    '\t\tlet activeTargetJournal = readStoredTargetJournal();',
    '\t\tfunction readTargetJournal() {',
    '\t\t\treturn activeTargetJournal;',
    '\t\t}',
    '\t\tfunction journalizeDraft(draft) {',
    '\t\t\tconst journal = JOURNAL_OPTIONS.find((item) => item.id === readTargetJournal());',
    '\t\t\tif (journal === void 0 || journal.id === "") return draft;',
    '\t\t\tif (/^\\s*\\/paper(?:\\s|$)/i.test(draft)) {',
    '\t\t\t\tif (/(?:^|\\s)--journal(?:\\s+|=)/i.test(draft)) return draft;',
    '\t\t\t\treturn `${draft} --journal ${journal.id}`;',
    '\t\t\t}',
    '\t\t\tconst instruction = `[目标期刊：${journal.name}；期刊 ID：${journal.id}。写作前必须加载 journal-${journal.id} skill，并从大纲阶段开始遵守该刊范围、结构、证据、声明和格式要求，不要在正文完成后才改格式。]`;',
    '\t\t\tif (/^\\[目标期刊：[^\\n]+\\]\\n?/.test(draft)) return draft.replace(/^\\[目标期刊：[^\\n]+\\]\\n?/, `${instruction}\\n`);',
    '\t\t\treturn `${instruction}\\n${draft}`;',
    '\t\t}',
    '\t\tfunction JournalSelect({ locked }) {',
    '\t\t\tconst [value, setValue] = (0, react.useState)(readTargetJournal);',
    '\t\t\tconst selected = JOURNAL_OPTIONS.find((journal) => journal.id === value);',
    '\t\t\tconst change = (event) => {',
    '\t\t\t\tconst next = event.target.value;',
    '\t\t\t\tactiveTargetJournal = next;',
    '\t\t\t\tsetValue(next);',
    '\t\t\t\ttry {',
    '\t\t\t\t\tglobalThis.localStorage?.setItem(JOURNAL_STORAGE_KEY, next);',
    '\t\t\t\t} catch {}',
    '\t\t\t};',
    '\t\t\treturn (0, react_jsx_runtime.jsx)("select", {',
    '\t\t\t\tclassName: InputBar_module_css_default.select,',
    '\t\t\t\tvalue,',
    '\t\t\t\tdisabled: locked,',
    '\t\t\t\t"aria-label": "目标期刊",',
    '\t\t\t\ttitle: selected?.description ?? "写作前选择目标期刊",',
    '\t\t\t\tonChange: change,',
    '\t\t\t\tchildren: JOURNAL_OPTIONS.map((journal) => (0, react_jsx_runtime.jsx)("option", { value: journal.id, title: journal.description, children: journal.impactFactor ? `${journal.name}（IF：${journal.impactFactor}）` : journal.name }, journal.id || "general"))',
    '\t\t\t});',
    '\t\t}',
    '',
  ].join(eol);

  const componentAnchor = '\t\t//#region lib/types/client/skeleton/InputBar.js';
  source = replaceOnce(source, componentAnchor, `${helper}${componentAnchor}`, '期刊组件');

  const submitAnchor = '\t\t\t\tconst before = this.snapshot;';
  const submitPatch = [
    '\t\t\t\tconst preparedDraft = journalizeDraft(this.snapshot.draft);',
    '\t\t\t\tif (preparedDraft !== this.snapshot.draft) this.setDraft(preparedDraft);',
    submitAnchor,
  ].join(eol);
  source = replaceOnce(source, submitAnchor, submitPatch, '提交注入');

  const rowAnchor = 'children: [accessSelect, renderSlot("conversation.input.plan", { locked })]';
  const rowPatch = 'children: [accessSelect, (0, react_jsx_runtime.jsx)(JournalSelect, { locked }), renderSlot("conversation.input.plan", { locked })]';
  const newRowAnchor = 'children: [accessSelect, sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]';
  const newRowPatch = 'children: [accessSelect, (0, react_jsx_runtime.jsx)(JournalSelect, { locked }), sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]';
  const withLegacyRow = maybeReplaceOnce(source, rowAnchor, rowPatch);
  source = withLegacyRow === source ? replaceOnce(source, newRowAnchor, newRowPatch, '输入栏菜单') : withLegacyRow;

  source = patchCurrentJournalSelector(patchResearchWorkbench(source, eol), eol);
  source = upgradeJournalStateSync(source, eol);
  writeFileSync(CLIENT_BUNDLE, source, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changed = patchJournalSelector();
  console.log(changed ? 'DSH 期刊选择器已安装。' : 'DSH 期刊选择器已存在。');
}
