import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { PROJECT_ROOT } from './project-paths.mjs';
import { readDeepSeekProvider, readModelProviders, readProjectModelEnv } from './model-credentials.mjs';

function readYaml(path) {
  if (!existsSync(path)) return {};
  const document = parseDocument(readFileSync(path, 'utf8'), { prettyErrors: false });
  if (document.errors.length) throw new Error('Invalid managed credential store; repair it through the DSH credentials service');
  const store = document.toJS() || {};
  if (typeof store !== 'object' || Array.isArray(store)
    || (Object.keys(store).length && store.version !== 1)
    || (store.refs && (typeof store.refs !== 'object' || Array.isArray(store.refs)))
    || Object.values(store.refs || {}).some((value) => typeof value !== 'string')) {
    throw new Error('Unsupported managed credential store layout; repair it through the DSH credentials service');
  }
  return store;
}

/** Remove prior managed projections, not the caller's explicit environment. */
function explicitModelEnv(env) {
  const clean = { ...env };
  if (env.DSH_MANAGED_MODEL_FIELDS) {
    let fields;
    try { fields = JSON.parse(env.DSH_MANAGED_MODEL_FIELDS); } catch { /* Reject below. */ }
    if (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string'
      || !/^(?:OPENAI|ANTHROPIC|GROK|DEEPSEEK)_(?:API_KEY|BASE_URL|MODEL|API_MODE)$/.test(field))) {
      throw new Error('Invalid managed model environment metadata');
    }
    for (const field of fields) delete clean[field];
  }
  delete clean.DSH_MANAGED_MODEL_FIELDS;
  return clean;
}

/** Align pipeline requests with the active Web provider and credential reference. */
export function resolvePaperModelEnv(env = process.env, dshHome = env.DSH_HOME || join(homedir(), '.dsh'), projectRoot = PROJECT_ROOT) {
  const credentials = readYaml(join(dshHome, '.credentials.yaml'));
  const providers = readModelProviders(dshHome, projectRoot);
  const projectEnv = readProjectModelEnv(projectRoot);
  const explicit = explicitModelEnv(env);
  const resolved = { ...explicit };
  const managed = new Set();
  const assignManaged = (field, value) => { resolved[field] = value; managed.add(field); };
  for (const [providerId, prefix] of [['rayinai', 'OPENAI'], ['rayinai-claude', 'ANTHROPIC'],
    ['sub2api-grok', 'GROK'], ['deepseek-official', 'DEEPSEEK']]) {
    const provider = providers[providerId] || (prefix === 'DEEPSEEK'
      ? readDeepSeekProvider(dshHome, projectRoot, explicit)
      : undefined);
    if (!provider) continue;
    if (!resolved[`${prefix}_MODEL`] && provider.models?.[0]?.id) assignManaged(`${prefix}_MODEL`, provider.models[0].id);
    if (['openai-responses', 'openai-completions', 'anthropic-messages'].includes(provider.api)) {
      assignManaged(`${prefix}_API_MODE`, provider.api);
    }
    if (!resolved[`${prefix}_BASE_URL`] && typeof provider.baseURL === 'string' && provider.baseURL.trim()) {
      assignManaged(`${prefix}_BASE_URL`, provider.baseURL);
    }
    if (resolved[`${prefix}_API_KEY`]) continue;
    const credential = explicit[provider.apiKeyEnv] || credentials.refs?.[provider.apiKeyEnv] || projectEnv[provider.apiKeyEnv];
    if (typeof credential !== 'string' || !credential.trim()) continue;
    assignManaged(`${prefix}_API_KEY`, credential);
  }
  resolved.DSH_MANAGED_MODEL_FIELDS = JSON.stringify([...managed]);
  return resolved;
}
