import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'tool-research-memory';
const inject = ['tools'];
const PROJECT_DIR = realpathSync(resolve(process.env.DSH_PAPER_PROJECT_DIR || 'F:\\dsh'));
const DATA_ROOT_PATH = resolve(process.env.PAPER_DATA_ROOT || 'F:\\DSH data');
mkdirSync(DATA_ROOT_PATH, { recursive: true });
const DATA_ROOT = realpathSync(DATA_ROOT_PATH);
const STATE_ROOT = resolve(DATA_ROOT, process.env.PAPER_STATE_DIR || '.dsh-state');
const MEMORY_PATH = join(STATE_ROOT, 'corpus-memory.json');
const MAX_SUMMARY_CHARS = 6000;
const MAX_ITEMS = 30;
const MAX_ITEM_CHARS = 600;

function emptyMemory() {
  return { version: 1, updatedAt: new Date(0).toISOString(), entries: {} };
}

function loadMemory() {
  if (!existsSync(MEMORY_PATH)) return emptyMemory();
  try {
    const value = JSON.parse(readFileSync(MEMORY_PATH, 'utf8'));
    if (value?.version === 1 && value.entries && typeof value.entries === 'object') return value;
  } catch {
    // A malformed ledger must not be treated as trusted research memory.
  }
  throw new Error(`Research memory is invalid: ${MEMORY_PATH}`);
}

