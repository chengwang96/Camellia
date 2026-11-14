'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/chat.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

function fixture(storage = new Map()) {
  const state = {
    sharedChat: true, context: { sessionId: 'first' }, messageQueue: [], messageQueuePaused: false, conversationQueues: new Map(),
    sessionOpenSeq: 1, drainingQueue: false, running: false, sending: false, loadingSession: false,
    conversationActivity: null, switchingEngine: false, handoffSessions: new Map(), editingMessage: null,
    goalUI: { isActive: () => false }, pendingConversationSend: () => null,
    draftKey: () => state.context.sessionId,
    writeUi: (key, value) => storage.set(key, JSON.stringify(value)),
    readUi: key => JSON.parse(storage.get(key) || 'null'),
    renderMessageQueue() {}, setStatus() {},
  };
  vm.createContext(state);
  vm.runInContext([
    extract('  function saveMessageQueue(', "  window.addEventListener('beforeunload'"),
    extract('  function drainMessageQueue()', "  const attachBtn = $('attachBtn');"),
  ].join('\n'), state);
  state.navigate = id => {
    state.context.sessionId = id;
    state.sessionOpenSeq++;
    state.drainingQueue = false;
    state.restoreMessageQueue();
  };
  return state;
}

test('queues retain order and attachments across navigation and renderer recreation', () => {
  const storage = new Map(), state = fixture(storage);
  state.messageQueue.push({ text: 'First', attachments: [{ path: 'D:/data.csv', name: 'data.csv' }] }, { text: 'Second', attachments: [] });
  state.saveMessageQueue();
  state.navigate('other');
  assert.equal(state.messageQueue.length, 0);
  state.messageQueue.push({ text: 'Other', attachments: [] });
  state.saveMessageQueue();
  state.navigate('first');
  assert.deepEqual(state.messageQueue.map(message => message.text), ['First', 'Second']);
  const restored = fixture(storage);
  restored.restoreMessageQueue();
  assert.equal(restored.messageQueue[0].attachments[0].path, 'D:/data.csv');
  assert.deepEqual(restored.messageQueue.map(message => message.text), ['First', 'Second']);
  restored.messageQueue.splice(0, 1);
  restored.saveMessageQueue();
  const afterRemoval = fixture(storage);
  afterRemoval.restoreMessageQueue();
  assert.deepEqual(afterRemoval.messageQueue.map(message => message.text), ['Second']);
});

for (const accepted of [true, false]) {
  for (const returnBeforeCompletion of [true, false]) {
    test(`pending queue send remains scoped to its conversation (accepted=${accepted}, returned=${returnBeforeCompletion})`, async () => {
      const state = fixture();
      state.messageQueue.push({ text: 'Waiting', attachments: [] });
      state.saveMessageQueue();
      let finish;
      state.send = () => new Promise(resolve => { finish = resolve; });
      state.drainMessageQueue();
      state.navigate('other');
      state.messageQueue.push({ text: 'Other', attachments: [] });
      state.saveMessageQueue();
      if (returnBeforeCompletion) state.navigate('first');
      finish(accepted);
      await new Promise(resolve => setImmediate(resolve));
      if (!returnBeforeCompletion) assert.equal(state.messageQueue[0].text, 'Other');
      state.navigate('first');
      assert.equal(state.messageQueue.length, accepted ? 0 : 1);
      assert.equal(state.readUi('queue:first').length, accepted ? 0 : 1);
      assert.equal(state.drainingQueue, false);
      state.navigate('other');
      assert.equal(state.messageQueue[0].text, 'Other');
    });
  }
}

test('returning during a pending send does not dispatch the queue twice', () => {
  const state = fixture();
  state.messageQueue.push({ text: 'Waiting', attachments: [] });
  state.pendingConversationSend = () => ({});
  state.send = () => { assert.fail('duplicate dispatch'); };
  state.drainMessageQueue();
  assert.equal(state.messageQueue.length, 1);
  assert.equal(state.drainingQueue, false);
});

