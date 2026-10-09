'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { DiscussionAssets } = require('../src/engines/discussions/assets');
const { createDataPackage, importDataPackage } = require('../src/main/data-migration');
const { removeTree } = require('./test-fs.cjs');
const proof = d => ({ stopped: true, released: true, runtimeId: d.runtimeId, deliveryId: d.id, generation: d.generation });
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-migration-'));
  const source = { dataDir: path.join(root, 'source'), home: path.join(root, 'source-home') };
  const target = { dataDir: path.join(root, 'target'), home: path.join(root, 'target-home') };
  for (const dir of [source.dataDir, source.home, target.dataDir, target.home]) fs.mkdirSync(dir);
  const manager = new DiscussionManager({ dir: path.join(source.dataDir, 'discussions') });
  t.after(() => {
    for (const entry of manager.store.drafts.entries.values()) clearTimeout(entry.timer);
    manager.store.drafts.entries.clear(); removeTree(root);
  });
  const group = manager.create({ cwd: path.join(source.dataDir, 'discussions', 'work', 'fixture') });
  const member = manager.addMember(group.id, { name: 'A', engine: 'codex', connection: 'api', model: 'fixture', providerId: 'provider', keyId: 'key', contextWindow: 1000000 });
  const assets = new DiscussionAssets(manager.store.dir);
  const attachments = assets.importData(group.id, [{ name: 'report.txt', bytes: Buffer.from('attachment contents'), isImage: false }]);
  const text = 'Input at ' + attachments[0].path + '\n' + 'public input '.repeat(2000);
  const request = manager.enqueue(group.id, { requestId: 'turn', text, participantIds: [member.id], attachments });
  const d = manager.prepare(group.id, request.deliveryIds[0]);
  manager.saveInput(group.id, d.id, d.generation, { prompt: 'Frozen at ' + source.dataDir + '\n' + 'input '.repeat(5000), inputThroughSeq: d.inputThroughSeq, attachments });
  manager.start(group.id, d.id, d.generation, 'native-' + d.runtimeId);
  fs.mkdirSync(path.join(source.dataDir, 'codex', 'api', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(source.dataDir, 'codex', 'api', 'sessions', 'native-context.jsonl'), 'private native reasoning and tool state\n');
  fs.writeFileSync(path.join(source.dataDir, 'desktop-config.json'), '{"language":"zh-CN"}');
  return { root, source, target, manager, group, d, attachments, file: path.join(root, 'profile.zip') };
}
function finish(h) {
  const answer = 'Answer at ' + h.source.dataDir + '\n' + 'result '.repeat(5000);
  h.manager.recordSettlement(h.group.id, h.d.id, h.d.generation, { status: 'completed', text: answer });
  h.manager.complete(h.group.id, h.d.id, h.d.generation, answer, proof(h.d));
  return answer;
}

test('conversation-only migration carries manifests, rehashed payloads, attachments and intact native context together', async t => {
  const h = setup(t), answer = finish(h), before = h.manager.get(h.group.id);
  await createDataPackage({ ...h.source, destination: h.file });
  await importDataPackage({ ...h.target, file: h.file, scope: 'conversations' });
  const restored = new DiscussionManager({ dir: path.join(h.target.dataDir, 'discussions') });
  const state = restored.get(h.group.id);
  assert.equal(state.cwd, before.cwd.replace(h.source.dataDir, h.target.dataDir));
  assert.equal(state.messages[1].text, answer.replace(h.source.dataDir, h.target.dataDir));
  assert.equal(state.deliveries[0].inputPlan.prompt, before.deliveries[0].inputPlan.prompt.replace(h.source.dataDir, h.target.dataDir));
  assert.equal(state.messages[0].attachments[0].path, h.attachments[0].path.replace(h.source.dataDir, h.target.dataDir));
  new DiscussionAssets(restored.store.dir).resolve(h.group.id, state.messages[0].attachments);
  assert.equal(state.participants[0].session.nativeId, before.participants[0].session.nativeId);
  assert.deepEqual(state.participants[0].session.nativeOwnMessageIds, before.participants[0].session.nativeOwnMessageIds);
  assert.equal(state.participants[0].session.coveredThroughSeq, before.participants[0].session.coveredThroughSeq);
  assert.equal(fs.readFileSync(path.join(h.target.dataDir, 'codex', 'api', 'sessions', 'native-context.jsonl'), 'utf8'), 'private native reasoning and tool state\n');
  assert.equal(fs.existsSync(path.join(h.target.dataDir, 'desktop-config.json')), false);
  restored.recover(); assert.equal(restored.get(h.group.id).messages[1].text, state.messages[1].text);
});

