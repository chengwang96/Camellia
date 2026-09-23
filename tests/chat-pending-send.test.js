'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture() {
  const requests = [], replies = [], settings = deferred(), drafts = new Map(), cancellations = [];
  const state = {
    sharedChat: true, context: { sessionId: 'conversation-a', workspaceId: 'workspace-a' }, sessionOpenSeq: 1,
    sending: false, loadingSession: false, switchingEngine: false, running: false, conversationActivity: null,
    editingMessage: null, harnessId: 'codex', loadedEngine: 'codex', pendingForkId: null, currentRunId: null,
    input: { value: 'Continue' }, attachments: [], chatProfile: {}, statusText: '', eventsDuringRestore: [],
    sendBtn: { classList: { toggle() {} } }, pendingConversationSends: new Map(),
    goalUI: { isActive: () => false, isDraft: () => false },
    sidebar: { render() {}, load() {} }, chat: { querySelector: () => null, appendChild() {} },
    renderAttachments() {}, renderMessageQueue() {}, autoResize() {}, updateConversationControls() { state.updateSendEnabled(); },
    canChangeContext: () => !state.contextBusy(),
    draftKey: () => state.context.sessionId,
    writeUi: (key, value) => drafts.set(key, value), readUi: key => drafts.get(key),
    saveDraft: () => drafts.set('draft:' + state.context.sessionId, { text: state.input.value, attachments: state.attachments.slice() }),
    restoreDraft() { state.input.value = drafts.get('draft:' + state.context.sessionId)?.text || ''; },
    addUser: () => ({ messageData: {} }), buildPrompt: text => text,
    setRunning: value => { state.running = value; }, setStatus: text => { state.statusText = text; },
    handleEvent() {},
    setRunStatus() {}, clearRunStatus() {}, finalizeStreamBlocks() {}, updateSwitchHint() {},
    document: { createElement: () => ({}) },
    chatApi: {
      getSettings: () => settings.promise,
      send(payload) { requests.push(payload); const reply = deferred(); replies.push(reply); return reply.promise; },
      cancel: async payload => { cancellations.push(payload); return { ok: true }; },
    },
  };
  vm.createContext(state);
  vm.runInContext([
    extract('  function pendingConversationSend()', '  const draftKey'),
    extract('  function conversationBusy()', '  function canChangeContext()'),
    extract('  function updateSendEnabled()', '  async function steerQueuedMessage('),
    extract('  async function steerQueuedMessage(', '  async function send('),
    extract('  async function send(', '  function autoResize()'),
  ].join('\n'), state);
  const navigate = id => {
    assert.equal(state.contextBusy(), false);
    state.sessionOpenSeq++;
    state.sending = false;
    state.running = false;
    state.context.sessionId = id;
    state.context.workspaceId = 'workspace-' + id;
    state.currentRunId = null;
    state.restoringRun = false;
    state.input.value = '';
  };
  return { state, requests, replies, settings, drafts, cancellations, navigate };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('pending settings and compaction allow navigation without retargeting the request', async () => {
  const harness = fixture(), { state } = harness;
  const sending = state.send();
  assert.equal(state.sending, true);
  assert.equal(state.sendBtn.disabled, false);
  harness.navigate('conversation-b');
  harness.settings.resolve({ model: 'fixture' });
  await flush();
  assert.equal(harness.requests[0].sessionId, 'conversation-a');
  assert.equal(harness.requests[0].workspaceId, 'workspace-a');
  state.input.value = 'Message for B';
  const other = state.send();
  await flush();
  harness.replies[0].resolve({ ok: true, sessionId: 'conversation-a', runId: 1, userSeq: 1 });
  assert.equal(await sending, true);
  assert.equal(state.context.sessionId, 'conversation-b');
  assert.equal(state.sending, true);
  assert.equal(state.currentRunId, null);
  assert.equal(state.restoringRun, true);
  harness.replies[1].resolve({ ok: true, sessionId: 'conversation-b', runId: 2, userSeq: 1 });
  await other;
  assert.equal(state.currentRunId, 2);
  assert.equal(state.sending, false);
});

