import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PLATFORM_REPO = 'dynamor2019/xiao-jia-ai-paper-writing-platform';
export const MANIFEST_ASSET = 'xiaojia-update.json';
const ROOT_FILES = new Set(['package.json', 'package-lock.json', 'README.md', 'LICENSE',
  '.gitignore', '.gitattributes', '.env.example', 'tsconfig.json', 'requirements.txt', 'setup-dsh.bat', 'start-dsh.ps1',
  '一键启动小贾AI.bat', '桌面端启动小贾AI.bat']);

/** Compare stable platform releases, independently of upstream Harness releases. */
export function compareVersions(left, right) {
  const parse = value => {
    if (!/^v?\d+\.\d+\.\d+$/.test(value)) throw new Error('不是稳定版本号');
    return value.replace(/^v/, '').split('.').map(Number);
  };
  const a = parse(left), b = parse(right);
  return a.map((part, i) => Math.sign(part - b[i])).find(Boolean) || 0;
}

/** Never allow an update archive to own user data, credentials or dependencies. */
export function productPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(':')
    || path.split('/').some(part => !part || part === '.' || part === '..')
    || /(?:^|\/)(?:\.env|\.credentials[^/]*|auth\.json|node_modules)(?:\/|$)/i.test(path)
    || /(?:\.bak|\.pyc|\.log)$|(?:^|\/)__pycache__(?:\/|$)/i.test(path)) return false;
  return ROOT_FILES.has(path) || /^(?:scripts|src|dist|docs|electron|knowledge-base|config)\//.test(path)
    || path.startsWith('.dsh/skills/') || path.startsWith('.github/workflows/');
}

/** Pin download ownership to this repository and one exact stable release. */
export function releaseAssetUrl(url, tag, name) {
  const expected = `https://github.com/${PLATFORM_REPO}/releases/download/${tag}/${name}`;
  if (url !== expected) throw new Error('更新资源不属于指定发行版');
  return url;
}

/** Validate every path and digest before an archive is downloaded or extracted. */
export function validateUpdateManifest(manifest, tag) {
  compareVersions(tag, '0.0.0');
  if (manifest?.format !== 1 || manifest.version !== tag.replace(/^v/, '')
    || manifest.repository !== PLATFORM_REPO || !manifest.files || Array.isArray(manifest.files)
    || !manifest.files['package.json'] || Object.keys(manifest.files).length > 3000) {
    throw new Error('更新清单格式不兼容');
  }
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!productPath(path) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`更新文件不安全: ${path}`);
  }
  if (manifest.asset?.name !== `XiaoJiaAI-Source-${tag}.zip`
    || !/^[a-f0-9]{64}$/.test(manifest.asset?.sha256 || '')) throw new Error('更新包缺少有效校验值');
  return manifest;
}

/** Persist one bounded state file with an atomic replacement. */
export function writeUpdateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

export function readUpdateJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

export function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Refuse a target outside the explicitly named installation. */
export function updateFile(root, path) {
  if (!productPath(path)) throw new Error(`禁止更新此路径: ${path}`);
  return resolve(join(root, path));
}
