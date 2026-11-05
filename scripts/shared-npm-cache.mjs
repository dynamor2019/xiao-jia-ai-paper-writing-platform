import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Share npm's user cache without changing installed dependency resolution. */
export function resolveNpmCache(env = process.env, platform = process.platform) {
  const explicit = [env.DSH_NPM_CACHE, env.NPM_CONFIG_CACHE, env.npm_config_cache]
    .find((value) => typeof value === 'string' && value.trim());
  if (explicit) return resolve(explicit.trim());
  if (platform === 'win32') {
    const home = env.USERPROFILE || homedir();
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'npm-cache');
  }
  const home = env.HOME || homedir();
  if (!isAbsolute(home)) throw new Error('The npm cache home must be an absolute path');
  return join(home, '.npm');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(resolveNpmCache());
}