test('background send failure restores only its own draft and does not unlock another send', async () => {
  const harness = fixture(), { state } = harness;
  harness.settings.resolve({});
  const first = state.send();
  await flush();
  harness.navigate('conversation-b');
  state.input.value = 'B request';
  const second = state.send();
  await flush();
  harness.replies[0].resolve({ ok: false, error: 'Compaction canceled' });
  assert.equal(await first, false);
  assert.equal(state.sending, true);
  assert.equal(state.statusText, '');
  assert.equal(harness.drafts.get('draft:conversation-a').text, 'Continue');
  harness.replies[1].resolve({ ok: true, sessionId: 'conversation-b', runId: 2 });
  await second;
});

test('returning during pending compaction cannot dispatch a duplicate and can stop without a stale run ID', async () => {
  const harness = fixture(), { state } = harness;
  harness.settings.resolve({});
  const first = state.send();
  await flush();
  harness.navigate('conversation-b');
  harness.navigate('conversation-a');
  assert.equal(state.conversationBusy(), true);
  state.updateSendEnabled();
  assert.equal(state.sendBtn.disabled, false);
  await state.send();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.cancellations)), [{ sessionId: 'conversation-a' }]);
  assert.equal(harness.requests.length, 1);
  harness.replies[0].resolve({ ok: false, error: 'Compaction canceled' });
  await first;
  assert.equal(state.input.value, 'Continue');
  assert.equal(state.conversationBusy(), false);
});

test('new and legacy sessions retain their identity-assignment lock', async () => {
  for (const overrides of [{ sharedChat: false }, { context: { sessionId: null } }, { pendingForkId: 'source' }]) {
    const harness = fixture(), { state } = harness;
    Object.assign(state, overrides);
    const sending = state.send();
    assert.equal(state.contextBusy(), true);
    harness.settings.resolve({});
    await flush();
    harness.replies[0].resolve({ ok: true, sessionId: 'created', runId: 3 });
    await sending;
  }
});

test('stopping before settings resolve prevents dispatch and restores the draft', async () => {
  const harness = fixture(), { state } = harness;
  const pending = state.send();
  await state.send();
  assert.equal(state.statusText, 'Stopping…');
  harness.settings.resolve({});
  await pending;
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.cancellations.length, 0);
  assert.equal(state.input.value, 'Continue');
  assert.equal(state.sending, false);
  assert.equal(state.running, false);
  assert.equal(state.restoringRun, false);
  assert.equal(state.conversationBusy(), false);
});

test('returning with a nonempty composer cannot steer or duplicate a pending send', async () => {
  const harness = fixture(), { state } = harness;
  const pending = state.send();
  harness.settings.resolve({});
  await flush();
  harness.navigate('conversation-b');
  harness.navigate('conversation-a');
  state.input.value = 'A new instruction';
  state.updateSendEnabled();
  assert.equal(state.sendBtn.disabled, true);
  await state.send();
  assert.equal(harness.requests.length, 1);
  assert.equal(state.input.value, 'A new instruction');
  harness.replies[0].resolve({ ok: false, error: 'Canceled' });
  await pending;
  assert.equal(state.input.value, 'A new instruction');
  assert.equal(state.conversationBusy(), false);
});

test('late failure preserves a newer saved draft in the originating conversation', async () => {
  const harness = fixture(), { state } = harness;
  const pending = state.send();
  harness.settings.resolve({});
  await flush();
  harness.navigate('conversation-b');
  harness.drafts.set('draft:conversation-a', { text: 'New draft', attachments: [] });
  harness.replies[0].resolve({ ok: false, error: 'Canceled' });
  await pending;
  assert.equal(harness.drafts.get('draft:conversation-a').text, 'New draft');
  assert.equal(state.input.value, '');
});

