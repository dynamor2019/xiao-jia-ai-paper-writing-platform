import { AsyncLocalStorage } from 'node:async_hooks';

const request_environment = new AsyncLocalStorage<NodeJS.ProcessEnv>();

/** Read a request snapshot, retaining legacy environment access outside requests. */
export function modelEnvironment(): NodeJS.ProcessEnv {
  return request_environment.getStore() ?? process.env;
}

/** Isolate credentials and transport settings across concurrent model calls. */
export function withModelEnvironment<T>(env: NodeJS.ProcessEnv, run: () => T): T {
  return request_environment.run({ ...env }, run);
}
