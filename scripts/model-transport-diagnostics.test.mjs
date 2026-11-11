import assert from 'node:assert/strict';
import test from 'node:test';
import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import { observeModelTransport, transportCauseCodes } from './model-transport-diagnostics.mjs';

test('cause codes retain nested and aggregate errors without secrets or cycles', () => {
  const error = { code: 'ECONNRESET', message: 'Bearer secret', errors: [{ code: 'ETIMEDOUT' }] };
  error.cause = error;
  assert.deepEqual(transportCauseCodes(error), ['ECONNRESET', 'ETIMEDOUT']);
  assert.deepEqual(transportCauseCodes({ code: 'secret/password' }), []);
});

test('observer is read-only, disposable and excludes credentials and non-model traffic', () => {
  const lines = [], original = globalThis.fetch;
  const stop = observeModelTransport(line => lines.push(line));
  const created = channel('undici:request:create'), failed = channel('undici:request:error');
  const request = { path: '/v1/responses?api_key=secret', headers: 'Bearer private', body: 'research data' };
  created.publish({ request });
  failed.publish({ request, error: { cause: { code: 'ECONNRESET', message: 'private URL' } } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ECONNRESET/);
  assert.doesNotMatch(lines[0], /secret|Bearer|research|private|api_key/);
  assert.equal(globalThis.fetch, original);
  failed.publish({ request, error: { name: 'AbortError', code: 20 } });
  failed.publish({ request, error: { code: 'UND_ERR_ABORTED' } });
  assert.equal(lines.length, 1);
  const other = { path: '/models' };
  created.publish({ request: other });
  failed.publish({ request: other, error: { code: 'ETIMEDOUT' } });
  stop();
  failed.publish({ request, error: { code: 'ECONNRESET' } });
  assert.equal(lines.length, 1);
});

test('a real reset socket yields the native error code before an SDK can flatten it', async t => {
  const lines = [], server = createServer(request => request.socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stop = observeModelTransport(line => lines.push(line));
  t.after(() => { stop(); server.closeAllConnections(); server.close(); });
  await assert.rejects(fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST', body: 'test', signal: AbortSignal.timeout(2000),
  }));
  assert.ok(lines.some(line => /UND_ERR_SOCKET|ECONNRESET/.test(line)));
});
