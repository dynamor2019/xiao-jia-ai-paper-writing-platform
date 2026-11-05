(() => {
  if (window.xiaoJiaPlatformUpdates) return;
  window.xiaoJiaPlatformUpdates = true;
  const holder = document.createElement('div');
  holder.id = 'xiaojia-platform-version';
  holder.style.cssText = 'padding:4px 12px;font:12px system-ui;flex-shrink:0';
  const button = document.createElement('button');
  button.style.cssText = 'width:100%;text-align:left;background:transparent;border:0;color:inherit;cursor:pointer;padding:5px 0';
  button.textContent = '小贾 · 检查更新';
  holder.append(button);
  const panel = document.createElement('dialog');
  panel.style.cssText = 'max-width:480px;width:85%;padding:24px;border:1px solid #b8c3d1;border-radius:12px;color:inherit;background:Canvas';
  const title = document.createElement('h3');
  title.textContent = '小贾平台更新';
  const details = document.createElement('p');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const check = document.createElement('button');
  check.textContent = '检查新版本';
  const download = document.createElement('button');
  download.textContent = '下载更新';
  const release = document.createElement('a');
  release.textContent = '发行说明';
  release.target = '_blank';
  release.rel = 'noopener noreferrer';
  const close = document.createElement('button');
  close.textContent = '关闭';
  for (const control of [check, download, release, close]) control.style.marginRight = '12px';
  panel.append(title, details, status, check, download, release, close);
  let state = {};

  function render() {
    const current = state.currentVersion || '…';
    const suffix = state.status === 'ready' ? `更新已下载 ${state.latestVersion}`
      : ['available', 'manual', 'downloading'].includes(state.status) ? `发现新版 ${state.latestVersion}` : '检查更新';
    button.textContent = `小贾 v${current} · ${suffix}`;
    button.title = state.message || '自动检查经过验证的小贾发行版';
    details.textContent = `当前版本：${current}；最新版本：${state.latestVersion || '待检查'}。自动下载${state.automatic ? '已开启' : '已关闭'}。`;
    status.textContent = state.message || '启动后自动检查，不影响论文任务。';
    release.href = state.releaseUrl || 'https://github.com/dynamor2019/xiao-jia-ai-paper-writing-platform/releases';
    download.disabled = !['available', 'check-failed'].includes(state.status);
  }

  async function request(action) {
    check.disabled = true;
    try {
      const response = await fetch(`/dsh-platform-update/${action}`, {
        method: action === 'status' ? 'GET' : 'POST', credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`更新检查失败 (${response.status})`);
      state = await response.json();
      render();
    } catch (error) {
      status.textContent = error.message;
    } finally { check.disabled = false; }
  }

  function mount() {
    const account = document.querySelector('button[aria-label="账号菜单"]');
    if (account && !holder.isConnected) account.parentNode.insertBefore(holder, account);
    if (document.body && !panel.isConnected) document.body.append(panel);
  }

  button.addEventListener('click', () => { panel.showModal(); void request('status'); });
  close.addEventListener('click', () => panel.close());
  check.addEventListener('click', () => { void request('check'); });
  download.addEventListener('click', () => { void request('download'); });
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  mount();
  void request('status');
  setInterval(() => { void request('status'); }, 30000);
})();
