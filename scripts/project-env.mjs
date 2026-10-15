import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from './project-paths.mjs';
import { readModelCredentialRefs, readProjectModelEnv } from './model-credentials.mjs';

/** Load application options without promoting dotenv credentials to inherited secrets. */
export function loadProjectEnv(env = process.env, projectRoot = PROJECT_ROOT) {
  const fallback = readProjectModelEnv(projectRoot);
  const dshHome = env.DSH_HOME || fallback.DSH_HOME || join(homedir(), '.dsh');
  const refs = new Set(readModelCredentialRefs(dshHome, projectRoot));
  for (const [name, value] of Object.entries(fallback)) {
    if (refs.has(name) || /(?:_API_KEY|_TOKEN|_SECRET)$/.test(name)
      || /^(?:OPENAI|ANTHROPIC|SUB2API|GROK|DEEPSEEK)_(?:BASE_URL|API_MODE|USE_RESPONSES_API)$/.test(name)) continue;
    if (env[name] === undefined) env[name] = value;
  }
  return env;
}

loadProjectEnv();
