import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isMap, isSeq, parseDocument } from 'yaml';

/** Set only a missing fetch choice; preserve explicit selections and original YAML bytes. */
export function defaultWebFetchProvider(source) {
  const document = parseDocument(source, { logLevel: 'silent' });
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Invalid web profile; no changes written');
  const entries = document.contents.items.filter(item => isMap(item) && item.get('id') === 'web');
  if (entries.length > 1) throw new Error('Duplicate web configuration; no changes written');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const entry = entries[0];
  if (!entry) return source + `${source.endsWith('\n') ? '' : eol}- id: web${eol}  config:${eol}    fetchProvider: http${eol}`;
  const config = entry.get('config', true);
  if (isMap(config)) {
    if (config.has('fetchProvider')) return source;
    const start = config.range[0];
    if (config.flow) return source.slice(0, start + 1) + 'fetchProvider: http, ' + source.slice(start + 1);
    const line = source.lastIndexOf('\n', start) + 1;
    const indentation = source.slice(line, start);
    return source.slice(0, line) + indentation + 'fetchProvider: http' + eol + source.slice(line);
  }
  if (entry.has('config')) throw new Error('Unsupported web configuration; no changes written');
  const end = entry.range[1];
  return source.slice(0, end) + (source[end - 1] === '\n' ? '' : eol)
    + `  config:${eol}    fetchProvider: http${eol}` + source.slice(end);
}

/** Migrate an existing runtime without replacing its providers, settings, comments or encoding. */
export function repairWebFetchProvider(path) {
  const bytes = readFileSync(path);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const source = bytes.toString('utf8');
  const result = defaultWebFetchProvider(source);
  if (result === source) return false;
  const backup = `${path}.before-web-fetch-selection.bak`;
  if (!existsSync(backup)) writeFileSync(backup, bytes, { flag: 'wx' });
  writeFileSync(path, Buffer.from(result, 'utf8'));
  return true;
}
