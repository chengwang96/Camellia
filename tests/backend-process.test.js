'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter, once } = require('node:events');
const { BackendProcess, pickPort } = require('../src/main/backend-process');

function fixture(t, overrides = {}) {
  const processes = [];
  const backend = new BackendProcess({ spawn: () => {
    const proc = Object.assign(new EventEmitter(), { killed: false, stdout: new EventEmitter(), stderr: new EventEmitter() });
    proc.kill = () => { proc.killed = true; };
    processes.push(proc); return proc;
  }, selectPort: async () => 19097, probe: async () => 200, pollMs: 1, ...overrides });
  t.after(() => backend.stop());
  const options = { key: 'first', exe: 'fake', cwd: '.', env: {}, host: '127.0.0.1', port: 19097, args: port => ['--port', String(port)], timeoutMs: 100 };
  return { backend, processes, options };
}

test('port selection skips a non-HTTP TCP listener and supports an ephemeral port', async t => {
  const occupied = net.createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const used = occupied.address().port;
  assert.notEqual(await pickPort({ host: '127.0.0.1', port: used }), used);
  assert.ok(await pickPort({ host: '127.0.0.1', port: 0 }) > 0);
  await assert.rejects(pickPort({ host: '127.0.0.1', port: 65536 }), /between 0 and 65535/);
});

test('port selection skips a port denied by the operating system', async t => {
  const attempted = [];
  t.mock.method(net, 'createServer', () => {
    const server = new EventEmitter();
    let selected;
    server.listen = ({ port }, ready) => {
      selected = port; attempted.push(port);
      queueMicrotask(() => port === 19097
        ? server.emit('error', Object.assign(new Error('reserved port'), { code: 'EACCES' }))
        : ready());
      return server;
    };
    server.address = () => ({ port: selected });
    server.close = done => done();
    return server;
  });
  assert.equal(await pickPort({ host: '127.0.0.1', port: 19097 }), 19098);
  assert.deepEqual(attempted, [19097, 19098]);
});

test('port selection preserves denied ephemeral binds and invalid host errors', async t => {
  let code = 'EACCES';
  t.mock.method(net, 'createServer', () => {
    const server = new EventEmitter();
    server.listen = () => {
      queueMicrotask(() => server.emit('error', Object.assign(new Error('bind failed'), { code })));
      return server;
    };
    return server;
  });
  await assert.rejects(pickPort({ host: '127.0.0.1', port: 0 }), { code: 'EACCES' });
  code = 'EADDRNOTAVAIL';
  await assert.rejects(pickPort({ host: 'invalid-host', port: 19097 }), { code });
});

test('concurrent and repeated starts reuse one process; an old exit cannot clear its replacement', async t => {
  const f = fixture(t);
  const first = f.backend.start(f.options);
  assert.equal(f.backend.start(f.options), first);
  await first;
  await f.backend.start(f.options);
  assert.equal(f.processes.length, 1);
  await f.backend.start({ ...f.options, key: 'second' });
  const current = f.backend.current;
  assert.equal(f.processes[0].killed, true);
  f.processes[0].emit('exit', 0);
  assert.equal(f.backend.current, current);
  assert.equal(current.proc, f.processes[1]);
});

test('stop during port selection cancels startup before any process can spawn', async t => {
  let release;
  const f = fixture(t, { selectPort: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.backend.start(f.options);
  f.backend.stop(); release(19097);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.processes.length, 0);
});

test('stopAndWait waits for the backend to exit before replacing its files', async t => {
  const f = fixture(t);
  await f.backend.start(f.options);
  let completed = false;
  const stopping = f.backend.stopAndWait(1000).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(f.processes[0].killed, true);
  assert.equal(completed, false);
  f.processes[0].emit('exit', 0, 'SIGTERM');
  await stopping;
  assert.equal(completed, true);
});

test('stopAndWait also waits for a failed startup process that is still exiting', async t => {
  const f = fixture(t, { probe: async () => { throw new Error('probe failed'); } });
  await assert.rejects(f.backend.start(f.options), /probe failed/);
  assert.equal(f.backend.current, null);
  let completed = false;
  const stopping = f.backend.stopAndWait(1000).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  f.processes[0].emit('exit', 0, 'SIGTERM');
  await stopping;
  assert.equal(completed, true);
  assert.equal(f.backend.children.size, 0);
});

test('timeout kills the failed backend and allows a fresh startup', async t => {
  const f = fixture(t, { probe: async () => 0 });
  await assert.rejects(f.backend.start({ ...f.options, timeoutMs: 10 }), /did not become ready/);
  assert.equal(f.processes[0].killed, true);
  assert.equal(f.backend.current, null);
  f.backend.probe = async () => 200;
  await f.backend.start(f.options);
  assert.equal(f.processes.length, 2);
});

test('process exit aborts readiness polling immediately and surfaces its error', async t => {
  let readyToProbe;
  const probing = new Promise(resolve => { readyToProbe = resolve; });
  const f = fixture(t, { probe: async () => { readyToProbe(); return 0; }, pollMs: 5000 });
  const pending = f.backend.start(f.options);
  await probing;
  f.processes[0].emit('exit', 7);
  await assert.rejects(pending, /code=7/);
  assert.equal(f.backend.current, null);
});

test('DSH launch authentication is captured across chunks, scoped to its own server and redacted from logs', async t => {
  const logs = [], visited = [];
  let waiting;
  const probing = new Promise(resolve => { waiting = resolve; });
  const f = fixture(t, { log: line => logs.push(line), probe: async url => { visited.push(url); waiting(); return url.includes('token=local-token') ? 303 : 401; } });
  const pending = f.backend.start(f.options); await probing;
  f.processes[0].stdout.emit('data', 'dsh web: http://other.invalid/?token=untrusted\n');
  f.processes[0].stdout.emit('data', 'dsh web: http://127.0.0.1:19097/?tok');
  f.processes[0].stdout.emit('data', 'en=local-token\n');
  assert.deepEqual(await pending, { url: 'http://127.0.0.1:19097/?token=local-token', origin: 'http://127.0.0.1:19097' });
  assert.ok(visited.every(url => url.startsWith('http://127.0.0.1:19097')));
  assert.ok(!logs.join('\n').includes('local-token')); assert.ok(!logs.join('\n').includes('untrusted'));
});
