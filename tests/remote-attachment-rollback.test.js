'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AttachmentBatch } = require('../src/main/remote/attachment-batch');
const { RemoteCommands } = require('../src/main/remote/commands');
const { removeTree } = require('./test-fs.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-attachment-rollback-'));
  const conversation = { id: 'conversation', currentEngine: 'codex', seq: 1 }, rows = [{ role: 'user', seq: 1, text: 'Original' }], errors = [];
  const manager = { items: new Map([[conversation.id, conversation]]), controlStarts: new Map(), busy: () => false,
    messages: () => rows, rawRows: () => rows, onEvent() {}, publishActivity() {}, log: value => errors.push(value),
    async send() { throw new Error('Rejected before commit'); } };
  const reader = { manager, conversation: (_device, id) => manager.items.get(id) };
  const commands = new RemoteCommands({ file: path.join(root, 'remote', 'commands.json'), reader,
    access: { devices: [{ id: 'device', permission: 'control' }] } });
  t.after(() => { commands.queue.closed = true; removeTree(root); });
  const payload = { action: 'send', requestId: randomUUID(), prompt: 'Read file', expectedSeq: 1,
    attachments: [{ name: 'notes.txt', isImage: false, data: Buffer.from('owned bytes').toString('base64') }] };
  const send = patch => commands.perform('device', conversation.id, { ...payload, ...patch });
  const files = folder => fs.existsSync(path.join(root, 'remote', folder)) ? fs.readdirSync(path.join(root, 'remote', folder)) : [];
  return { root, conversation, rows, manager, commands, errors, send, files, payload };
}

for (const legacy of [false, true]) test('failed uncommitted remote send rolls back ' + (legacy ? 'legacy JPEG copies' : 'file copies'), async t => {
  const h = setup(t);
  const patch = legacy ? { attachments: undefined, image: Buffer.from([255, 216, 255, 217]).toString('base64') } : {};
  await assert.rejects(h.send(patch), /Rejected before commit/);
  assert.deepEqual(h.files(legacy ? 'mobile-images' : 'device-attachments'), []);
  assert.equal(h.commands.pendingAttachments.size, 0); assert.deepEqual(h.errors, []);
});

test('queue rejection removes only files created by the rejected request', async t => {
  const h = setup(t), directory = path.join(h.root, 'remote', 'device-attachments');
  fs.mkdirSync(directory); const existing = path.join(directory, 'existing.txt'); fs.writeFileSync(existing, 'keep');
  h.commands.queue.add = () => { throw new Error('Queue full'); };
  await assert.rejects(h.send({ queue: true }), /Queue full/);
  assert.deepEqual(h.files('device-attachments'), ['existing.txt']);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');
});

test('a queue write followed by an error retains its durable attachment even if the in-memory entry was removed', async t => {
  const h = setup(t);
  h.commands.queue.save = () => {
    fs.writeFileSync(h.commands.queue.file, JSON.stringify(h.commands.queue.entries));
    throw new Error('Post-write failure');
  };
  await assert.rejects(h.send({ queue: true }), /Post-write failure/);
  assert.equal(h.commands.queue.entries.length, 0); assert.equal(h.files('device-attachments').length, 1);
  const saved = JSON.parse(fs.readFileSync(h.commands.queue.file, 'utf8'));
  assert.equal(fs.readFileSync(saved[0].payload.attachments[0].path, 'utf8'), 'owned bytes');
});

test('engine failure after a committed user row retains the attached file', async t => {
  const h = setup(t);
  h.manager.send = async (_engine, payload) => {
    h.rows.push({ role: 'user', seq: ++h.conversation.seq, attachments: payload.attachments });
    throw new Error('Native startup failed');
  };
  await assert.rejects(h.send(), /Native startup failed/);
  assert.equal(h.files('device-attachments').length, 1);
  assert.equal(fs.readFileSync(h.rows.at(-1).attachments[0].path, 'utf8'), 'owned bytes');
});

test('resend failure after replacing the same-sequence user row preserves its new attachment', async t => {
  const h = setup(t);
  h.manager.send = async (_engine, payload) => {
    h.rows[0] = { ...h.rows[0], attachments: payload.attachments }; throw new Error('Resend startup failed');
  };
  await assert.rejects(h.send({ action: 'resend', editSeq: 1 }), /Resend startup failed/);
  assert.equal(h.conversation.seq, 1); assert.equal(h.files('device-attachments').length, 1);
});

test('corrupt saved queue prevents an uncertain rollback and reports the verification failure', async t => {
  const h = setup(t);
  fs.writeFileSync(h.commands.queue.file, '{torn');
  await assert.rejects(h.send(), /Rejected before commit/);
  assert.equal(h.files('device-attachments').length, 1); assert.equal(h.errors.length, 1);
});

test('pending sends expose an attachment lease until they settle', async t => {
  const h = setup(t); let finish;
  h.manager.send = () => new Promise(resolve => { finish = resolve; });
  const pending = h.send();
  assert.equal(h.commands.pendingAttachments.size, 1);
  const leased = h.commands.pendingAttachments.get(h.payload.requestId);
  assert.equal(leased.length, 1); assert.ok(fs.existsSync(leased[0].path));
  finish({ ok: true }); await pending;
  assert.equal(h.commands.pendingAttachments.size, 0); assert.ok(fs.existsSync(leased[0].path));
});

test('rollback retains changed files and hard links rather than deleting another owner\'s file', t => {
  const h = setup(t), directory = path.join(h.root, 'remote');
  const changed = path.join(directory, 'changed.txt'), linked = path.join(directory, 'linked.txt');
  fs.writeFileSync(changed, 'before'); fs.writeFileSync(linked, 'shared');
  const batch = new AttachmentBatch(directory, error => h.errors.push(error.message));
  batch.add([{ path: changed }, { path: linked }]);
  fs.writeFileSync(changed, 'different bytes'); fs.linkSync(linked, path.join(h.root, 'other.txt'));
  batch.rollback(() => false);
  assert.ok(fs.existsSync(changed)); assert.ok(fs.existsSync(linked)); assert.equal(h.errors.length, 2);
});
