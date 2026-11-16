'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RemoteAccess } = require('../src/main/remote/access');
const { RemoteReadModel } = require('../src/main/remote/read-model');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { endpointPath } = require('../src/main/remote/device-transport');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');
const { removeTree } = require('./test-fs.cjs');

async function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-workbench-'));
  let config = { sharedMeta: { workspaces: [{ id: 'visible', name: 'Visible', path: root }, { id: 'private', name: 'Private', path: root }] } };
  const drivers = Object.fromEntries(ENGINES.map(engine => [engine, { settings: () => ({ model: 'test' }), ensure() { throw new Error('Must not start an engine'); } }]));
  const manager = new SharedConversations({ dir: path.join(root, 'conversations'), drivers, loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; } });
  const access = new RemoteAccess({ file: path.join(root, 'devices.json') });
  const reader = new RemoteReadModel(manager);
  const gateway = new RemoteGateway({ access, reader, validateHost: host => host === '127.0.0.1' });
  await gateway.start('127.0.0.1', 0);
  context.after(async () => { await gateway.stop(); manager.closeGoalTools(); manager.pauseGoals(); removeTree(root); });
  const invitation = access.invite(['visible']);
  const pending = access.request({ code: invitation.code, name: 'Phone' });
  access.approve(pending.id);
  const credential = access.claim(pending.id, pending.claim), device = access.authenticate(credential.token);
  const request = (route, options = {}) => fetch(gateway.url + route, { ...options, headers: { Authorization: `Bearer ${credential.token}` } });
  return { manager, reader, gateway, access, device, request };
}

test('workbench includes all authorized activity beyond the first page and only ten recent rows without previews', async context => {
  const h = await fixture(context), states = new Map();
  h.manager.activity = id => states.get(id) || 'idle';
  const running = h.manager.create('codex', 'visible', 'Old but running');
  running.updatedAt = 1; states.set(running.id, 'running');
  const waiting = h.manager.create('kimi', 'visible', 'Waiting for approval');
  waiting.updatedAt = 2; states.set(waiting.id, 'permission');
  const background = h.manager.create('codex', 'visible', 'Background task'); background.updatedAt = 3;
  h.manager.backgroundStatus = id => id === background.id ? { tasks: [{ id: 'one', command: 'PRIVATE COMMAND', description: 'PRIVATE DESCRIPTION' }] } : null;
  for (let i = 0; i < 110; i++) { const row = h.manager.create('codex', 'visible', `Recent ${i}`); row.updatedAt = 100 + i; }
  const hidden = h.manager.create('kimi', 'private', 'PRIVATE TITLE'); states.set(hidden.id, 'running');
  const archived = h.manager.create('codex', 'visible', 'Archived'); states.set(archived.id, 'running');
  h.manager.workspaces.sessionMeta().archived[archived.id] = Date.now();
  h.reader.filePreview = () => { throw new Error('Home must never inspect files'); };
  const response = await h.request('/v1/workbench'); assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.conversations.length, 13);
  assert.ok(page.conversations.some(row => row.id === running.id));
  assert.ok(page.conversations.some(row => row.id === waiting.id));
  assert.equal(page.conversations.find(row => row.id === background.id).backgroundTaskCount, 1);
  assert.ok(!page.conversations.some(row => row.id === hidden.id || row.id === archived.id));
  assert.equal(page.conversations.filter(row => row.activity === 'idle' && !row.backgroundTaskCount).length, 10);
  assert.ok(!JSON.stringify(page).includes('PRIVATE'));
  assert.equal(page.conversations[3].title, 'Recent 109');
  const version = page.listVersion;
  running.seq += 1;
  assert.equal(h.reader.workbench(h.device).listVersion, version, 'Undisplayed stream counters do not trigger home traffic');
  states.set(running.id, 'idle');
  assert.notEqual(h.reader.workbench(h.device).listVersion, version);
});

test('workbench streams publish lightweight snapshots, observe scope changes and reject invalid routes', async context => {
  const h = await fixture(context);
  const row = h.manager.create('codex', 'visible', 'A task');
  assert.equal(endpointPath('/v1/workbench', 'GET'), '/v1/workbench');
  assert.equal(endpointPath('/v1/workbench/events', 'GET'), '/v1/workbench/events');
  assert.throws(() => endpointPath('/v1/workbench', 'POST'));
  assert.throws(() => endpointPath('/v1/workbench?offset=0', 'GET'));
  assert.equal((await h.request('/v1/workbench?offset=0')).status, 400);
  assert.equal((await h.request('/v1/workbench', { method: 'POST' })).status, 405);
  const missing = await fetch(h.gateway.url + '/v1/workbench'); assert.equal(missing.status, 401);
  const abort = new AbortController(); context.after(() => abort.abort());
  const response = await h.request('/v1/workbench/events', { signal: abort.signal });
  assert.equal(response.status, 200);
  const stream = response.body.getReader();
  const first = new TextDecoder().decode((await stream.read()).value);
  assert.ok(first.includes('"workbench"')); assert.ok(first.includes(row.id)); assert.ok(!first.includes('"conversationList"'));
  h.device.workspaceIds = []; h.gateway.publish();
  const next = new TextDecoder().decode((await stream.read()).value);
  assert.ok(next.includes('"conversations":[]'));
  h.access.revoke(h.device.id);
  assert.equal((await h.request('/v1/workbench')).status, 401);
  await stream.cancel();
});
