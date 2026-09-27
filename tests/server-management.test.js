'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createServerManagement } = require('../src/main/remote/server-management');
const { removeManagedRuntime } = require('../src/cli/managed-runtime');
const { removeTree } = require('./test-fs.cjs');

test('remote management journals identity, scopes results and never repeats an operation', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-management-'));
  context.after(() => removeTree(root));
  const file = path.join(root, 'jobs.json');
  let calls = 0, release;
  const service = createServerManagement({ file, command: async () => { calls++; await new Promise(resolve => { release = resolve; }); return { ok: true, result: { removed: true } }; } });
  const request = { requestId: randomUUID(), action: 'runtime-uninstall', payload: { engine: 'codex', confirmed: true } };
  assert.equal(service.submit('first', request).state, 'running');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.submit('first', request).state, 'running');
  assert.equal(calls, 1);
  assert.throws(() => service.get('second', request.requestId), /not found/);
  assert.throws(() => service.submit('first', { ...request, payload: { engine: 'kimi', confirmed: true } }), /already used/);
  assert.throws(() => service.submit('first', { ...request, requestId: randomUUID() }), /Wait/);
  const restored = createServerManagement({ file, command: () => assert.fail('Must not replay after restart') });
  assert.equal(restored.submit('first', request).state, 'unknown');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.get('first', request.requestId).state, 'complete');
  assert.equal(service.submit('first', request).result.removed, true);
  assert.throws(() => service.submit('first', { ...request, action: 'set-api-enabled' }), /Invalid/);
  assert.throws(() => service.submit('first', { ...request, payload: { engine: 'codex' } }), /confirmation/);
  assert.throws(() => service.submit('first', { ...request, payload: { engine: 'codex', confirmed: true, command: 'rm' } }), /Unsupported/);
});

test('uninstall only removes a validated managed runtime, preserving conversations and accounts', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-runtime-'));
  context.after(() => removeTree(root));
  const target = path.join(root, 'runtimes', 'codex');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'runtime'), 'binary');
  fs.writeFileSync(path.join(root, 'account'), 'account');
  assert.throws(() => removeManagedRuntime(root, 'codex', { external: true, dir: target }), /Only server/);
  assert.throws(() => removeManagedRuntime(root, '../other', {}), /Unsupported/);
  assert.throws(() => removeManagedRuntime(root, 'codex', { dir: path.dirname(root) }), /Only server/);
  assert.deepEqual(removeManagedRuntime(root, 'codex', { dir: target }), { removed: true });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(root, 'account'), 'utf8'), 'account');
});

test('runtime uninstall refuses a junction escaping the server data directory', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-runtime-link-'));
  context.after(() => removeTree(root));
  const dataDir = path.join(root, 'data'), outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(dataDir, 'runtimes'), { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'safe');
  const target = path.join(dataDir, 'runtimes', 'codex');
  fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => removeManagedRuntime(dataDir, 'codex', { dir: target }), /Linked/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'safe');
});

test('read-only management results stay out of the durable mutation journal', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-management-read-'));
  context.after(() => removeTree(root));
  const file = path.join(root, 'jobs.json');
  const service = createServerManagement({ file, command: async () => ({ ok: true, result: { value: 'read result' } }) });
  const request = { requestId: randomUUID(), action: 'settings', payload: {} };
  service.submit('device', request); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.get('device', request.requestId).result.value, 'read result');
  assert.equal(fs.existsSync(file), false);
});
