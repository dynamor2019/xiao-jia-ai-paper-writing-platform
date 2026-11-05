/** Resolve fresh managed settings without mutating the supplied environment. */
export function resolvePaperModelEnv(
  env?: NodeJS.ProcessEnv,
  dshHome?: string,
  projectRoot?: string,
): NodeJS.ProcessEnv;
