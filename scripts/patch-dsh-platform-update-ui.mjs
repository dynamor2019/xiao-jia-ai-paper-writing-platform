import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = 'data-xiaojia-platform-updates';

/** Load the independent sidebar control without replacing native UI components. */
export function patchPlatformUpdateUi(projectRoot) {
  const target = join(projectRoot, 'node_modules/@deepseek-ai/dsh-client-ui-brand-official/lib/client.js');
  if (!existsSync(target)) return false;
  const bytes = readFileSync(target);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const source = bytes.toString('utf8');
  if (source.includes(MARKER)) return false;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const script = `
if (typeof document !== 'undefined' && !document.querySelector('script[${MARKER}]')) {
  const entry = document.createElement('script');
  entry.setAttribute('${MARKER}', '');
  entry.src = '/dsh-platform-update/client.js';
  document.head.append(entry);
}
`;
  writeFileSync(target, Buffer.concat([bytes, Buffer.from(script.replaceAll('\n', eol))]));
  return true;
}