test('settings-only migration never separates group state from its conversation payloads', async t => {
  const h = setup(t); finish(h);
  await createDataPackage({ ...h.source, destination: h.file });
  await importDataPackage({ ...h.target, file: h.file, scope: 'settings' });
  assert.equal(fs.existsSync(path.join(h.target.dataDir, 'discussions')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.target.dataDir, 'desktop-config.json'), 'utf8')).language, 'zh-CN');
});

test('pending checkpoint migration keeps latest draft and startup recovery retains original native ownership', async t => {
  const h = setup(t);
  h.manager.partial(h.group.id, h.d.id, h.d.generation, 'first');
  h.manager.partial(h.group.id, h.d.id, h.d.generation, 'latest at ' + h.source.dataDir);
  h.manager.store.close();
  await createDataPackage({ ...h.source, destination: h.file });
  await importDataPackage({ ...h.target, file: h.file, scope: 'conversations' });
  const restored = new DiscussionManager({ dir: path.join(h.target.dataDir, 'discussions') });
  assert.equal(restored.get(h.group.id).deliveries[0].partialText, 'latest at ' + h.target.dataDir);
  restored.recover(); const state = restored.get(h.group.id);
  assert.equal(state.deliveries[0].status, 'interrupted');
  assert.equal(state.deliveries[0].partialText, 'latest at ' + h.target.dataDir);
  assert.equal(state.messages.length, 1); assert.equal(state.participants[0].retiredSessions[0].nativeId, 'native-' + h.d.runtimeId);
  assert.equal(state.participants[0].retiredSessions[0].recoveryRequired, true);
});

test('a corrupt referenced payload rejects the import before any target profile file is replaced', async t => {
  const h = setup(t); finish(h);
  const encoded = JSON.parse(fs.readFileSync(h.manager.store.file(h.group.id), 'utf8'));
  const ref = encoded.messages[1].text, payload = path.join(h.manager.store.dir, h.group.id + '.payloads', ref.$text + '.text');
  const bytes = fs.readFileSync(payload); bytes[bytes.length - 2] = 65; fs.writeFileSync(payload, bytes);
  fs.writeFileSync(path.join(h.target.dataDir, 'desktop-config.json'), '{"language":"en"}');
  await createDataPackage({ ...h.source, destination: h.file });
  await assert.rejects(importDataPackage({ ...h.target, file: h.file }), /Invalid discussion payload storage/);
  assert.equal(fs.readFileSync(path.join(h.target.dataDir, 'desktop-config.json'), 'utf8'), '{"language":"en"}');
  assert.equal(fs.existsSync(path.join(h.target.dataDir, 'discussions')), false);
});

test('failed payload installation rolls back the manifest and leaves previous native context usable', async t => {
  const h = setup(t); finish(h);
  await createDataPackage({ ...h.source, destination: h.file });
  await importDataPackage({ ...h.target, file: h.file });
  const restored = new DiscussionManager({ dir: path.join(h.target.dataDir, 'discussions') }), before = restored.get(h.group.id);
  h.manager.enqueue(h.group.id, { requestId: 'new-note', text: 'new '.repeat(6000) });
  await createDataPackage({ ...h.source, destination: h.file });
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (String(from).includes('.camellia-import-') && String(to).endsWith('.text')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename.call(fs.promises, from, to);
  });
  await assert.rejects(importDataPackage({ ...h.target, file: h.file }), error => error.rolledBack === true);
  assert.deepEqual(restored.get(h.group.id), before);
});
