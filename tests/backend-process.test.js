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
