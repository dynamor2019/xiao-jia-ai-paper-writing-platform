import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENT_BUNDLE = join(
  process.cwd(),
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-brand-official',
  'lib',
  'client.js',
);
const LOGO_PATH = resolve(process.cwd(), 'config', 'dsh', 'assets', 'xiaojia-logo.png');
const PLATFORM_NAME = '小贾AI科研论文写作平台';

function replaceOfficialMark(source, eol, logoDataUri) {
  const markPattern = /(?:const xiaoJiaLogo = "[^"]+";\r?\n\t\t)?function OfficialBrandMark\(\{ size(?:, className)? \}\) \{[\s\S]*?\n\t\t\}/u;
  const replacement = [
    `const xiaoJiaLogo = "${logoDataUri}";`,
    '\t\tfunction OfficialBrandMark({ size, className }) {',
    '\t\t\treturn (0, react_jsx_runtime.jsx)("img", {',
    '\t\t\t\tclassName,',
    '\t\t\t\tsrc: xiaoJiaLogo,',
    '\t\t\t\talt: "",',
    '\t\t\t\tstyle: {',
    '\t\t\t\t\twidth: size,',
    '\t\t\t\t\theight: size,',
    '\t\t\t\t\tborderRadius: "50%",',
    '\t\t\t\t\tobjectFit: "cover",',
    '\t\t\t\t\tdisplay: "block"',
    '\t\t\t\t}',
    '\t\t\t});',
    '\t\t}',
  ].join(eol);
  return source.replace(markPattern, replacement);
}

function replaceOfficialName(source, eol) {
  const namePattern = /function OfficialBrandName\(\) \{[\s\S]*?\n\t\t\}/u;
  const replacement = [
    '\t\tfunction OfficialBrandName() {',
    '\t\t\treturn (0, react_jsx_runtime.jsx)("span", {',
    '\t\t\t\tstyle: {',
    '\t\t\t\t\tletterSpacing: 0,',
    '\t\t\t\t\twhiteSpace: "nowrap",',
    '\t\t\t\t\tfontSize: 15,',
    '\t\t\t\t\tfontWeight: 600,',
    '\t\t\t\t\tlineHeight: "22px"',
    '\t\t\t\t},',
    `\t\t\t\tchildren: "${PLATFORM_NAME}"`,
    '\t\t\t});',
    '\t\t}',
  ].join(eol);
  return source.replace(namePattern, replacement);
}

function ensureHeroSlot(source, eol) {
  if (source.includes('conversation.hero.brand.mark')) return source;
  const anchor = [
    '\t\t\tctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {',
    '\t\t\t\tyield ctx.slots.register({ name: "sidebar.brand.mark" }, OfficialBrandMark);',
    '\t\t\t\tyield ctx.slots.register({ name: "sidebar.brand.name" }, OfficialBrandName);',
    '\t\t\t}));',
  ].join(eol);
  const replacement = [
    anchor,
    '\t\t\tctx.slots.inject("conversation.hero.brand.mark", function* () {',
    '\t\t\t\tyield ctx.slots.register({ name: "conversation.hero.brand.mark" }, OfficialBrandMark);',
    '\t\t\t});',
  ].join(eol);
  if (!source.includes(anchor)) throw new Error('无法定位 DSH 品牌槽位');
  return source.replace(anchor, replacement);
}

export function patchDshBranding() {
  if (!existsSync(CLIENT_BUNDLE)) return false;
  if (!existsSync(LOGO_PATH)) throw new Error(`缺少品牌头像: ${LOGO_PATH}`);

  const logoBase64 = readFileSync(LOGO_PATH).toString('base64');
  const logoDataUri = `data:image/png;base64,${logoBase64}`;
  const original = readFileSync(CLIENT_BUNDLE, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';

  let patched = replaceOfficialMark(original, eol, logoDataUri);
  patched = replaceOfficialName(patched, eol);
  patched = ensureHeroSlot(patched, eol);

  if (patched === original) return false;
  writeFileSync(CLIENT_BUNDLE, patched, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(patchDshBranding() ? 'DSH 品牌补丁已安装。' : 'DSH 品牌补丁已存在。');
}
