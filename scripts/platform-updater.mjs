import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_REPO, MANIFEST_ASSET, compareVersions, readUpdateJson,
  releaseAssetUrl, validateUpdateManifest, writeUpdateJson } from './platform-update-files.mjs';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Bound both unknown Content-Length responses and normal downloads. */
async function responseBytes(response, maximum) {
  if (!response.ok) throw new Error(`更新服务返回 HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('更新资源超过大小限制');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('更新资源超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Download in the existing network environment; never set proxies, DNS or TLS flags. */
async function fetchJson(fetchImpl, url, maximum = 256 * 1024) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/vnd.github+json' } });
  return JSON.parse((await responseBytes(response, maximum)).toString('utf8'));
}

/** Detect and cache reviewed releases; installation only happens on a stopped-host launch. */
export class PlatformUpdater {
  constructor({ projectRoot, stateRoot, busy = () => false, fetchImpl = fetch, env = process.env }) {
    this.projectRoot = projectRoot;
    this.directory = join(stateRoot, 'platform-updates');
    this.statePath = join(this.directory, 'status.json');
    this.pendingPath = join(this.directory, 'pending.json');
    this.fetch = fetchImpl;
    this.busy = busy;
    this.enabled = env.DSH_AUTO_UPDATE !== 'false';
    this.current = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version;
    this.state = { ...readUpdateJson(this.statePath), currentVersion: this.current,
      automatic: this.enabled };
    if (!/^\d+\.\d+\.\d+$/.test(this.state.latestVersion || '')) delete this.state.latestVersion;
    if (this.state.latestVersion && compareVersions(this.state.latestVersion, this.current) <= 0) {
      this.state.status = 'current';
    }
  }

  snapshot() {
    return { ...this.state, busy: this.busy(), releaseUrl: this.state.releaseUrl
      || `https://github.com/${PLATFORM_REPO}/releases` };
  }

  save(values) {
    Object.assign(this.state, values);
    writeUpdateJson(this.statePath, this.state);
    return this.snapshot();
  }

  /** One check in flight; cached checks and offline failures cannot delay startup. */
  async check(force = false) {
    if (this.operation) return this.operation;
    if (!force && Date.now() - Number(this.state.checkedAt || 0) < CHECK_INTERVAL_MS) return this.snapshot();
    this.operation = this.discover().catch(error => this.save({ status: 'check-failed',
      message: error.message })).finally(() => { this.operation = undefined; });
    return this.operation;
  }

  async discover() {
    this.save({ status: 'checking', checkedAt: Date.now(), message: '正在检查小贾发行版' });
    const release = await fetchJson(this.fetch, `https://api.github.com/repos/${PLATFORM_REPO}/releases/latest`);
    if (release.draft || release.prerelease) throw new Error('忽略未正式发布的版本');
    const tag = release.tag_name;
    const newer = compareVersions(tag, this.current) > 0;
    this.save({ latestVersion: tag.replace(/^v/, ''), releaseUrl: `https://github.com/${PLATFORM_REPO}/releases/tag/${tag}` });
    if (!newer) return this.save({ status: 'current', message: '已是当前小贾发行版' });
    const asset = release.assets?.find(item => item.name === MANIFEST_ASSET);
    if (!asset) return this.save({ status: 'manual', message: '新版尚无已验证更新包，请从发行页面下载' });
    const url = releaseAssetUrl(asset.browser_download_url, tag, MANIFEST_ASSET);
    this.manifest = validateUpdateManifest(await fetchJson(this.fetch, url), tag);
    this.source = release.assets.find(item => item.name === this.manifest.asset.name);
    if (!this.source) throw new Error('发行版更新包尚未上传完成');
    releaseAssetUrl(this.source.browser_download_url, tag, this.source.name);
    this.save({ status: 'available', message: `发现小贾 ${this.manifest.version}` });
    return this.enabled ? this.stage() : this.snapshot();
  }

  /** Store only verified bytes outside the project and leave a pending install record. */
  async stage() {
    if (!this.manifest || !this.source) return this.check(true);
    const { manifest } = this;
    const pending = readUpdateJson(this.pendingPath);
    if (pending?.manifest?.asset.sha256 === manifest.asset.sha256) {
      try {
        const bytes = readFileSync(pending.archive);
        if (createHash('sha256').update(bytes).digest('hex') === manifest.asset.sha256) {
          return this.save({ status: 'ready', message: '更新包已校验，下次启动自动安装；当前任务不中断' });
        }
      } catch { /* A missing cached archive is downloaded again. */ }
    }
    this.save({ status: 'downloading', message: '正在下载并校验更新包' });
    const response = await this.fetch(this.source.browser_download_url, { signal: AbortSignal.timeout(120000) });
    const bytes = await responseBytes(response, 50 * 1024 * 1024);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.asset.sha256) throw new Error('更新包校验失败，现有安装未改变');
    mkdirSync(this.directory, { recursive: true });
    const archive = join(this.directory, manifest.asset.name);
    writeFileSync(archive, bytes);
    writeUpdateJson(this.pendingPath, { projectRoot: this.projectRoot, archive, manifest });
    return this.save({ status: 'ready', message: '更新包已校验，下次启动自动安装；当前任务不中断' });
  }

  /** Explicit downloads are serialized with scheduled checks, including when auto-download is off. */
  async download() {
    if (this.operation) await this.operation;
    if (!this.manifest || !this.source) await this.check(true);
    if (!this.manifest || !this.source || this.state.status === 'ready') return this.snapshot();
    this.operation = this.stage().catch(error => this.save({ status: 'check-failed',
      message: error.message })).finally(() => { this.operation = undefined; });
    return this.operation;
  }

  start() {
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, CHECK_INTERVAL_MS);
    this.timer.unref();
    return () => clearInterval(this.timer);
  }
}
