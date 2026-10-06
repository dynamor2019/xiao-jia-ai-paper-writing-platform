import 'dotenv/config';
import dns from 'node:dns';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { resolvePaperModelEnv } from './paper-model-env.mjs';
import { assertResumeBillingAllowed } from './paper-retry-policy.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Optional process-local DNS selection; retain original provider URL, credentials and TLS verification. */
function configureSessionDns(server) {
  if (!server) return;
  const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers([server]);
  const lookup = dns.lookup;
  let cached = [], expires = 0;
  dns.lookup = function(host, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : options || {};
    if (host !== 'code.rayinai.com' || opts.family === 6) return lookup.call(dns, host, options, callback);
    const addresses = Date.now() < expires && cached.length ? Promise.resolve(cached)
      : resolver.resolve4(host, { ttl: true }).then((records) => {
        if (!records.length) throw new Error('Empty provider DNS result');
        cached = records.map((record) => ({ address: record.address, family: 4 }));
        expires = Date.now() + Math.min(30, ...records.map((record) => record.ttl)) * 1000;
        return cached;
      });
    addresses.then((items) => opts.all ? callback(null, items) : callback(null, items[0].address, 4), callback);
  };
  syncBuiltinESMExports();
}

/** Refuse parallel or unknown owners before changing the Web run status. */
function assertStopped(run) {
  for (const pid of new Set([run.pid, run.pipelinePid].filter(Boolean))) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') continue;
      throw error;
    }
    throw new Error('A recorded paper process is still alive: ' + pid);
  }
}

/** Resume the existing DSH workflow, with visible Web state and no unbounded paid retries. */
async function main() {
  const statePath = process.argv[2];
  if (!statePath) throw new Error('An existing Web paper run state file is required');
  const run = JSON.parse(readFileSync(statePath, 'utf8'));
  assertResumeBillingAllowed(run.error, process.argv.includes('--billing-restored'));
  assertStopped(run);
  if (!run.outputDir || !run.resultsFile || !run.experimentCommand) throw new Error('Existing bound experiment configuration required');
  const checkpointPath = join(run.outputDir, '.dsh-state', 'paper-pipeline-state.json');
  const previous = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  if (!previous.experimentIntegration || previous.metadata.awaitingApproval) {
    throw new Error('Only an explicitly integrated, non-approval checkpoint may be resumed');
  }
  Object.assign(process.env, resolvePaperModelEnv());
  configureSessionDns(process.argv.slice(3).find((argument) => argument !== '--billing-restored'));
  const { PaperPipeline, PIPELINE_STAGES } = await tsImport(pathToFileURL(join(PROJECT_ROOT, 'src/workflows/paper-pipeline.ts')).href, import.meta.url);
  for (const method of ['log', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...items) => { appendFileSync(run.logPath, items.join(' ') + '\n'); original(...items); };
  }
  const pipeline = new PaperPipeline(run.topic, async(stage) => stage !== 'submission-readiness', run);
  Object.assign(run, { status: 'running', pid: process.pid, pipelinePid: process.pid,
    resumeStartedAt: new Date().toISOString(), error: undefined, exitCode: undefined, finishedAt: undefined });
  const update = (status) => {
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    run.stage = checkpoint.stage;
    run.stageIndex = PIPELINE_STAGES.indexOf(run.stage) + 1;
    run.stageTotal = PIPELINE_STAGES.length;
    run.status = status || run.status;
    run.updatedAt = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(run, null, 2));
  };
  update();
  const timer = setInterval(() => { try { update(); } catch (error) { console.error(error.message); } }, 5000);
  try {
    const state = await pipeline.run();
    run.finishedAt = new Date().toISOString();
    run.exitCode = state.metadata.awaitingApproval ? 3 : 0;
    update(state.metadata.awaitingApproval ? 'awaiting-confirmation' : 'completed');
  } catch (error) {
    run.error = error.message;
    run.finishedAt = new Date().toISOString();
    run.exitCode = 1;
    update('failed');
    throw error;
  } finally { clearInterval(timer); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
