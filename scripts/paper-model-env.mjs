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

/** Align pipeline requests with the active Web provider and credential reference. */
export function resolvePaperModelEnv(env = process.env, dshHome = env.DSH_HOME || join(homedir(), '.dsh'), projectRoot = PROJECT_ROOT) {
  const credentials = readYaml(join(dshHome, '.credentials.yaml'));
  const providers = readModelProviders(dshHome, projectRoot);
  const projectEnv = readProjectModelEnv(projectRoot);
  const resolved = { ...env };
  for (const [providerId, prefix] of [['rayinai', 'OPENAI'], ['rayinai-claude', 'ANTHROPIC'],
    ['sub2api-grok', 'GROK'], ['deepseek-official', 'DEEPSEEK']]) {
    const provider = providers[providerId] || (prefix === 'DEEPSEEK'
      ? readDeepSeekProvider(dshHome, projectRoot, env)
      : undefined);
    if (!provider) continue;
    if (!resolved[`${prefix}_MODEL`] && provider.models?.[0]?.id) resolved[`${prefix}_MODEL`] = provider.models[0].id;
    if (['openai-responses', 'openai-completions', 'anthropic-messages'].includes(provider.api)) {
      resolved[`${prefix}_API_MODE`] = provider.api;
    }
    if (!resolved[`${prefix}_BASE_URL`] && typeof provider.baseURL === 'string' && provider.baseURL.trim()) {
      resolved[`${prefix}_BASE_URL`] = provider.baseURL;
    }
    if (resolved[`${prefix}_API_KEY`]) continue;
    const credential = env[provider.apiKeyEnv] || credentials.refs?.[provider.apiKeyEnv] || projectEnv[provider.apiKeyEnv];
    if (typeof credential !== 'string' || !credential.trim()) continue;
    resolved[`${prefix}_API_KEY`] = credential;
  }
  return resolved;
}