function saveMemory(memory) {
  mkdirSync(dirname(MEMORY_PATH), { recursive: true });
  const temporaryPath = `${MEMORY_PATH}.tmp`;
  memory.updatedAt = new Date().toISOString();
  writeFileSync(temporaryPath, `${JSON.stringify(memory, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, MEMORY_PATH);
}

function resolveSource(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('file is required.');
  const candidate = isAbsolute(file) ? resolve(file) : resolve(PROJECT_DIR, file);
  if (!existsSync(candidate)) throw new Error(`Source file does not exist: ${candidate}`);
  const source = realpathSync(candidate);
  if (!isInsideRoot(source, PROJECT_DIR) && !isInsideRoot(source, DATA_ROOT)) {
    throw new Error(`Source file is outside the research workspace: ${source}`);
  }
  return source;
}

function sourceKey(source) {
  const root = isInsideRoot(source, DATA_ROOT) ? DATA_ROOT : PROJECT_DIR;
  const prefix = root === DATA_ROOT ? 'data' : 'project';
  return `${prefix}:${relative(root, source).replaceAll('\\', '/').toLowerCase()}`;
}

function isInsideRoot(source, root) {
  const scope = relative(root, source);
  return scope === '' || !(scope === '..' || scope.startsWith(`..\\`) || isAbsolute(scope));
}

function fingerprint(source) {
  const info = statSync(source);
  return {
    sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    size: info.size,
    mtimeMs: Math.trunc(info.mtimeMs),
  };
}

function cleanText(value, field, maxChars = MAX_SUMMARY_CHARS) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  const text = value.trim();
  if (text.length > maxChars) throw new Error(`${field} exceeds ${maxChars} characters.`);
  return text;
}

function cleanItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, MAX_ITEMS)
    .map((item) => item.trim().slice(0, MAX_ITEM_CHARS));
}

function entryStatus(entry) {
  if (!existsSync(entry.path)) return 'missing';
  const info = statSync(entry.path);
  return info.size === entry.size && Math.trunc(info.mtimeMs) === entry.mtimeMs ? 'cached' : 'stale';
}

function formatEntry(entry, status = 'cached') {
  return [
    `MEMORY ${status.toUpperCase()}`,
    `file: ${entry.path}`,
    `sha256: ${entry.sha256}`,
    `summary: ${entry.summary}`,
    entry.keyEvidence.length ? `key evidence:\n- ${entry.keyEvidence.join('\n- ')}` : '',
    entry.methods.length ? `methods:\n- ${entry.methods.join('\n- ')}` : '',
    entry.limitations.length ? `limitations:\n- ${entry.limitations.join('\n- ')}` : '',
    entry.citationKeys.length ? `citation keys: ${entry.citationKeys.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function lookup(file) {
  const source = resolveSource(file);
  const key = sourceKey(source);
  const memory = loadMemory();
  const entry = memory.entries[key];
  if (!entry) return `MEMORY MISS\nfile: ${source}\naction: Read this source once, then store a compact evidence memo.`;
  const current = fingerprint(source);
  if (entry.sha256 !== current.sha256) {
    return `MEMORY STALE\nfile: ${source}\naction: Source changed; reread it once and replace the memo.`;
  }
  return formatEntry(entry);
}

function store(args) {
  const source = resolveSource(args.file);
  const key = sourceKey(source);
  const current = fingerprint(source);
  const memory = loadMemory();
  const entry = {
    path: source,
    ...current,
    recordedAt: new Date().toISOString(),
    summary: cleanText(args.summary, 'summary'),
    keywords: cleanItems(args.keywords),
    keyEvidence: cleanItems(args.keyEvidence),
    methods: cleanItems(args.methods),
    limitations: cleanItems(args.limitations),
    citationKeys: cleanItems(args.citationKeys),
  };
  memory.entries[key] = entry;
  saveMemory(memory);
  return `MEMORY STORED\nfile: ${source}\nsha256: ${entry.sha256}\nReuse this memo until the source hash changes.`;
}

function searchMemory(query, requestedLimit) {
  const terms = cleanText(query, 'query', 500).toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.min(Math.max(Number.isInteger(requestedLimit) ? requestedLimit : 3, 1), 8);
  const entries = Object.values(loadMemory().entries)
    .map((entry) => {
      const text = [entry.summary, ...entry.keywords, ...entry.keyEvidence, ...entry.methods].join('\n').toLowerCase();
      return { entry, score: terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0) };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  if (!entries.length) return 'MEMORY SEARCH MISS\naction: No cached evidence matches; search or read a new source.';
  return entries.map(({ entry }) => formatEntry(entry, entryStatus(entry))).join('\n\n---\n\n');
}

function listMemory() {
  const entries = Object.values(loadMemory().entries);
  if (!entries.length) return `MEMORY EMPTY\npath: ${MEMORY_PATH}`;
  return [
    `MEMORY INDEX (${entries.length} sources)`,
    ...entries.map((entry) => `- [${entryStatus(entry)}] ${entry.path}`),
  ].join('\n');
}

function execute(args) {
  if (args.action === 'lookup') return lookup(args.file);
  if (args.action === 'store') return store(args);
  if (args.action === 'search') return searchMemory(args.query, args.limit);
  if (args.action === 'list') return listMemory();
  throw new Error(`Unsupported research memory action: ${args.action}`);
}

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'research_memory',
    description: 'Persistent token-saving memory for research sources. Before reading any previously encountered corpus file, use lookup; on MEMORY HIT, use the memo and do not read the source again. After the first necessary read or after STALE, store a compact evidence memo. Use search to retrieve relevant cached evidence without loading full texts.',
    parameters: {
      action: { type: 'string', required: true, enum: ['lookup', 'store', 'search', 'list'] },
      file: { type: 'string', description: 'Workspace source path; required for lookup and store.' },
      query: { type: 'string', description: 'Evidence query; required for search.' },
      summary: { type: 'string', description: 'Compact source summary; required for store.' },
      keywords: { type: 'array', items: { type: 'string' } },
      keyEvidence: { type: 'array', items: { type: 'string' } },
      methods: { type: 'array', items: { type: 'string' } },
      limitations: { type: 'array', items: { type: 'string' } },
      citationKeys: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer', description: 'Maximum search results, from 1 to 8.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute,
  }));
}

export { apply, execute, inject, name };
