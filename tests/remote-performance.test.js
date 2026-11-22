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

test('read-only inspector commands do not wake remote subscribers', async t => {
  const h = createHarness(undefined, { runtimeLocator: () => null });
  t.after(() => h.cleanup());
  h.configureApi();
  h.api.codex.handlers['save-settings']({ connection: 'api', model: 'test-model' });
  const manager = h.api.sharedConversations;
  const conversation = manager.create('codex', undefined, 'Read-only inspector', h.root);
  let publishes = 0;
  h.api.setRemoteDesktop({ publish: () => { publishes++; } });
  for (const action of ['context-snapshot', 'context-blocks', 'agent-graph', 'context-memory-status', 'review-list']) {
    const result = await h.call('conversation-command', { engine: 'codex', action, payload: { sessionId: conversation.id } });
    assert.equal(result.ok, true, action + ': ' + result.error);
  }
  assert.equal(publishes, 0);
});

test('stream-only events do not dirty list subscriptions', t => {
  const gateway = new RemoteGateway({ reader: {} });
  const home = { device: { id: 'phone' }, id: null, kind: 'conversations', dirty: false };
  const detail = { device: { id: 'phone' }, id: 'conversation', kind: 'conversations', dirty: false };
  gateway.streams.add(home); gateway.streams.add(detail);
  t.after(() => { gateway.streams.clear(); clearTimeout(gateway.flushTimer); });
  gateway.publish({ type: 'stream_event', session_id: 'conversation' });
  assert.equal(home.dirty, false); assert.equal(detail.dirty, true);
  gateway.publish({ type: 'result', session_id: 'conversation' });
  assert.equal(home.dirty, true);
});

test('active output projections are shared until the run event sequence changes', () => {
  const reader = new RemoteReadModel({});
  const active = { eventSeq: 1, events: [{ type: 'stream_event', event: {
    type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Working' },
  } }] };
  const first = reader.activeOutput(active);
  assert.equal(first.text, 'Working');
  assert.equal(reader.activeOutput(active), first);
  active.eventSeq++;
  active.events.push({ type: 'stream_event', event: {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' more' },
  } });
  const next = reader.activeOutput(active);
  assert.notEqual(next, first);
  assert.equal(next.text, 'Working more');
});
