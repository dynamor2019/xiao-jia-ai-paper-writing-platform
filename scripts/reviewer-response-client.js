const $ = id => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('sessionId');
let data, selected, dirty = false, busy = false, polling;
const labels = {
  type: { misunderstanding: '误解', clarity_problem: '表达不清', evidence_gap: '证据缺口', scope_mismatch: '范围不符', incorrect_premise: '前提错误', high_risk: '核心主张挑战' },
  severity: { blocking: '阻断', major: '主要', minor: '次要', unclear: '待澄清' },
  action: { revise: '接受并修改', clarify: '澄清', disagree: '有据不同意', limitation: '明确保留局限', 'request-clarification': '请求澄清' },
};

/** Report compact user-visible results without silently losing edits. */
function notice(text, error = false) { $('notice').textContent = text; $('notice').dataset.error = error; }

/** Use only the same-origin reviewer endpoint, never a model API. */
async function request(body) {
  const response = await fetch(`/dsh-paper-reviews?sessionId=${encodeURIComponent(sessionId || '')}`, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, revision: data?.state.revision, ...body }),
  } : { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) {
    $('project-binding').hidden = !result.needsProject;
    const error = new Error(result.error || `HTTP ${response.status}`);
    error.needsProject = result.needsProject === true;
    throw error;
  }
  return result;
}

/** Bind a bounded UI action with consistent errors and no automatic paid/model retries. */
function bind(id, handler) {
  $(id).addEventListener('click', async () => {
    if (busy) return;
    busy = true; $(id).disabled = true;
    try {
      if (dirty && ['save-manuscript', 'import-comments', 'import-portal', 'new-round'].includes(id)) throw new Error('请先保存当前回复，避免丢失未保存编辑');
      await handler();
    } catch (e) { notice(e.message, !e.needsProject); }
    finally { busy = false; $(id).disabled = false; }
  });
}

/** Render strings only as text nodes, including hostile imported comments and portal HTML. */
function node(tag, text, props = {}) { const el = document.createElement(tag); el.textContent = text; Object.assign(el, props); return el; }

/** Refresh only on request or during an actual Ego operation. */
async function refresh() {
  if (dirty && !confirm('尚有未保存回复，刷新会放弃这些编辑。继续？')) return;
  data = await request(); dirty = false; render();
}

/** Render the current record and real gate state; no client-side PASS toggle. */
function render() {
  $('project-binding').hidden = true;
  $('project').textContent = data.project;
  $('manuscript').value = data.state.manuscript;
  $('downloads').replaceChildren();
  const total = data.state.comments.length, approved = data.gate.items.filter(i => i.approved).length;
  selected ||= data.state.comments[0]?.id;
  $('coverage').textContent = `${total} 条意见 · 作者已确认且证据仍有效 ${approved} 条 · 记录版本 ${data.state.revision}`;
  $('comments').replaceChildren(...data.state.comments.map(item => {
    const check = data.gate.items.find(c => c.id === item.id);
    const button = node('button', `${item.id} ${check.approved ? '✓' : item.response ? '待核对' : '待回复'}`);
    button.type = 'button'; button.setAttribute('aria-current', item.id === selected ? 'true' : 'false');
    button.onclick = () => { if (!dirty || confirm('放弃未保存编辑？')) { selected = item.id; dirty = false; render(); } };
    return button;
  }));
  renderEditor(); renderBrowser();
  notice(total ? `${data.gate.ready ? '回复已具备可追溯交付条件' : '请逐条完善回复并核对实际证据'}；未提交期刊。` : '请指定当前修改稿并导入审稿意见。');
}

