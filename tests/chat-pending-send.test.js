'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/chat.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture() {
  const requests = [], requestEngines = [], replies = [], settings = deferred(), drafts = new Map(), cancellations = [];
  const state = {
    sharedChat: true, context: { sessionId: 'conversation-a', workspaceId: 'workspace-a' }, sessionOpenSeq: 1,
    sending: false, loadingSession: false, switchingEngine: false, running: false, conversationActivity: null,
    editingMessage: null, harnessId: 'codex', loadedEngine: 'codex', pendingForkId: null, currentRunId: null, currentFastMode: false,
    input: { value: 'Continue' }, attachments: [], chatProfile: {}, statusText: '', eventsDuringRestore: [],
    messageQueue: [], messageQueuePaused: false, conversationQueues: new Map(), drainingQueue: false,
    sendBtn: { classList: { toggle() {} } }, pendingConversationSends: new Map(),
    goalUI: { isActive: () => false, isDraft: () => false },
    sidebar: { render() {}, load() {} }, chat: { querySelector: () => null, querySelectorAll: () => [], appendChild() {} },
    renderAttachments() {}, renderMessageQueue() {}, drainMessageQueue() {}, autoResize() {}, updateConversationControls() { state.updateSendEnabled(); },
    maybeScroll() {},
    canChangeContext: () => !state.contextBusy(),
    draftKey: () => state.context.sessionId,
    writeUi: (key, value) => drafts.set(key, value), readUi: key => drafts.get(key),
    saveDraft: () => drafts.set('draft:' + state.context.sessionId, { text: state.input.value, attachments: state.attachments.slice() }),
    restoreDraft() { state.input.value = drafts.get('draft:' + state.context.sessionId)?.text || ''; },
    addUser: () => ({ messageData: {} }), buildPrompt: text => text,
    showFailedSend: attempt => { state.failedSend = attempt; },
    setRunning: value => { state.running = value; }, setStatus: text => { state.statusText = text; },
    handleEvent() {}, clearTextChoice() {},
    setRunStatus() {}, clearRunStatus() {}, finalizeStreamBlocks() {}, updateSwitchHint() {},
    document: { createElement: () => ({}) },
    chatApi: {
      getSettings: () => settings.promise,
      send(payload, engine) { requests.push(payload); requestEngines.push(engine); const reply = deferred(); replies.push(reply); return reply.promise; },
      cancel: async payload => { cancellations.push(payload); return { ok: true }; },
    },
  };
  vm.createContext(state);
  vm.runInContext([
    extract('  function pendingConversationSend()', '  const draftKey'),
    extract('  function saveMessageQueue(', "  window.addEventListener('beforeunload'"),
    extract('  function canQueueComposerMessage()', '  function drainMessageQueue()'),
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
  return { state, requests, requestEngines, replies, settings, drafts, cancellations, navigate };
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
  assert.equal(harness.drafts.get('draft:conversation-a').text, '');
  assert.equal(state.context.sessionId, 'conversation-b');
  assert.equal(state.sending, true);
  assert.equal(state.currentRunId, null);
  assert.equal(state.restoringRun, true);
  harness.replies[1].resolve({ ok: true, sessionId: 'conversation-b', runId: 2, userSeq: 1 });
  await other;
  assert.equal(state.currentRunId, 2);
  assert.equal(state.sending, false);
});

test('pending settings keep the sending engine after navigating to another harness', async () => {
  const harness = fixture(), { state } = harness;
  const pending = state.send();
  harness.navigate('conversation-b');
  state.harnessId = state.loadedEngine = 'kimi';
  harness.settings.resolve({ model: 'codex-model' });
  await flush();
  assert.equal(harness.requestEngines[0], 'codex');
  assert.equal(harness.requests[0].sessionId, 'conversation-a');
  harness.replies[0].resolve({ ok: true, sessionId: 'conversation-a', runId: 1 });
  assert.equal(await pending, true);
  assert.equal(state.harnessId, 'kimi');
  assert.equal(state.context.sessionId, 'conversation-b');
});

test('background send failure keeps an edit action and does not unlock another send', async () => {
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
  assert.equal(harness.drafts.get('draft:conversation-a').text, '');
  assert.equal(harness.drafts.get('failed-send:conversation-a').text, 'Continue');
  harness.replies[1].resolve({ ok: true, sessionId: 'conversation-b', runId: 2 });
  await second;
});

test('a failed send preparation pauses a queue added during compaction', async () => {
  const harness = fixture(), { state } = harness;
  const pending = state.send();
  harness.settings.resolve({});
  await flush();
  state.input.value = 'After compaction';
  await state.send();
  assert.deepEqual(JSON.parse(JSON.stringify(state.messageQueue)), [{ text: 'After compaction', attachments: [] }]);
  assert.equal(state.messageQueuePaused, false);
  harness.replies[0].resolve({ ok: false, error: 'Compaction failed' });
  await pending;
  assert.equal(state.messageQueuePaused, true);
  assert.equal(harness.drafts.get('queue-paused:conversation-a'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.messageQueue)), [{ text: 'After compaction', attachments: [] }]);
  assert.equal(harness.requests.length, 1);
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
  assert.equal(state.input.value, '');
  assert.equal(state.failedSend.text, 'Continue');
  assert.equal(state.conversationBusy(), false);
});

