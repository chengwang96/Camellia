'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { DiscussionService } = require('../src/engines/discussions/service');
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');
const { removeTree } = require('./test-fs.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await tick(); assert.ok(predicate()); }
function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-rich-')); t.after(() => removeTree(dataDir));
  const binding = { engine: 'codex', connection: 'api', model: 'synthetic', accountRef: 'fixture', thinking: '', contextWindow: 64000 };
  const calls = []; let generation = 0;
  const adapter = { runtime: { version: 'test', policyVersion: 'test' },
    evidence: p => ({ kind: 'real', reference: 'synthetic-rich-test-only', bindingFingerprint: bindingFingerprint(p), runtimeVersion: 'test', policyVersion: 'test', mode: 'native-tools', supportsImages: true,
      checks: Object.fromEntries(['isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'permissionsRouted', 'workspaceQueue'].map(key => [key, true])) }),
    create(identity) {
      const runId = ++generation; let respond, release;
      return {
        async execute({ plan, onEvent, signal }) {
          calls.push({ identity, plan }); onEvent({ ...identity, type: 'started', nativeId: identity.nativeId || randomUUID() });
          if (!plan.prompt.includes('ASK_TO_WRITE')) return { text: 'Synthetic attachment reply' };
          onEvent({ ...identity, type: 'tool', tool: { id: 'write', name: 'Write', input: { file_path: path.join(identity.cwd, 'result.txt') }, status: 'running' } });
          const allow = await new Promise(resolve => {
            release = () => resolve(false); signal.addEventListener('abort', release, { once: true });
            respond = answer => { resolve(answer.allow); return true; };
            onEvent({ ...identity, type: 'permission', permission: { runId, requestId: 'same-native-id', toolName: 'Write', input: { file_path: path.join(identity.cwd, 'result.txt') } } });
          });
          signal.removeEventListener('abort', release);
          if (allow) fs.writeFileSync(path.join(identity.cwd, 'result.txt'), 'Fixture output');
          onEvent({ ...identity, type: 'tool', tool: { id: 'write', output: allow ? 'Saved' : 'Denied', status: allow ? 'completed' : 'failed' } });
          return { text: allow ? 'Saved [result](result.txt)' : 'Write denied' };
        },
        respond(answer) { return answer.runId === runId && respond(answer); },
        cancel() { release?.(); }, async stop() { release?.(); return { ...identity, stopped: true, released: true }; },
      };
    },
  };
  const options = { dataDir, platform: 'win32', adapters: { codex: adapter }, getCatalog: () => [{ binding }] };
  const service = new DiscussionService(options); t.after(() => service.shutdown());
  async function group() {
    const state = (await service.call('create', { title: 'Rich fixture' })).group;
    for (const name of ['Scientist', 'Programmer']) await service.call('add-member', { id: state.id, bindingId: bindingFingerprint(binding), name });
    return (await service.call('load', { id: state.id })).group;
  }
  return { service, group, dataDir, calls, options, adapter };
}
test('native tool members serialize directory access and permission answers cannot cross groups or runs', async t => {
  const h = setup(t), group = await h.group(), other = await h.group();
  await h.service.call('send', { id: group.id, requestId: 'write', text: 'ASK_TO_WRITE', participantIds: group.participants.map(p => p.id), mode: 'parallel' });
  await until(() => h.service.scheduler.permissions(group.id).length === 1);
  assert.equal(h.calls.length, 1);
  const first = h.service.scheduler.permissions(group.id)[0];
  await assert.rejects(h.service.call('permission-response', { ...first, id: other.id, allow: true }), /no longer active/);
  await assert.rejects(h.service.call('permission-response', { ...first, id: group.id, runId: first.runId + 1, allow: true }), /no longer active/);
  await h.service.call('permission-response', { ...first, id: group.id, allow: true });
  await until(() => h.calls.length === 2 && h.service.scheduler.permissions(group.id).length === 1);
  const second = h.service.scheduler.permissions(group.id)[0];
  assert.equal(second.requestId, first.requestId); assert.notEqual(second.runId, first.runId);
  await assert.rejects(h.service.call('permission-response', { ...first, id: group.id, allow: true }), /no longer active/);
  await h.service.call('permission-response', { ...second, id: group.id, allow: false });
  await until(() => !h.service.active);
  const state = (await h.service.call('load', { id: group.id })).group;
  assert.equal(state.deliveries[0].tools[0].status, 'completed'); assert.equal(state.deliveries[1].tools[0].status, 'failed');
  assert.equal(state.permissions.length, 0);
  assert.equal(fs.readFileSync(path.join(state.cwd, 'result.txt'), 'utf8'), 'Fixture output');
  assert.equal((await h.service.call('artifacts', { id: state.id, deliveryId: state.deliveries[0].id })).files[0].name, 'result.txt');
  const restarted = new DiscussionService(h.options); t.after(() => restarted.shutdown());
  assert.deepEqual((await restarted.call('load', { id: group.id })).group.deliveries.map(d => d.tools), state.deliveries.map(d => d.tools));
});
test('attachment-only sends use stable content, preserve history and reject changed or foreign assets before dispatch', async t => {
  const h = setup(t), group = await h.group(), other = await h.group();
  const original = path.join(h.dataDir, 'evidence.txt'); fs.writeFileSync(original, 'Evidence 42');
  const imported = await h.service.call('import-attachments', { id: group.id, paths: [original] });
  fs.unlinkSync(original);
  await assert.rejects(h.service.call('send', { id: other.id, text: '', requestId: 'foreign', participantIds: [], attachments: imported.attachments }), /belong/);
  await h.service.call('send', { id: group.id, text: '', requestId: 'files', participantIds: [group.participants[0].id], attachments: imported.attachments });
  await until(() => !h.service.active);
  assert.equal(h.calls[0].plan.attachments[0].sha256, imported.attachments[0].sha256);
  assert.equal(fs.readFileSync(h.calls[0].plan.attachments[0].path, 'utf8'), 'Evidence 42');
  await h.service.call('send', { id: group.id, text: 'Review the prior attachment', requestId: 'review', participantIds: [group.participants[1].id] });
  await until(() => !h.service.active);
  assert.match(h.calls[1].plan.prompt, /evidence.txt/); assert.equal(h.calls[1].plan.attachments.length, 1);
  fs.writeFileSync(imported.attachments[0].path, 'Changed');
  await assert.rejects(h.service.call('send', { id: group.id, text: '', requestId: 'changed', participantIds: [], attachments: imported.attachments }), /changed/);
  assert.equal(h.calls.length, 2);
});
test('unsupported image selection remains uncommitted; stopping invalidates a pending approval', async t => {
  const h = setup(t), group = await h.group();
  const evidence = h.adapter.evidence; h.adapter.evidence = p => ({ ...evidence(p), supportsImages: false });
  const file = path.join(h.dataDir, 'test.png'); fs.writeFileSync(file, 'image fixture');
  const { attachments } = await h.service.call('import-attachments', { id: group.id, paths: [file] });
  await assert.rejects(h.service.call('send', { id: group.id, text: '', requestId: 'image', participantIds: [group.participants[0].id], attachments }), /image input/);
  assert.equal(h.service.manager.get(group.id).messages.length, 0);
  await h.service.call('send', { id: group.id, text: 'Saved image note', requestId: 'image-note', participantIds: [], attachments });
  await assert.rejects(h.service.call('send', { id: group.id, text: 'Review the prior image', requestId: 'image-history', participantIds: [group.participants[0].id] }), /image input/);
  assert.equal(h.service.manager.get(group.id).messages.length, 1);
  h.adapter.evidence = evidence;
  await h.service.call('send', { id: group.id, text: 'ASK_TO_WRITE', requestId: 'stop', participantIds: [group.participants[0].id] });
  await until(() => h.service.scheduler.permissions(group.id).length === 1);
  const request = h.service.scheduler.permissions(group.id)[0];
  await h.service.call('stop', { id: group.id });
  await assert.rejects(h.service.call('permission-response', { ...request, id: group.id, allow: true }), /no longer active/);
  assert.equal(fs.existsSync(path.join(group.cwd, 'result.txt')), false);
  assert.equal(h.service.manager.get(group.id).deliveries.at(-1).tools[0].status, 'interrupted');
});

test('members can receive attachments from multiple turns; deleting a group removes its copies only', async t => {
  const h = setup(t), group = await h.group();
  const original = path.join(h.dataDir, 'many.txt'); fs.writeFileSync(original, 'Retain original');
  const first = (await h.service.call('import-attachments', { id: group.id, paths: Array(16).fill(original) })).attachments;
  await h.service.call('send', { id: group.id, text: 'First batch', requestId: 'batch1', participantIds: [], attachments: first });
  const second = (await h.service.call('import-attachments', { id: group.id, paths: [original] })).attachments;
  await h.service.call('send', { id: group.id, text: 'Review both batches', requestId: 'batch2', participantIds: [group.participants[0].id], attachments: second });
  await until(() => !h.service.active);
  assert.equal(h.calls[0].plan.attachments.length, 17);
  await h.service.call('delete', { id: group.id });
  assert.equal(fs.existsSync(first[0].path), false);
  assert.equal(fs.readFileSync(original, 'utf8'), 'Retain original');
});
