'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const { removeTree } = require('./test-fs.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function bridge(t, saved, config = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-cli-prepare-'));
  const file = path.resolve(__dirname, '../src/engines/antigravity/cli-bridge.cjs');
  const runtimeRequire = createRequire(file), timers = new Set(), replies = new Map(), children = [];
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  let sequence = 0;
  if (saved) {
    fs.mkdirSync(path.join(home, 'cli-sessions'));
    fs.writeFileSync(path.join(home, 'cli-sessions', saved.id + '.json'), JSON.stringify(saved));
  }
  const reader = createInterface({ input: output });
  reader.on('line', line => {
    const message = JSON.parse(line), reply = replies.get(message.id); if (!reply) return;
    replies.delete(message.id); message.error ? reply.reject(new Error(message.error.message)) : reply.resolve(message.result);
  });
  function close(child) {
    if (child.closed) return;
    child.closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', 0);
  }
  const context = vm.createContext({
    process: { env: { CAMELLIA_ANTIGRAVITY_CLI: JSON.stringify({ home, exe: 'fixture-cli', model: 'fixture-model', legacyStream: true, ...config }) },
      platform: 'win32', stdin: input, stdout: output, stderr: errors },
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    require(name) {
      if (name !== 'node:child_process') return runtimeRequire(name);
      return { spawn(exe, args) {
        if (exe === 'taskkill.exe') {
          const child = children.find(value => String(value.pid) === args[1]); assert.ok(child);
          queueMicrotask(() => close(child)); return new EventEmitter();
        }
        assert.equal(exe, 'fixture-cli');
        const child = Object.assign(new EventEmitter(), { pid: children.length + 100, args: [...args], stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), writes: [] });
        child.stdin.on('data', data => child.writes.push(String(data))); child.kill = () => close(child);
        children.push(child); return child;
      } };
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  t.after(() => {
    input.end(); children.forEach(close); reader.close();
    for (const stream of [input, output, errors, ...children.flatMap(child => [child.stdin, child.stdout, child.stderr])]) stream.destroy();
    removeTree(home);
  });
  function rpc(method, params = {}) {
    const id = ++sequence;
    const promise = new Promise((resolve, reject) => { replies.set(id, { resolve, reject }); });
    promise.catch(() => {}); input.write(JSON.stringify({ id, method, params }) + '\n'); return promise;
  }
  return { rpc, children, timers, metadata: id => JSON.parse(fs.readFileSync(path.join(home, 'cli-sessions', id + '.json'), 'utf8')),
    init(id) { children.at(-1).stdout.write(JSON.stringify({ event: 'init', conversation_id: id }) + '\n'); } };
}

test('CLI preparation is idempotent, persists before acknowledgement and sends no user input', async t => {
  const h = bridge(t), { sessionId } = await h.rpc('session/new', { cwd: process.cwd() });
  assert.equal(h.children.length, 0);
  const first = h.rpc('session/camellia_prepare', { sessionId }), second = h.rpc('session/camellia_prepare', { sessionId });
  assert.equal(h.children.length, 1); assert.deepEqual(h.children[0].writes, []);
  assert.equal(h.children[0].args.includes('--disable-slash-commands'), false);
  const conversationId = randomUUID(); h.init(conversationId);
  assert.deepEqual(await first, { sessionId, conversationId }); assert.deepEqual(await second, { sessionId, conversationId });
  assert.equal(h.metadata(sessionId).conversationId, conversationId);
  await assert.rejects(h.rpc('session/set_mode', { modeId: 'plan' }), /fixed/);
  await assert.rejects(h.rpc('session/set_config_option', { configId: 'model', value: 'changed' }), /fixed/);
  await assert.rejects(h.rpc('session/new', { cwd: process.cwd() }), /fixed/);
  const prompt = h.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'only explicit input' }] });
  assert.equal(h.children[0].writes.length, 1);
  h.children[0].stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n');
  assert.equal((await prompt).stopReason, 'end_turn');
});

test('CLI preparation rejects the wrong bridge identity without launching', async t => {
  const h = bridge(t); await h.rpc('session/new', { cwd: process.cwd() });
  await assert.rejects(h.rpc('session/camellia_prepare', { sessionId: 'another' }), /identity mismatch/);
  assert.equal(h.children.length, 0);
});

for (const resume of [false, true]) test(`CLI literal input disables expansion for ${resume ? 'resumed' : 'new'} native sessions`, async t => {
  const conversationId = randomUUID(), saved = resume ? { id: 'agy-' + randomUUID(), cwd: process.cwd(), conversationId } : null;
  const h = bridge(t, saved, { literalInput: true });
  const { sessionId } = await h.rpc(resume ? 'session/resume' : 'session/new', resume ? { sessionId: saved.id } : { cwd: process.cwd() });
  for (const modeId of ['plan', 'acceptEdits', 'bypassPermissions', 'unknown']) {
    await assert.rejects(h.rpc('session/set_mode', { modeId }), /cannot apply native permission modes/);
  }
  assert.equal(h.children.length, 0); await h.rpc('session/set_mode', { modeId: 'default' });
  const preparation = h.rpc('session/camellia_prepare', { sessionId }); h.init(conversationId); await preparation;
  const child = h.children[0]; assert.equal(child.args.filter(arg => arg === '--disable-slash-commands').length, 1);
  const text = '/compact\nThis is discussion content, including /skill-name and @a-member.';
  const prompt = h.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  assert.deepEqual(JSON.parse(child.writes[0]).message.content, [{ type: 'text', text }]);
  child.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n');
  assert.equal((await prompt).stopReason, 'end_turn');
});

for (const invalid of ['wrong-resume', 'malformed', 'cancel', 'timeout', 'exit']) test(`CLI preparation ${invalid} cannot admit input or retry a failed process`, async t => {
  const saved = invalid === 'wrong-resume' ? { id: 'agy-' + randomUUID(), cwd: process.cwd(), conversationId: randomUUID() } : null;
  const h = bridge(t, saved), { sessionId } = await h.rpc(saved ? 'session/resume' : 'session/new', saved ? { sessionId: saved.id } : { cwd: process.cwd() });
  const preparation = h.rpc('session/camellia_prepare', { sessionId });
  if (invalid === 'cancel') await h.rpc('session/cancel', { sessionId });
  else if (invalid === 'timeout') { [...h.timers][0].fn(); h.init(randomUUID()); }
  else if (invalid === 'exit') h.children[0].emit('close', 1);
  else h.init(invalid === 'malformed' ? '../wrong' : randomUUID());
  await assert.rejects(preparation, /identity|exited|timed out|cancelled/);
  await assert.rejects(h.rpc('session/camellia_prepare', { sessionId }), /failed or stopped/);
  await assert.rejects(h.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'must not send' }] }), /not succeeded/);
  assert.deepEqual(h.children[0].writes, []); assert.equal(h.children.length, 1);
  if (saved) assert.equal(h.metadata(sessionId).conversationId, saved.conversationId);
  await tick();
});
