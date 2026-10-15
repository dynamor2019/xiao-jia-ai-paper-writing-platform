import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'paper-model-credentials';
export const inject = ['credentials'];

/** Resolve project credentials even when Revit, desktop, or CLI uses another cwd. */
export async function apply(ctx) {
  const projectRoot = resolve(process.env.DSH_PAPER_PROJECT_DIR || String.raw`__DSH_PAPER_PROJECT_DIR__`);
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const module = await import(pathToFileURL(join(projectRoot, 'scripts', 'model-credentials.mjs')).href);
  const providers = module.readModelProviders(dshHome, projectRoot);
  const refs = module.readModelCredentialRefs(dshHome, projectRoot);
  const imported = await module.ensureModelCredentials(ctx.credentials, providers, projectRoot, refs);
  if (imported.length) ctx.logger.info('Model credentials initialized: %s', imported.join(', '));
}
