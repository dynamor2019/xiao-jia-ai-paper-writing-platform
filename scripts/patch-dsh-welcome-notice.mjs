import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 关闭启动时的「预览版说明」欢迎弹窗（WelcomeNotice / OnboardingModal）。
 *
 * 该弹窗每次启动都要求确认，并把确认状态写进 `ui-settings-general`
 * 命名空间的 `welcomeNoticeVersion` 字段。若该 settings scope 不可写
 * （本机profile 的 cordis.patch.yml 只声明了自定义插件，没有
 * `ui-settings-general` 条目），写入后回读校验失败，于是每次点「继续」
 * 都报 `暂时无法保存确认状态` 并重新弹窗——即用户遇到的「关不掉」。
 *
 * 这里直接让组件渲染为空：不依赖任何存储写入，因此 scope 是否可写
 * 都不影响，比「想办法把确认状态写进去」更稳。
 */
const CLIENT_BUNDLE = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-models',
  'lib',
  'client.js',
);

/** 组件函数签名 + 解构 props 的那一行。 */
const COMPONENT_HEAD =
  'function WelcomeNotice(props) {\n\t\t\tconst { complete, controller, useWelcome, t } = props;';

const COMPONENT_HEAD_PATCHED =
  'function WelcomeNotice(props) {\n\t\t\t// 小贾AI：预览版说明弹窗不再展示（确认状态在无 ui-settings-general 条目时无法持久化）。\n\t\t\treturn null;\n\t\t\tconst { complete, controller, useWelcome, t } = props;';

export function patchDshWelcomeNotice() {
  if (!existsSync(CLIENT_BUNDLE)) return false;

  const original = readFileSync(CLIENT_BUNDLE, 'utf8');

  if (original.includes('小贾AI：预览版说明弹窗不再展示')) return false;
  if (!original.includes(COMPONENT_HEAD)) {
    throw new Error('WelcomeNotice 结构已变化，无法安全关闭预览版说明弹窗');
  }

  const patched = original.replace(COMPONENT_HEAD, COMPONENT_HEAD_PATCHED);
  if (patched === original) return false;

  writeFileSync(CLIENT_BUNDLE, patched, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(patchDshWelcomeNotice() ? '预览版说明弹窗已关闭。' : '无需处理（已关闭或未找到）。');
}