import { channel } from 'node:diagnostics_channel';

/** Inspect bounded native causes without retaining URLs, headers, payloads or messages. */
export function transportCauseCodes(error) {
  const codes = new Set();
  const queue = [error];
  const seen = new Set();
  for (let i = 0; i < queue.length && i < 12; i++) {
    const item = queue[i];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(item.code)) codes.add(item.code);
    if (item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors.slice(0, 4));
  }
  return [...codes];
}

/** Observe transport failures only; never replace fetch, dispatchers, sockets or settings. */
export function observeModelTransport(write = line => process.stderr.write(line + '\n')) {
  const starts = new WeakMap();
  const created = channel('undici:request:create');
  const failed = channel('undici:request:error');
  const onCreate = ({ request }) => {
    if (request && /\/(?:responses|chat\/completions|messages)(?:\?|$)/.test(request.path || '')) {
      starts.set(request, Date.now());
    }
  };
  const onError = ({ request, error }) => {
    const start = request && starts.get(request);
    if (start === undefined) return;
    if (error?.name === 'AbortError' || error?.code === 'UND_ERR_ABORTED'
      || error?.code === 'ABORT_ERR' || error === 'pi-ai stream consumer stopped') return;
    try {
      write('[model-transport] ' + JSON.stringify({ time: new Date().toISOString(),
        elapsedMs: Date.now() - start, codes: transportCauseCodes(error) }));
    } catch { /* Diagnostics must never fail a model request. */ }
  };
  created.subscribe(onCreate);
  failed.subscribe(onError);
  return () => { created.unsubscribe(onCreate); failed.unsubscribe(onError); };
}
