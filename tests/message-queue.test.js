'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.html'), 'utf8');

test('active conversations steer by default and retain an explicit queue shortcut', () => {
  assert.match(markup, /id="messageQueue"/);
  assert.match(source, /if \(active && !queuedMessage\) \{\s*if \(input.value.trim\(\) \|\| attachments.length\) \{ await steerComposerMessage\(\); return; \}/);
  assert.match(source, /e.key === 'Enter' && e.altKey[\s\S]*queueComposerMessage\(\)/);
  assert.match(source, /messageQueue\.push\(\{ text, attachments: queuedAttachments \}\)/);
  assert.match(source, /function queueComposerMessage\(\) \{[\s\S]*?followRunOutput = true;\s*maybeScroll\(true\);/);
});

test('queued messages drain after result and shared activity completion', () => {
  assert.match(source, /setRunning\(false\);[\s\S]*currentRunId = null;[\s\S]*drainMessageQueue\(\)/);
  assert.match(source, /if \(!conversationActivity\) drainMessageQueue\(\)/);
  assert.match(source, /const next = messageQueue\[0\];[\s\S]*send\(next\)/);
});

test('an empty composer preserves the active stop action', () => {
  assert.match(source, /await steerComposerMessage\(\); return;[\s\S]*await chatApi\.cancel/);
  assert.match(source, /sendBtn\.classList\.toggle\('stop', active && !hasMessage\)/);
  assert.match(source, /sendBtn\.classList\.toggle\('queue', active && hasMessage\)/);
});

test('send button click does not pass the event as a queued message', () => {
  assert.doesNotMatch(source, /addEventListener\('click', send\)/);
  assert.match(source, /sendBtn\.addEventListener\('click', \(\) => void send\(\)\)/);
});

function queueHarness(send, overrides = {}) {
  const state = {
    messageQueue: [{ text: 'First', attachments: [{ name: 'data.csv', path: 'D:/data.csv' }] }, { text: 'Second', attachments: [] }],
    drainingQueue: false, running: false, sending: false, loadingSession: false,
    conversationActivity: null, switchingEngine: false, editingMessage: null,
    goalUI: { isActive: () => false }, renderMessageQueue() {}, setStatus(text) { state.status = text; },
    send: message => send(state, message), ...overrides,
  };
  vm.createContext(state);
  vm.runInContext(source.slice(source.indexOf('  function drainMessageQueue()'), source.indexOf("  $('attachBtn')")), state);
  return state;
}

const flushQueue = () => new Promise(resolve => setImmediate(resolve));

test('queue remains intact until a send is accepted, and drains in order once', async () => {
  const sent = [];
  let accept;
  const state = queueHarness((_ui, message) => {
    sent.push(message);
    return new Promise(resolve => { accept = resolve; });
  });
  const first = state.messageQueue[0];
  state.drainMessageQueue();
  state.drainMessageQueue();
  assert.equal(sent.length, 1);
  assert.equal(state.messageQueue[0], first);
  assert.equal(sent[0].attachments[0].path, 'D:/data.csv');
  state.running = true;
  accept(true);
  await flushQueue();
  assert.equal(state.messageQueue.length, 1);
  assert.equal(sent.length, 1);
  state.running = false;
  state.drainMessageQueue();
  assert.equal(sent[1].text, 'Second');
  accept(true);
  await flushQueue();
  assert.equal(state.messageQueue.length, 0);
});

test('active goal and other send guards retain queued messages', async () => {
  for (const overrides of [
    { goalUI: { isActive: () => true } }, { editingMessage: {} }, { switchingEngine: true },
    { running: true }, { sending: true }, { loadingSession: true }, { conversationActivity: 'running' },
  ]) {
    let calls = 0;
    const state = queueHarness(async () => { calls++; return true; }, overrides);
    state.drainMessageQueue();
    await flushQueue();
    assert.equal(calls, 0);
    assert.equal(state.messageQueue.length, 2);
  }
});

test('early return, rejected send and IPC error preserve the entire queue without retry loops', async () => {
  for (const result of [undefined, false, new Error('IPC unavailable')]) {
    let calls = 0;
    const state = queueHarness(async () => {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    });
    state.drainMessageQueue();
    await flushQueue();
    assert.equal(calls, 1);
    assert.equal(state.messageQueue.length, 2);
    assert.equal(state.drainingQueue, false);
    if (result instanceof Error) assert.equal(state.status, 'IPC unavailable');
  }
});

test('goal completion schedules another queue drain', async () => {
  let active = true;
  const sent = [];
  const state = queueHarness(async (ui, message) => { sent.push(message.text); ui.running = true; return true; }, {
    goalUI: { isActive: () => active }, sidebar: { updateLabel() {} }, updateConversationControls() {}, queueMicrotask,
  });
  state.drainMessageQueue();
  assert.equal(sent.length, 0);
  active = false;
  const onChange = source.match(/onChange: \(\) => \{ (sidebar\.updateLabel\(\); updateConversationControls\(\);.*?) \}, openActionMenu/)[1];
  vm.runInContext(onChange, state);
  await flushQueue();
  assert.deepEqual(sent, ['First']);
  assert.equal(state.messageQueue.length, 1);
});

test('queue resumes when the turn finishes before the steering reply', async () => {
  for (const accepted of [true, false]) {
    let reply;
    const sent = [];
    const state = queueHarness(async (ui, message) => {
      sent.push(message.text); ui.running = true; return true;
    }, {
      running: true, input: { value: 'Correction' }, attachments: [], sharedChat: true,
      goalUI: { isActive: () => false, isDraft: () => false },
      context: { sessionId: 'session' }, currentRunId: 1, sessionOpenSeq: 1,
      updateSendEnabled() {}, renderAttachments() {}, autoResize() {}, saveDraft() {},
      buildPrompt: text => text,
      chatApi: { steer: () => new Promise(resolve => { reply = resolve; }) },
    });
    vm.runInContext(source.slice(source.indexOf('  async function steerComposerMessage()'), source.indexOf('  async function send(')), state);
    const pending = state.steerComposerMessage();
    assert.equal(state.sending, true);
    state.running = false;
    state.currentRunId = null;
    state.drainMessageQueue();
    assert.equal(sent.length, 0);
    reply({ ok: accepted, error: 'Turn finished' });
    await pending;
    await flushQueue();
    assert.deepEqual(sent, ['First']);
    assert.equal(state.messageQueue.length, 1);
    assert.equal(state.input.value, accepted ? '' : 'Correction');
  }
});
