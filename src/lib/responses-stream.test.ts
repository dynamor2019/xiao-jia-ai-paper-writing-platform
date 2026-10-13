import assert from 'node:assert/strict';
import test from 'node:test';
import { readResponsesStream } from './responses-stream.js';

/** Keep the connection open so only a terminal event can finish the read. */
function streamFixture(events: unknown[], close = false) {
  let cancelled = false;
  const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(`: heartbeat\r\n\r\n${text}`);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7));
      }
      if (close) controller.close();
    },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    cancelled: () => cancelled };
}

test('completed Responses events finish and cancel an open connection', async () => {
  const result = { status: 'completed', output: [{ type: 'message', content: [
    { type: 'output_text', text: '\u4e2d\u6587 OK' },
  ] }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } };
  const fixture = streamFixture([
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: '\u4e2d\u6587 OK' },
    { type: 'response.completed', response: result },
  ]);
  assert.deepEqual(await readResponsesStream(fixture.response, 'probe'), result);
  assert.equal(fixture.cancelled(), true);
});

test('a failed response is not treated as a completed result', async () => {
  const fixture = streamFixture([{ type: 'response.failed', response: {
    status: 'failed', error: { code: 'billing_error', message: 'insufficient balance' },
  } }]);
  await assert.rejects(readResponsesStream(fixture.response, 'probe'), /response.failed.*billing_error/);
  assert.equal(fixture.cancelled(), true);
});

test('incomplete output remains a failure even when it contains text', async () => {
  const fixture = streamFixture([{ type: 'response.incomplete', response: {
    status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
  } }]);
  await assert.rejects(readResponsesStream(fixture.response, 'probe'), /response.incomplete/);
});

test('early EOF without a completed event is rejected', async () => {
  const fixture = streamFixture([{ type: 'response.output_text.delta', delta: 'partial' }], true);
  await assert.rejects(readResponsesStream(fixture.response, 'probe'), /without a completed result/);
});

test('a misleading completed event with an invalid payload is rejected', async () => {
  const fixture = streamFixture([{ type: 'response.completed', response: { status: 'in_progress', output: [] } }]);
  await assert.rejects(readResponsesStream(fixture.response, 'probe'), /Invalid completed/);
});

test('missing bodies fail immediately', async () => {
  await assert.rejects(readResponsesStream(new Response(null), 'probe'), /has no body/);
});