test('new and forked sessions retain their identity-assignment lock', async () => {
  for (const overrides of [{ context: { sessionId: null } }, { pendingForkId: 'source' }]) {
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

test('returning with a nonempty composer queues behind a pending send without duplicating it', async () => {
  const harness = fixture(), { state } = harness;
  const pending = state.send();
  harness.settings.resolve({});
  await flush();
  harness.navigate('conversation-b');
  harness.navigate('conversation-a');
  state.input.value = 'A new instruction';
  state.updateSendEnabled();
  assert.equal(state.sendBtn.disabled, false);
  await state.send();
  assert.equal(harness.requests.length, 1);
  assert.equal(state.input.value, '');
  assert.deepEqual(state.messageQueue.map(message => message.text), ['A new instruction']);
  harness.replies[0].resolve({ ok: false, error: 'Canceled' });
  await pending;
  assert.equal(state.input.value, '');
  assert.deepEqual(state.messageQueue.map(message => message.text), ['A new instruction']);
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
  test(`queued sends reopen their own harness without following navigation (returned=${returnToOrigin})`, async () => {
    const harness = fixture(), { state } = harness;
    const preflight = deferred();
    const opened = [];
    Object.assign(state, {
      loadedEngine: 'claude', drainingQueue: false, conversationQueues: new Map(),
      messageQueue: [{ text: 'Queued for A', attachments: [{ path: 'D:/queued.csv' }] }],
      openHistorySession: id => { opened.push(id); return preflight.promise; },
    });
    vm.runInContext([
      extract('  function saveMessageQueue(', "  window.addEventListener('beforeunload'"),
      extract('  function drainMessageQueue()', "  const attachBtn = $('attachBtn');"),
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
    preflight.resolve({ ok: true });
    await flush();
    for (const reply of harness.replies) reply.resolve({ ok: true, sessionId: state.context.sessionId, runId: 1 });
    await flush();
    assert.equal(harness.requests.length, 0);
    assert.deepEqual(opened, ['conversation-a']);
    assert.equal(state.conversationQueues.get('conversation-a')[0].text, 'Queued for A');
    assert.equal(state.conversationQueues.get('conversation-a')[0].attachments[0].path, 'D:/queued.csv');
    assert.equal(state.conversationQueues.get('conversation-b')[0].text, 'Queued for B');
    assert.equal(state.input.value, 'New composer draft');
    assert.equal(state.sending, false);
    assert.equal(state.drainingQueue, false);
  });
}

test('busy states block queued sends before reopening another harness', async () => {
  for (const overrides of [
    { loadingSession: true }, { sending: true }, { switchingEngine: true },
    { editingMessage: {} }, { running: true }, { conversationActivity: 'running' },
    { pendingConversationSends: new Map([['conversation-a', {}]]) },
    { goalUI: { isActive: () => true } },
  ]) {
    const harness = fixture(), { state } = harness;
    state.loadedEngine = 'claude';
    state.window = { dshDesktop: { conversationSwitch: () => { assert.fail('Busy conversations must not reopen'); } } };
    Object.assign(state, overrides);
    await state.send({ text: 'Queued for A', attachments: [] });
    assert.equal(harness.requests.length, 0);
    assert.equal(state.input.value, 'Continue');
  }
});

test('a waiting Goal accepts an immediate composer instruction', async () => {
  const harness = fixture(), { state } = harness;
  state.goalUI = { isActive: () => true, isDraft: () => false, waitingId: () => 'goal-waiting' };
  state.updateSendEnabled();
  assert.equal(state.sendBtn.disabled, false);
  harness.settings.resolve({});
  const pending = state.send();
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].goalId, 'goal-waiting');
  assert.equal(harness.requests[0].prompt, 'Continue');
  harness.replies[0].resolve({ ok: true, sessionId: 'conversation-a', runId: 2, userSeq: 3 });
  assert.equal(await pending, true);
});

test('queued instructions require a live run or an idle waiting Goal and respect send locks', () => {
  const { state } = fixture();
  assert.equal(state.canSteerQueuedMessage(), false);
  state.goalUI = { isActive: () => true, isDraft: () => false, waitingId: () => 'goal-waiting' };
  assert.equal(state.canSteerQueuedMessage(), true);
  for (const lock of ['drainingQueue', 'sending', 'loadingSession', 'switchingEngine', 'editingMessage', 'conversationActivity', 'running']) {
    state[lock] = true;
    assert.equal(state.canSteerQueuedMessage(), false, lock);
    state[lock] = false;
  }
  state.pendingConversationSends.set(state.context.sessionId, {});
  assert.equal(state.canSteerQueuedMessage(), false);
  state.pendingConversationSends.clear();
  state.goalUI.waitingId = () => null;
  assert.equal(state.canSteerQueuedMessage(), false);
  state.running = true; state.currentRunId = 2;
  assert.equal(state.canSteerQueuedMessage(), true);
});

test('a waiting Goal sends the selected queued instruction once and preserves the remaining queue and draft', async () => {
  const harness = fixture(), { state } = harness;
  state.goalUI = { isActive: () => true, isDraft: () => false, waitingId: () => 'goal-waiting' };
  const first = { text: 'Keep waiting', attachments: [] };
  const selected = { text: 'Inspect this output now', attachments: [{ path: 'D:/output.csv' }] };
  state.messageQueue.push(first, selected);
  state.input.value = 'Unsent draft';
  state.attachments = [{ path: 'D:/draft.csv' }];
  state.buildPrompt = (text, attachments) => text + '\n' + attachments.map(file => file.path).join('\n');
  harness.settings.resolve({});
  const pending = state.steerQueuedMessage(selected);
  await state.steerQueuedMessage(selected);
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].goalId, 'goal-waiting');
  assert.equal(harness.requests[0].displayText, selected.text);
  assert.equal(harness.requests[0].prompt, 'Inspect this output now\nD:/output.csv');
  assert.equal(harness.requests[0].attachments[0].path, 'D:/output.csv');
  harness.replies[0].resolve({ ok: true, sessionId: 'conversation-a', runId: 2, userSeq: 3 });
  await pending;
  assert.deepEqual(state.messageQueue, [first]);
  assert.equal(harness.drafts.get('queue:conversation-a').length, 1);
  assert.equal(state.input.value, 'Unsent draft');
  assert.equal(state.attachments[0].path, 'D:/draft.csv');
  assert.equal(state.drainingQueue, false);
});

test('a rejected waiting Goal instruction retains its queue entry and attachments', async () => {
  const harness = fixture(), { state } = harness;
  state.goalUI = { isActive: () => true, isDraft: () => false, waitingId: () => 'goal-waiting' };
  const selected = { text: 'Inspect the output now', attachments: [{ path: 'D:/output.csv' }] };
  state.messageQueue.push(selected);
  harness.settings.resolve({});
  const pending = state.steerQueuedMessage(selected);
  await flush();
  assert.equal(harness.requests.length, 1);
  harness.replies[0].resolve({ ok: false, error: 'The goal changed before sending' });
  await pending;
  assert.deepEqual(state.messageQueue, [selected]);
  assert.equal(state.messageQueuePaused, true);
  assert.equal(state.input.value, 'Continue');
  assert.equal(state.drainingQueue, false);
});

for (const accepted of [true, false]) test(`a waiting Goal queue handoff stays scoped across navigation (accepted=${accepted})`, async () => {
  const harness = fixture(), { state } = harness;
  state.goalUI = { isActive: () => true, isDraft: () => false, waitingId: () => 'goal-waiting' };
  const selected = { text: 'Instruction for A', attachments: [] };
  state.messageQueue.push(selected);
  state.saveMessageQueue();
  harness.settings.resolve({});
  const pending = state.steerQueuedMessage(selected);
  await flush();
  assert.equal(harness.requests.length, 1);
  harness.navigate('conversation-b');
  state.drainingQueue = false;
  state.restoreMessageQueue();
  const other = { text: 'Queued for B', attachments: [] };
  state.messageQueue.push(other);
  state.input.value = 'Draft for B';
  state.saveMessageQueue();
  harness.replies[0].resolve({ ok: accepted, error: 'Instruction rejected', sessionId: 'conversation-a', runId: 2 });
  await pending;
  assert.equal(state.messageQueue.length, 1);
  assert.equal(state.messageQueue[0], other);
  assert.equal(state.input.value, 'Draft for B');
  assert.equal(harness.drafts.get('queue:conversation-a').length, accepted ? 0 : 1);
  assert.equal(state.drainingQueue, false);
});

test('an idle conversation sends its queued message with the current harness', async () => {
  const harness = fixture(), { state } = harness;
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

test('a failed harness reopen retains the queued message and composer draft', async () => {
  const harness = fixture(), { state } = harness;
  state.loadedEngine = 'claude';
  state.openHistorySession = async id => { assert.equal(id, 'conversation-a'); state.setStatus('Harness unavailable'); return false; };
  const queued = { text: 'Queued for A', attachments: [{ path: 'D:/queued.csv' }] };
  state.messageQueue.push(queued);
  await state.send(queued);
  assert.equal(harness.requests.length, 0);
  assert.equal(state.messageQueue[0], queued);
  assert.equal(state.input.value, 'Continue');
  assert.equal(state.statusText, 'Harness unavailable');
});