for (const returnBeforeCompletion of [true, false]) {
  test(`accepted unified queue migrations remove the original local entry across navigation (returned=${returnBeforeCompletion})`, async () => {
    const state = fixture();
    Object.assign(state, {
      unifiedQueueAvailable: true, migratingQueue: false, pendingForkId: null,
      loadedEngine: 'codex', harnessId: 'codex', queueMicrotask,
      buildPrompt: text => text, applyRemoteQueue() {},
    });
    vm.runInContext(extract('  function canUseUnifiedQueue()', '  async function queueComposerMessage()'), state);
    state.messageQueue.push({ text: 'Migrate once', attachments: [] });
    state.saveMessageQueue();
    let finish;
    state.chatApi = { messageQueueAdd: () => new Promise(resolve => { finish = resolve; }) };
    const migration = state.migrateLocalQueueToUnified();
    state.navigate('other');
    if (returnBeforeCompletion) state.navigate('first');
    finish({ ok: true, queue: [] });
    await migration;
    assert.equal(state.readUi('queue:first').length, 0);
    if (!returnBeforeCompletion) assert.equal(state.context.sessionId, 'other');
    state.navigate('first');
    assert.equal(state.messageQueue.length, 0);
  });
}

for (const outcome of ['unsupported', 'rejected']) {
  for (const returnBeforeCompletion of [true, false]) {
    test(`unfinished unified queue additions retain their message across navigation (${outcome}, returned=${returnBeforeCompletion})`, async () => {
      const state = fixture();
      Object.assign(state, {
        input: { value: 'Keep this message' }, attachments: [{ path: 'D:/report.pdf', name: 'report.pdf' }],
        canQueueComposerMessage: () => true, canUseUnifiedQueue: () => true,
        buildPrompt: text => text, renderAttachments() {}, autoResize() {}, saveDraft() {},
        maybeScroll() {}, applyRemoteQueue() {},
      });
      state.goalUI.isDraft = () => false;
      vm.runInContext(extract('  async function queueComposerMessage()', '  function drainMessageQueue()'), state);
      state.saveMessageQueue();
      let finish;
      state.chatApi = { messageQueueAdd: () => new Promise(resolve => { finish = resolve; }) };
      const pending = state.queueComposerMessage();
      state.navigate('other');
      if (returnBeforeCompletion) state.navigate('first');
      state.input.value = 'New draft';
      finish(outcome === 'unsupported' ? undefined : { ok: false, error: 'Queue unavailable' });
      await pending;
      assert.equal(state.input.value, 'New draft');
      const queue = state.readUi('queue:first');
      assert.equal(queue?.length, 1);
      assert.equal(queue[0].text, 'Keep this message');
      assert.equal(queue[0].attachments[0].path, 'D:/report.pdf');
      assert.equal(state.readUi('queue-paused:first') === true, outcome === 'rejected');
      state.navigate('first');
      assert.equal(state.messageQueue.length, 1);
      assert.equal(state.messageQueuePaused, outcome === 'rejected');
    });
  }
}

test('a new conversation does not inherit the previous conversation queue', () => {
  const state = fixture();
  state.context.sessionId = null;
  state.restoreMessageQueue();
  state.context.sessionId = 'created';
  state.messageQueue.push({ text: 'Only for created', attachments: [] });
  state.saveMessageQueue();
  state.navigate(null);
  assert.equal(state.messageQueue.length, 0);
  state.navigate('created');
  assert.equal(state.messageQueue[0].text, 'Only for created');
});

test('queue pause survives navigation and renderer recreation until explicitly resumed', async () => {
  const storage = new Map(), state = fixture(storage);
  state.messageQueue.push({ text: 'Paused message', attachments: [] });
  state.saveMessageQueue();
  state.setMessageQueuePaused(true);
  state.send = async () => { assert.fail('Paused queues must not dispatch'); };
  state.drainMessageQueue();
  state.navigate('other');
  assert.equal(state.messageQueuePaused, false);
  state.navigate('first');
  assert.equal(state.messageQueuePaused, true);
  state.drainMessageQueue();
  const restored = fixture(storage);
  restored.restoreMessageQueue();
  assert.equal(restored.messageQueuePaused, true);
  const sent = [];
  restored.send = async message => { sent.push(message.text); return true; };
  restored.drainMessageQueue();
  assert.deepEqual(sent, []);
  restored.setMessageQueuePaused(false);
  restored.drainMessageQueue();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['Paused message']);
  assert.equal(restored.messageQueue.length, 0);
  assert.equal(restored.readUi('queue-paused:first'), false);
});
