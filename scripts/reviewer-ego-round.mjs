import { readFileSync, writeFileSync } from 'node:fs';

/** Run inside ego-browser nodejs, using its documented global helpers only. */
export async function runEgoRound(payloadPath) {
  const input = JSON.parse(readFileSync(payloadPath, 'utf8'));
  let task;
  try {
    task = input.resume ? await takeOverTaskSpace(input.spaceId)
      : await taskSpace(input.spaceId || input.spaceName);
    const page = task.page(input.page || 'p1');
    if (input.operation === 'open') await page.goto(input.url);
    if (input.operation === 'handoff') {
      await task.handOff();
      return output(input, { spaceId: task.spaceId, page: page.label, handedOff: true });
    }
    if (input.operation === 'finish') {
      await task.finish({ keep: input.keepPage ? [page.label] : [] });
      return output(input, { closed: true });
    }
    if (input.operation === 'fill') return output(input, await fillReplies(page, input));
    if (input.operation === 'upload') {
      await page.evaluate(({ url, selector }) => {
        if (location.href !== url || document.querySelectorAll(selector).length !== 1 || !document.querySelector(selector).matches('input[type="file"]')) throw new Error('上传页面或目标已变化，请重新读取');
      }, { url: input.url, selector: input.selector });
      await page.setInputFiles(input.selector, [input.file]);
      const uploaded = await page.evaluate(selector => [...document.querySelector(selector).files].map(f => f.name), input.selector);
      return output(input, { uploaded, submitted: false });
    }
    const snapshot = await inspectPage(page, input.selector || 'main, [role="main"], article');
    output(input, { ...snapshot, spaceId: task.spaceId, page: page.label, handedOff: false });
  } catch (error) {
    output(input, { error: readableError(error), spaceId: task?.spaceId || input.spaceId });
  }
}

/** Keep the actionable cause, rather than the SDK's evaluated-function source and stack. */
function readableError(error) {
  const message = String(error.message || error);
  return (message.match(/\bError: ([^\r\n]+)/)?.[1] || message.split(/\r?\n/)[0]).slice(0, 600);
}

/** Persist only a bounded task result, never cookies, headers, browser storage or CLI diagnostics. */
function output(input, result) { writeFileSync(input.resultPath, JSON.stringify(result), 'utf8'); }

/** Extract visible review text and editable response candidates; no automatic portal-specific guessing. */
async function inspectPage(page, selector) {
  return page.evaluate(({ selector }) => {
    const visible = el => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
    const regions = [...document.querySelectorAll(selector)].filter(visible);
    if (regions.length !== 1) throw new Error('意见区域需唯一匹配；请在工作台填写明确的 CSS 选择器');
    const region = regions[0];
    if (region.innerText.length > 150000) throw new Error('意见区域超过 15 万字，请选择更具体的审稿意见区域，不能截断导入');
    const fields = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')]
      .filter(el => visible(el) && !el.disabled && !el.readOnly && !el.parentElement.closest('[contenteditable="true"]')).slice(0, 100).map((el, index) => {
        const key = `response-${index}`;
        el.setAttribute('data-dsh-review-target', key);
        const identityLabel = el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.name || el.id || '';
        const label = identityLabel || `回复框 ${index + 1}`;
        return { key, selector: `[data-dsh-review-target="${key}"]`, label: label.slice(0, 300), identityLabel,
          value: el.isContentEditable ? el.innerText : el.value };
      });
    const uploads = [...document.querySelectorAll('input[type="file"]')].filter(el => !el.disabled).slice(0, 20).map((el, index) => {
      const key = `upload-${index}`; el.setAttribute('data-dsh-review-upload', key);
      return { key, selector: `[data-dsh-review-upload="${key}"]`, label: el.labels?.[0]?.innerText || el.name || el.id || key, accept: el.accept };
    });
    return { url: location.href, title: document.title.slice(0, 300), source: region.innerText.slice(0, 150000), fields, uploads };
  }, { selector });
}

/** Preflight every field before any write, then fill and verify, without clicking submit/save/upload. */
async function fillReplies(page, input) {
  const preflight = await page.evaluate(({ url, mappings }) => {
    if (location.href !== url) throw new Error('投稿页面已变化，请重新读取并确认映射');
    return mappings.map(row => {
      const nodes = document.querySelectorAll(row.selector);
      const node = nodes[0];
      if (nodes.length !== 1 || !node.matches('textarea, input[type="text"], [contenteditable="true"]')
        || !node.getClientRects().length || node.disabled || node.readOnly) throw new Error(`回复框不可用：${row.id}`);
      const value = node.isContentEditable ? node.innerText : node.value;
      if (value !== row.expectedValue) throw new Error(`回复框已被编辑，请重新读取：${row.id}`);
      const label = node.labels?.[0]?.innerText || node.getAttribute('aria-label') || node.name || node.id || '';
      if (row.expectedLabel !== undefined && label !== row.expectedLabel) throw new Error(`回复框标签已变化，请重新核对：${row.id}`);
      return row.id;
    });
  }, { url: input.url, mappings: input.mappings });
  const filled = [];
  try {
    for (const row of input.mappings) {
      await page.fill(row.selector, row.response);
      const actual = await page.evaluate(selector => {
        const node = document.querySelector(selector);
        return node.isContentEditable ? node.innerText : node.value;
      }, row.selector);
      if (actual !== row.response) throw new Error(`填入后内容核对失败：${row.id}`);
      filled.push(row.id);
    }
    return { filled, preflight, submitted: false };
  } catch (error) {
    return { filled, submitted: false, error: `部分填写已完成，请核对页面，勿盲目重试：${readableError(error)}` };
  }
}
