'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

function fixture(storage = new Map()) {
  const state = {
    sharedChat: true, context: { sessionId: 'first' }, messageQueue: [], conversationQueues: new Map(),
    sessionOpenSeq: 1, drainingQueue: false, running: false, sending: false, loadingSession: false,
    conversationActivity: null, switchingEngine: false, editingMessage: null,
    goalUI: { isActive: () => false }, pendingConversationSend: () => null,
    draftKey: () => state.context.sessionId,
    writeUi: (key, value) => storage.set(key, JSON.stringify(value)),
    readUi: key => JSON.parse(storage.get(key) || 'null'),
    renderMessageQueue() {}, setStatus() {},
  };
  vm.createContext(state);
  vm.runInContext([
    extract('  function saveMessageQueue(', "  window.addEventListener('beforeunload'"),
    extract('  function drainMessageQueue()', "  $('attachBtn').addEventListener"),
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
