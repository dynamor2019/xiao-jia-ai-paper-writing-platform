import { EventSourceParserStream } from 'eventsource-parser/stream';

/** Read a completed Responses SSE result without waiting for the connection to close. */
export async function readResponsesStream(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error(`[${label}] Responses stream has no body`);
  const reader = response.body.pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onError: 'terminate' })).getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || value.data.trim() === '[DONE]') break;
      const event = JSON.parse(value.data) as Record<string, unknown>;
      if (event.type === 'response.completed') {
        const result = event.response as Record<string, unknown> | undefined;
        if (result?.status !== 'completed' || !Array.isArray(result.output)) {
          throw new Error(`[${label}] Invalid completed Responses result`);
        }
        return result;
      }
      if (['response.failed', 'response.incomplete', 'error'].includes(String(event.type))) {
        const detail = event.response ?? event.error ?? event;
        throw new Error(`[${label}] ${event.type}: ${JSON.stringify(detail)}`);
      }
    }
    throw new Error(`[${label}] Responses stream ended without a completed result`);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
