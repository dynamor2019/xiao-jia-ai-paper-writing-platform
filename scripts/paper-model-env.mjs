import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

function readYaml(path) {
  return existsSync(path) ? parse(readFileSync(path, 'utf8')) || {} : {};
}

export function resolvePaperModelEnv(env = process.env, dshHome = env.DSH_HOME || join(homedir(), '.dsh')) {
  const settingsPath = join(dshHome, 'settings.yaml');
  const settings = readYaml(existsSync(settingsPath) ? settingsPath : `${settingsPath}.imported`);
  const credentials = readYaml(join(dshHome, '.credentials.yaml'));
  const providers = settings['llm-pi-ai']?.providers || {};
  const resolved = { ...env };
  for (const [providerId, prefix] of [['rayinai', 'OPENAI'], ['rayinai-claude', 'ANTHROPIC']]) {
    const provider = providers[providerId];
    if (!provider) continue;
    if (prefix === 'ANTHROPIC' && ['openai-responses', 'openai-completions'].includes(provider.api)) {
      resolved.ANTHROPIC_API_MODE = provider.api;
    }
    if (resolved[`${prefix}_API_KEY`]) continue;
    const credential = credentials.refs?.[provider.apiKeyEnv];
    if (typeof credential !== 'string' || !credential.trim()) continue;
    resolved[`${prefix}_API_KEY`] = credential;
    if (typeof provider.baseURL === 'string' && provider.baseURL.trim()) {
      resolved[`${prefix}_BASE_URL`] = provider.baseURL;
    }
  }
  return resolved;
}
