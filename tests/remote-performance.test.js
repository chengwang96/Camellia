'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./main-process-harness.cjs');
const { readJson, writeJson } = require('../src/shared/json-store');
const { RemoteReadModel } = require('../src/main/remote/read-model');
const { RemoteGateway } = require('../src/main/remote/gateway');

test('remote list refreshes bound configuration reads across many conversations and observe later settings changes', async t => {
  const h = createHarness(undefined, { runtimeLocator: () => null });
  t.after(() => h.cleanup());
  h.configureApi();
  h.api.codex.handlers['save-settings']({ connection: 'api', model: 'test-model' });
  const manager = h.api.sharedConversations;
  for (let i = 0; i < 120; i++) manager.create('codex', undefined, 'Conversation ' + i, h.root);
  const configFile = path.join(h.userData, 'desktop-config.json');
  const routerFile = path.join(h.home, '.dsh', 'ollama-proxy.json');
  const device = { id: 'phone', permission: 'read', allWorkspaces: true, workspaceIds: [], includeUnassigned: true };
  const reader = new RemoteReadModel(manager);
  const gateway = new RemoteGateway({ reader });
  const counts = new Map();
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === configFile || file === routerFile) counts.set(file, (counts.get(file) || 0) + 1);
    return original(file, ...args);
  });
  const initial = gateway.streamSnapshot({ device, kind: 'conversations' });
  assert.equal(initial.conversationList.conversations.length, 100);
  assert.ok(initial.conversationList.conversations.every(row => row.model === 'test-model'));
  assert.equal(counts.get(configFile), 1, 'Desktop settings must not be parsed for every conversation and engine lookup');
  assert.equal(counts.get(routerFile), 1, 'Route settings must be shared by version hashing and the first page');
  counts.clear();
  const unchanged = gateway.streamSnapshot({ device, kind: 'conversations', listVersion: initial.listVersion });
  assert.deepEqual(unchanged, { listVersion: initial.listVersion });
  assert.equal(counts.get(configFile), 1);
  assert.equal(counts.get(routerFile), 1);
  const conversation = manager.items.values().next().value;
  const config = readJson(configFile);
  writeJson(configFile, { ...config, sharedMeta: { ...config.sharedMeta, titles: { ...config.sharedMeta?.titles, [conversation.id]: 'Renamed externally' } } });
  counts.clear();
  const changed = gateway.streamSnapshot({ device, kind: 'conversations', listVersion: initial.listVersion });
  assert.notEqual(changed.listVersion, initial.listVersion);
  assert.equal(counts.get(configFile), 1);
  assert.equal(reader.summary(conversation).title, 'Renamed externally');

  counts.clear();
  let frames = 0;
  gateway.writeFrame = () => { frames++; };
  for (const id of ['phone', 'tablet']) gateway.streams.add({ device: { ...device, id }, kind: 'conversations', dirty: true });
  gateway.scheduleFlush();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(frames, 2);
  assert.equal(counts.get(configFile), 1, 'Different devices share file reads during one synchronous flush');
  assert.equal(counts.get(routerFile), 1);
});