/** Keep the unaltered source visible alongside the editable response. */
function renderEditor() {
  const item = data.state.comments.find(c => c.id === selected);
  $('editor').hidden = !item;
  if (!item) return;
  $('item-id').textContent = item.id; $('comment').textContent = item.comment;
  for (const key of ['type', 'severity', 'action']) $(key).value = item[key];
  for (const [id, key] of [['reply', 'response'], ['location', 'location'], ['rationale', 'rationale']]) $(id).value = item[key] || '';
  $('evidence').replaceChildren();
  for (const evidence of item.evidence) addEvidence(evidence);
  $('author-confirm').checked = false;
  const gate = data.gate.items.find(c => c.id === item.id);
  $('item-errors').textContent = gate.errors.join('；') || (gate.approved ? '作者已确认，证据有效' : '证据文本存在，仍需作者确认其科学充分性');
}

/** Add one human-readable file/quote pair. */
function addEvidence(evidence = {}) {
  const row = node('div', '', { className: 'evidence' });
  const file = node('input', '', { type: 'text', value: evidence.file || '', placeholder: '证据文件（项目内相对路径）', ariaLabel: '证据文件' });
  const quote = node('textarea', '', { value: evidence.quote || '', placeholder: '从实际稿件或证据文件复制的原文', ariaLabel: '证据原文' });
  const remove = node('button', '移除此证据'); remove.onclick = () => { row.remove(); dirty = true; };
  row.append(file, quote, remove); $('evidence').append(row);
}

/** Save through revision checks; approval is a separate explicit author action. */
async function save(approve = false) {
  if (approve && !$('author-confirm').checked) throw new Error('请先勾选作者核对声明');
  const patch = Object.fromEntries(['type', 'severity', 'action', 'location', 'rationale'].map(k => [k, $(k).value]));
  patch.response = $('reply').value;
  patch.evidence = [...$('evidence').children].map(row => ({ file: row.querySelector('input').value, quote: row.querySelector('textarea').value }));
  data = await request({ action: 'edit', id: selected, patch }); dirty = false;
  if (approve) data = await request({ action: 'approve', id: selected, confirmed: true });
  render();
}

/** Render exact browser field mappings and visible operation receipts. */
function renderBrowser() {
  const browser = data.state.browser || {}, job = data.job.status === 'idle' ? data.state.lastBrowserJob || data.job : data.job;
  const completed = job.operation === 'fill' && job.status === 'completed' ? `已核对填入 ${job.filled?.length || 0} 条回复，未提交。`
    : job.operation === 'upload' && job.status === 'completed' ? `文件已选入页面：${(job.uploaded || []).join('、')}。请核对网站上传状态，未提交返修。` : '';
  $('browser-job').textContent = job.status === 'running' ? `正在执行 ${job.operation}，请等待当前任务…` : job.error || completed || (browser.handedOff ? '请在 Ego 中登录或处理验证码，完成后点击继续读取。' : browser.url || '尚未打开投稿页面');
  if (!$('portal').value && browser.url) $('portal').value = browser.url;
  $('portal-source').value = browser.source || '';
  const rows = [{ id: 'all', response: '将完整逐条回复信填入一个回复框（包括意见、回复、位置和证据）。' }, ...data.state.comments];
  $('mappings').replaceChildren(...rows.map(item => {
    const row = node('div', '', { className: 'mapping' });
    const select = document.createElement('select'); select.dataset.commentId = item.id; select.ariaLabel = `${item.id} 对应回复框`;
    select.append(node('option', '不填入', { value: '' }), ...(browser.fields || []).map(f => node('option', `${f.label}（当前 ${f.value.length} 字）`, { value: f.key })));
    row.append(node('strong', item.id), document.createElement('br'), select, node('pre', item.response || '尚无回复'));
    return row;
  }));
  $('fill-confirm').checked = false;
  $('upload-confirm').checked = false;
  $('upload-field').replaceChildren(node('option', '请选择上传框', { value: '' }), ...(browser.uploads || []).map(f => node('option', `${f.label} ${f.accept || ''}`, { value: f.key })));
  clearTimeout(polling);
  if (job.status === 'running') polling = setTimeout(async () => {
    try { const next = await request(); if (dirty) { data.job = next.job; $('browser-job').textContent = next.job.error || `Ego ${next.job.status}；保存编辑后刷新页面读取结果`; }
      else { data = next; renderBrowser(); } } catch (e) { notice(e.message, true); }
  }, 1500);
}

