'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DeviceTransport, deviceAddress, endpointPath } = require('../src/main/remote/device-transport');

async function fixture(context, handler) {
  const token = 'a'.repeat(64);
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-camellia-outbound'], token);
    handler(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const transport = new DeviceTransport({ url: `http://127.0.0.1:${server.address().port}`, token });
  context.after(async () => { await transport.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return transport;
}

test('outbound targets and endpoints exclude public hosts, redirects and arbitrary local services', () => {
  assert.equal(deviceAddress('http://100.80.1.2:43127'), 'http://100.80.1.2:43127');
  for (const value of ['http://127.0.0.1:43127', 'http://100.080.1.2:43127', 'https://100.80.1.2:43127', 'http://100.80.1.2:43127/', 'http://100.80.1.2:80', 'http://example.com:43127']) assert.throws(() => deviceAddress(value));
  assert.equal(endpointPath('/v1/conversations?offset=100', 'GET'), '/v1/conversations?offset=100');
  assert.equal(endpointPath('/v1/api-import', 'GET'), '/v1/api-import');
  assert.equal(endpointPath('/v1/native-settings/codex', 'GET'), '/v1/native-settings/codex');
  assert.equal(endpointPath('/v1/native-settings/dsh', 'POST'), '/v1/native-settings/dsh');
  assert.equal(endpointPath('/v1/native-settings/pi', 'GET'), '/v1/native-settings/pi');
  assert.throws(() => endpointPath('/v1/native-settings/auth', 'GET'));
  assert.throws(() => endpointPath('/v1/native-settings/codex?offset=1', 'GET'));
  assert.equal(endpointPath('/v1/archived?offset=0', 'GET'), '/v1/archived?offset=0');
  assert.equal(endpointPath('/v1/server-management', 'POST'), '/v1/server-management');
  assert.equal(endpointPath('/v1/server-management/' + 'a'.repeat(36), 'GET'), '/v1/server-management/' + 'a'.repeat(36));
  assert.throws(() => endpointPath('/v1/server-management?token=secret', 'POST'));
  assert.throws(() => endpointPath('/v1/server-management', 'GET'));
  assert.throws(() => endpointPath('/v1/server-management/' + 'a'.repeat(36), 'POST'));
  assert.throws(() => endpointPath('/v1/archived', 'POST'));
  assert.equal(endpointPath('/v1/api-import', 'POST'), '/v1/api-import');
  assert.throws(() => endpointPath('/v1/api-import?token=secret', 'POST'));
  for (const value of ['/admin', '//evil/v1/status', '/v1/%73tatus', '/v1/status?offset=1', '/v1/conversations?offset=1&offset=2']) assert.throws(() => endpointPath(value, 'GET'));
  assert.throws(() => endpointPath('/v1/status', 'POST'));
});

test('device JSON transport forwards credentials and bounded POST bodies without exposing them in errors', async context => {
  const transport = await fixture(context, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + 'b'.repeat(43));
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.deepEqual(JSON.parse(body), { code: 'one-time' });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"state":"pending"}');
    });
  });
  assert.deepEqual(await transport.json('/v1/pair/request', { method: 'POST', body: { code: 'one-time' }, bearer: 'b'.repeat(43) }), { state: 'pending' });
  await assert.rejects(transport.json('/v1/status', { bearer: 'secret\r\nheader' }), /Invalid device credential/);
  await assert.rejects(transport.json('/v1/commands', { method: 'POST', body: 'a'.repeat(48 * 1024 * 1024) }), /too large/);
});

test('device transport carries expanded mobile attachments beyond the previous request limit', async context => {
  const data = 'a'.repeat(14 * 1024 * 1024);
  const transport = await fixture(context, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + 'b'.repeat(43));
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.equal(JSON.parse(body).attachments[0].data, data);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  assert.deepEqual(await transport.json('/v1/conversations/' + 'a'.repeat(36) + '/commands', {
    method: 'POST', bearer: 'b'.repeat(43),
    body: { attachments: [{ name: 'notes.txt', data, isImage: false }] },
  }), { ok: true });
});

test('device event streams yield UTF-8 frames before completion and cancel upstream on break', async context => {
  let closed;
  const cancelled = new Promise(resolve => { closed = resolve; });
  const transport = await fixture(context, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = Buffer.from('id: instance:1\r\nevent: snapshot\r\ndata: {"text":"猫咪"}\r\n\r\n');
    const split = frame.indexOf(Buffer.from('猫')) + 1;
    response.write(frame.subarray(0, split));
    setImmediate(() => response.write(frame.subarray(split)));
    response.on('close', closed);
  });
  for await (const event of transport.events('/v1/conversations/events')) {
    assert.deepEqual(event, { id: 'instance:1', type: 'snapshot', data: { text: '猫咪' } });
    break;
  }
  await cancelled;
});

test('device transport rejects redirects, malformed JSON and oversized responses', async context => {
  let mode = 'redirect';
  const transport = await fixture(context, (request, response) => {
    if (mode === 'redirect') { response.writeHead(302, { location: 'http://127.0.0.1/private' }); response.end(); }
    else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(mode === 'large' ? ' '.repeat(8 * 1024 * 1024 + 1) : 'secret invalid JSON'); }
  });
  await assert.rejects(transport.json('/v1/status'), /HTTP 302/);
  mode = 'invalid'; await assert.rejects(transport.json('/v1/status'), /^Error: Invalid device JSON response$/);
  mode = 'large'; await assert.rejects(transport.json('/v1/status'), /too large/);
});

test('closing a transport cancels requests, never retries writes, and disconnects once', async context => {
  let received, count = 0, disconnected = 0;
  const arrived = new Promise(resolve => { received = resolve; });
  const transport = await fixture(context, () => { count++; received(); });
  transport.disconnect = async () => { disconnected++; };
  const result = assert.rejects(transport.json('/v1/commands', { method: 'POST', body: { action: 'send' } }), /verify state before retrying writes/);
  await arrived; await transport.close(); await transport.close(); await result;
  assert.equal(count, 1); assert.equal(disconnected, 1);
  await assert.rejects(transport.json('/v1/status'), /closed/);
});

test('JSON deadline includes a trickling response body and permits a later explicit retry', async context => {
  let mode = 'slow', count = 0;
  const transport = await fixture(context, (_request, response) => {
    count++;
    response.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'ready') { response.end('{"ok":true}'); return; }
    response.write('{');
    const interval = setInterval(() => response.write(' '), 10);
    response.once('close', () => clearInterval(interval));
  });
  transport.responseTimeoutMs = 100;
  await assert.rejects(transport.json('/v1/conversations'), /Device response timed out/);
  assert.equal(count, 1);
  mode = 'ready';
  assert.deepEqual(await transport.json('/v1/conversations'), { ok: true });
  assert.equal(count, 2);
});

test('JSON deadline reports header stalls without automatically retrying writes', async context => {
  let count = 0;
  const transport = await fixture(context, () => { count++; });
  transport.responseTimeoutMs = 100;
  await assert.rejects(transport.json('/v1/commands', { method: 'POST', body: { action: 'send' } }), /Device response timed out.*verify state/);
  assert.equal(count, 1);
});