test('same-view completion preserves text typed while sending', async () => {
  for (const ok of [true, false]) {
    const harness = fixture(), { state } = harness;
    const pending = state.send();
    harness.settings.resolve({});
    await flush();
    state.input.value = 'Next draft';
    harness.replies[0].resolve({ ok, error: 'Canceled', sessionId: 'conversation-a', runId: 1 });
    await pending;
    assert.equal(state.input.value, 'Next draft');
    assert.equal(harness.drafts.get('draft:conversation-a').text, 'Next draft');
  }
});

for (const returnToOrigin of [false, true]) {
  test(`queue preflight cannot follow navigation (returned=${returnToOrigin})`, async () => {
    const harness = fixture(), { state } = harness;
    const preflight = deferred();
    Object.assign(state, {
      loadedEngine: 'claude', drainingQueue: false, conversationQueues: new Map(),
      messageQueue: [{ text: 'Queued for A', attachments: [{ path: 'D:/queued.csv' }] }],
      window: { dshDesktop: { workbenchSettings: () => preflight.promise } },
    });
    vm.runInContext([
      extract('  function saveMessageQueue(', "  window.addEventListener('beforeunload'"),
      extract('  function drainMessageQueue()', "  $('attachBtn').addEventListener"),
    ].join('\n'), state);
    state.saveMessageQueue();
    state.drainMessageQueue();
    harness.navigate('conversation-b');
    state.drainingQueue = false;
    state.restoreMessageQueue();
    state.messageQueue.push({ text: 'Queued for B', attachments: [] });
    state.saveMessageQueue();
    if (returnToOrigin) {
      harness.navigate('conversation-a');
      state.restoreMessageQueue();
    }
    state.input.value = 'New composer draft';
    harness.settings.resolve({});
    preflight.resolve({ conversations: { warnOnSwitch: false } });
    await flush();
    for (const reply of harness.replies) reply.resolve({ ok: true, sessionId: state.context.sessionId, runId: 1 });
    await flush();
    assert.equal(harness.requests.length, 0);
    assert.equal(state.conversationQueues.get('conversation-a')[0].text, 'Queued for A');
    assert.equal(state.conversationQueues.get('conversation-a')[0].attachments[0].path, 'D:/queued.csv');
    assert.equal(state.conversationQueues.get('conversation-b')[0].text, 'Queued for B');
    assert.equal(state.input.value, 'New composer draft');
    assert.equal(state.sending, false);
    assert.equal(state.drainingQueue, false);
  });
}

test('queue preflight rechecks busy state before dispatch', async () => {
  for (const overrides of [
    { loadingSession: true }, { sending: true }, { switchingEngine: true },
    { editingMessage: {} }, { running: true }, { conversationActivity: 'running' },
    { pendingConversationSends: new Map([['conversation-a', {}]]) },
    { goalUI: { isActive: () => true } },
  ]) {
    const harness = fixture(), { state } = harness;
    const preflight = deferred();
    state.loadedEngine = 'claude';
    state.window = { dshDesktop: { workbenchSettings: () => preflight.promise } };
    const pending = state.send({ text: 'Queued for A', attachments: [] });
    Object.assign(state, overrides);
    harness.settings.resolve({});
    preflight.resolve({});
    await flush();
    for (const reply of harness.replies) reply.resolve({ ok: true, sessionId: 'conversation-a', runId: 1 });
    await pending;
    assert.equal(harness.requests.length, 0);
    assert.equal(state.input.value, 'Continue');
  }
});

test('queue preflight still sends when the original conversation remains idle', async () => {
  const harness = fixture(), { state } = harness;
  state.loadedEngine = 'claude';
  state.window = { dshDesktop: { workbenchSettings: async () => ({}) } };
  harness.settings.resolve({});
  const pending = state.send({ text: 'Queued for A', attachments: [{ path: 'D:/queued.csv' }] });
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].sessionId, 'conversation-a');
  assert.equal(harness.requests[0].displayText, 'Queued for A');
  assert.equal(harness.requests[0].attachments[0].path, 'D:/queued.csv');
  harness.replies[0].resolve({ ok: true, sessionId: 'conversation-a', runId: 1 });
  assert.equal(await pending, true);
  assert.equal(state.input.value, 'Continue');
});