/** Start one browser action and observe its receipt; no retry on uncertain writes. */
async function browser(operation, extra = {}) {
  if (dirty) throw new Error('请先保存回复再操作浏览器');
  await request({ action: 'browser', operation, url: $('portal').value, selector: $('region').value, ...extra });
  data = await request(); renderBrowser();
}

/** Export the current confirmed round and expose fixed session-bound downloads. */
async function exportFiles(docx) {
  if (dirty) throw new Error('请先保存回复');
  data = await request({ action: 'export', docx }); render();
  $('downloads').replaceChildren(...data.exported.map(file => {
    const name = file.split('/').pop();
    return node('a', `${name}　`, { href: `/dsh-paper-reviews/download?sessionId=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(name)}`, download: name });
  }));
}

for (const [key, values] of Object.entries(labels)) $(key).append(...Object.entries(values).map(([value, label]) => node('option', label, { value })));
document.querySelectorAll('#editor input, #editor textarea, #editor select').forEach(el => el.addEventListener('input', () => { dirty = true; }));
$('evidence').addEventListener('input', () => { dirty = true; });
bind('tab-response', () => { $('response').hidden = false; $('browser').hidden = true; });
bind('tab-browser', () => { $('response').hidden = true; $('browser').hidden = false; });
bind('refresh', refresh);
bind('bind-project', async () => {
  if (!$('binding-confirm').checked) throw new Error('请先确认这是本会话要返修的论文目录');
  data = await request({ action: 'bind-project', project: $('existing-project').value, confirmed: true }); render();
});
bind('save-manuscript', async () => { data = await request({ action: 'manuscript', manuscript: $('manuscript').value }); render(); });
bind('import-comments', async () => { data = await request({ action: 'import', source: $('source').value, reviewer: $('reviewer').value }); $('source').value = ''; render(); });
bind('import-portal', async () => { data = await request({ action: 'import', source: $('portal-source').value, reviewer: $('portal-reviewer').value }); render(); });
bind('add-evidence', () => { addEvidence(); dirty = true; });
bind('save-reply', () => save()); bind('approve', () => save(true)); bind('check', refresh);
bind('draft', async () => {
  if (dirty) throw new Error('请先保存回复');
  if (parent === window) throw new Error('请在论文工作台内打开此面板，才能把任务交给当前 DSH 助手');
  const result = await request({ action: 'draft' });
  parent.postMessage({ type: 'dsh-reviewer-draft', sessionId, task: result.task }, location.origin);
  notice('已交给当前 DSH 会话；助手保存回复后点击刷新查看。');
});
bind('export', () => exportFiles(false)); bind('export-docx', () => exportFiles(true));
bind('new-round', async () => { if (confirm('本轮意见及回复将完整归存，建立空白新轮次。继续？')) { data = await request({ action: 'new-round', confirmed: true }); selected = undefined; render(); } });
bind('open-portal', () => browser('open')); bind('read-portal', () => browser('read'));
bind('handoff', () => browser('handoff')); bind('resume-browser', () => browser('resume'));
bind('finish-browser', () => browser('handoff'));
bind('upload-portal', () => {
  if (!$('upload-confirm').checked) throw new Error('请先确认上传授权');
  return browser('upload', { confirmed: true, key: $('upload-field').value, file: $('upload-file').value });
});
bind('fill-portal', () => {
  if (!$('fill-confirm').checked) throw new Error('请先确认回复框映射和填写授权');
  const mappings = [...document.querySelectorAll('#mappings select')].filter(el => el.value).map(el => ({ id: el.dataset.commentId, key: el.value }));
  return browser('fill', { mappings, confirmed: true });
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('message', e => {
  if (e.origin === location.origin && e.source === parent && e.data?.type === 'dsh-reviewer-draft-result') notice(e.data.error || 'DSH 已接收返修任务', Boolean(e.data.error));
});
refresh().catch(e => notice(e.message, !e.needsProject));
