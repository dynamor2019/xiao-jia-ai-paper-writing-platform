import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { parse } from 'yaml';

/** Read the active composition and its matching settings layer. */
function readModelConfiguration(dshHome, projectRoot) {
  const profilePath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  const sourcePath = join(projectRoot, 'config', 'dsh', 'web', 'cordis.patch.yml');
  const path = existsSync(profilePath) ? profilePath : sourcePath;
  const profile = existsSync(path) ? parse(readFileSync(path, 'utf8'), { logLevel: 'silent' }) : [];
  const settingsPath = join(dshHome, 'settings.yaml');
  const selected = existsSync(settingsPath) ? settingsPath : !existsSync(profilePath) ? `${settingsPath}.imported` : undefined;
  const settings = selected && existsSync(selected) ? parse(readFileSync(selected, 'utf8')) || {} : {};
  return { profile, settings };
}

/** Read model routes from the active profile, then apply Web settings overrides. */
export function readModelProviders(dshHome, projectRoot) {
  const { profile, settings } = readModelConfiguration(dshHome, projectRoot);
  const defaults = profile.find((entry) => entry.id === 'llm-pi-ai')?.config?.providers || {};
  const overrides = settings['llm-pi-ai']?.providers || {};
  return Object.fromEntries([...new Set([...Object.keys(defaults), ...Object.keys(overrides)])]
    .map((id) => [id, { ...defaults[id], ...overrides[id] }]));
}

/** Match the native DeepSeek API-key plugin rather than guessing its wire protocol. */
export function readDeepSeekProvider(dshHome, projectRoot, env = process.env) {
  const { profile, settings } = readModelConfiguration(dshHome, projectRoot);
  let defaults;
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.id === 'llm-deepseek-api-key') defaults = value.config;
    for (const child of Object.values(value)) visit(child);
  };
  visit(profile);
  const config = { ...defaults, ...settings['llm-deepseek-api-key'] };
  return { ...config, apiKeyEnv: config.apiKeyEnv || 'DEEPSEEK_API_KEY',
    api: 'anthropic-messages', baseURL: config.baseURL || env.DEEPSEEK_API_BASE
      || readProjectModelEnv(projectRoot).DEEPSEEK_API_BASE || 'https://api.deepseek.com/anthropic' };
}

/** Read the project's credential fallback without mutating process environment. */
export function readProjectModelEnv(projectRoot) {
  const path = join(projectRoot, '.env');
  return existsSync(path) ? parseEnv(readFileSync(path)) : {};
}

/** Include auxiliary model tools and the native DeepSeek adapter's credential. */
export function readModelCredentialRefs(dshHome, projectRoot) {
  const refs = new Set([readDeepSeekProvider(dshHome, projectRoot).apiKeyEnv]);
  for (const provider of Object.values(readModelProviders(dshHome, projectRoot))) {
    if (provider.apiKeyEnv) refs.add(provider.apiKeyEnv);
  }
  const runtime = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  const path = existsSync(runtime) ? runtime : join(projectRoot, 'config', 'dsh', 'web', 'cordis.patch.yml');
  const visit = (value) => {
    if (!value || typeof value !== 'object' || value.id === 'llm-pi-ai') return;
    if (typeof value.apiKeyEnv === 'string') refs.add(value.apiKeyEnv);
    for (const child of Object.values(value)) visit(child);
  };
  if (existsSync(path)) visit(parse(readFileSync(path, 'utf8'), { logLevel: 'silent' }));
  return [...refs];
}

/** Seed only missing configured references through the official credential service. */
export async function ensureModelCredentials(credentials, providers, projectRoot, additionalRefs = []) {
  const fallback = readProjectModelEnv(projectRoot);
  const refs = new Set([...Object.values(providers).map((provider) => provider.apiKeyEnv), ...additionalRefs].filter(Boolean));
  const imported = [];
  for (const ref of refs) {
    if (await credentials.resolve(ref)) continue;
    const value = fallback[ref]?.trim();
    if (!value) continue;
    await credentials.set(ref, value);
    imported.push(ref);
  }
  return imported;
}
