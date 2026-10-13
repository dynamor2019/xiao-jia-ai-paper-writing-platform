import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 移除欢迎页 hero 区的「预览版」徽标。
 *
 * 该徽标是 dsh-client-ui-conversation 里硬编码渲染的
 * `<span class="...previewBadge">{t("hero.preview")}</span>`，
 * 没有任何关闭入口，也不响应任何设置项——所以界面上关不掉。
 * 它和 "探索未至之境" 标题同属一个 titleGroup，移除徽标后标题仍居中。
 */
const CLIENT_BUNDLE = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-conversation',
  'lib',
  'client.js',
);

/** 匹配 titleGroup 内那对 span（含可能的换行与缩进差异）。 */
const BADGE_PATTERN =
  /, \(0, react_jsx_runtime\.jsx\)\("span", \{\s*\r?\n\s*className: HeroShell_module_css_default\.previewBadge,\s*\r?\n\s*children: t\("hero\.preview"\)\s*\r?\n\s*\}\)/u;

export function patchDshPreviewBadge() {
  if (!existsSync(CLIENT_BUNDLE)) return false;

  const original = readFileSync(CLIENT_BUNDLE, 'utf8');

  if (!original.includes('HeroShell_module_css_default.previewBadge')) return false;

  const patched = original.replace(BADGE_PATTERN, '');
  if (patched === original) {
    throw new Error('previewBadge 结构已变化，无法安全移除预览版徽标');
  }

  writeFileSync(CLIENT_BUNDLE, patched, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(patchDshPreviewBadge() ? '预览版徽标已移除。' : '无需移除（未找到徽标或已移除）。');
}
