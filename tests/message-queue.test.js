'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.html'), 'utf8');

test('active conversations queue by default and retain an explicit queue shortcut', () => {
  assert.match(markup, /id="messageQueue"/);
  assert.match(source, /if \(active && !queuedMessage\) \{[\s\S]*?if \(input.value.trim\(\) \|\| attachments.length\) \{ queueComposerMessage\(\); return; \}/);
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
  assert.match(source, /queueComposerMessage\(\); return;[\s\S]*await chatApi\.cancel/);
  assert.match(source, /sendBtn\.classList\.toggle\('stop', active && !hasMessage\)/);
  assert.match(source, /sendBtn\.classList\.toggle\('queue', active && hasMessage\)/);
});

test('send button click does not pass the event as a queued message', () => {
  assert.doesNotMatch(source, /addEventListener\('click', send\)/);
  assert.match(source, /sendBtn\.addEventListener\('click', \(\) => void send\(\)\)/);
});

function queueHarness(send, overrides = {}) {
  const storage = new Map();
  const state = {
    messageQueue: [{ text: 'First', attachments: [{ name: 'data.csv', path: 'D:/data.csv' }] }, { text: 'Second', attachments: [] }],
    drainingQueue: false, running: false, sending: false, loadingSession: false,
    sessionOpenSeq: 1,
    conversationActivity: null, switchingEngine: false, editingMessage: null,
    sharedChat: true, context: { sessionId: 'session' }, conversationQueues: new Map(),
    pendingConversationSend: () => null, draftKey: () => state.context.sessionId,
    writeUi: (key, value) => storage.set(key, JSON.stringify(value)),
    readUi: key => JSON.parse(storage.get(key) || 'null'),
    goalUI: { isActive: () => false }, renderMessageQueue() {}, setStatus(text) { state.status = text; },
    send: message => send(state, message), ...overrides,
  };
  vm.createContext(state);
  vm.runInContext(source.slice(source.indexOf('  function saveMessageQueue('), source.indexOf("  window.addEventListener('beforeunload'")), state);
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
  assert.equal(state.readUi('queue:session')[0].text, 'Second');
  assert.equal(sent.length, 1);
  state.running = false;
  state.drainMessageQueue();
  assert.equal(sent[1].text, 'Second');
  accept(true);
  await flushQueue();
  assert.equal(state.messageQueue.length, 0);
  assert.equal(state.readUi('queue:session').length, 0);
});

test('active goal and other send guards retain queued messages', async () => {
  for (const overrides of [
    { goalUI: { isActive: () => true } }, { editingMessage: {} }, { switchingEngine: true },
    { running: true }, { sending: true }, { loadingSession: true }, { conversationActivity: 'running' },
    { pendingConversationSend: () => ({}) },
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

test('late queue acceptance or failure cannot alter another conversation queue', async () => {
  for (const outcome of [true, false, new Error('Late failure')]) {
    let resolveSend, rejectSend;
    const state = queueHarness(() => new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; }));
    state.drainMessageQueue();
    state.sessionOpenSeq++;
    const otherQueue = [{ text: 'Other conversation', attachments: [] }];
    state.messageQueue = otherQueue;
    state.drainingQueue = true;
    state.status = 'Other status';
    if (outcome instanceof Error) rejectSend(outcome);
    else resolveSend(outcome);
    await flushQueue();
    assert.equal(state.messageQueue, otherQueue);
    assert.equal(state.messageQueue.length, 1);
    assert.equal(state.drainingQueue, true);
    assert.equal(state.status, 'Other status');
  }
});

test('queue resumes when the turn finishes before the steering reply', async () => {
  for (const accepted of [true, false]) {
    let reply;
    const sent = [];
    const state = queueHarness(async (ui, message) => {
      sent.push(message.text); ui.running = true; return true;
    }, {
      running: true, input: { value: 'Correction' }, attachments: [], sharedChat: true,
      pendingConversationSend: () => null,
      goalUI: { isActive: () => false, isDraft: () => false },
      context: { sessionId: 'session' }, currentRunId: 1, sessionOpenSeq: 1,
      updateSendEnabled() {}, renderAttachments() {}, autoResize() {}, saveDraft() {},
      buildPrompt: text => text,
      chatApi: { steer: () => new Promise(resolve => { reply = resolve; }) },
    });
    vm.runInContext(source.slice(source.indexOf('  async function steerQueuedMessage('), source.indexOf('  async function send(')), state);
    const pending = state.steerQueuedMessage(state.messageQueue[1]);
    assert.equal(state.sending, true);
    state.running = false;
    state.currentRunId = null;
    state.drainMessageQueue();
    assert.equal(sent.length, 0);
    reply({ ok: accepted, error: 'Turn finished' });
    await pending;
    await flushQueue();
    assert.deepEqual(sent, ['First']);
    assert.equal(state.messageQueue.length, accepted ? 0 : 1);
    assert.equal(state.input.value, 'Correction');
  }
});

function steeringHarness() {
  const requests = [];
  let reply;
  const state = queueHarness(async () => false, {
    sharedChat: true, running: true, currentRunId: 7,
    context: { sessionId: 'original' }, pendingConversationSend: () => null,
    goalUI: { isActive: () => false, isDraft: () => false },
    input: { value: 'Unsent composer draft' }, attachments: [{ path: 'D:/draft.txt' }],
    updateSendEnabled() {}, buildPrompt: (text, attachments) => text + ':' + attachments.map(item => item.path).join(','),
    chatApi: { steer(payload) { requests.push(payload); return new Promise((resolve, reject) => { reply = { resolve, reject }; }); } },
  });
  vm.runInContext(source.slice(source.indexOf('  async function steerQueuedMessage('), source.indexOf('  async function send(')), state);
  return { state, requests, resolve: value => reply.resolve(value), reject: error => reply.reject(error) };
}

test('immediate instruction selects one queued message and prevents concurrent duplicates', async () => {
  const harness = steeringHarness(), { state, requests } = harness;
  const selected = state.messageQueue[1];
  selected.attachments = [{ path: 'D:/selected.png', isImage: true }];
  const pending = state.steerQueuedMessage(selected);
  await state.steerQueuedMessage(selected);
  await state.steerQueuedMessage(state.messageQueue[0]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].displayText, 'Second');
  assert.equal(requests[0].prompt, 'Second:D:/selected.png');
  assert.equal(requests[0].attachments[0].isImage, true);
  assert.equal(requests[0].runId, 7);
  assert.equal(state.messageQueue.length, 2);
  harness.resolve({ ok: true });
  await pending;
  assert.deepEqual(state.messageQueue.map(message => message.text), ['First']);
  assert.equal(state.input.value, 'Unsent composer draft');
  assert.equal(state.attachments[0].path, 'D:/draft.txt');
  assert.equal(state.sending, false);
});

test('rejected and failed immediate instructions retain queued text and attachments', async () => {
  for (const failure of [{ ok: false, error: 'Unsupported' }, new Error('Disconnected')]) {
    const harness = steeringHarness(), { state } = harness;
    const selected = state.messageQueue[0];
    const pending = state.steerQueuedMessage(selected);
    if (failure instanceof Error) harness.reject(failure);
    else harness.resolve(failure);
    await pending;
    assert.equal(state.messageQueue.length, 2);
    assert.equal(state.messageQueue[0], selected);
    assert.equal(selected.attachments[0].path, 'D:/data.csv');
    assert.equal(state.input.value, 'Unsent composer draft');
    assert.equal(state.status, failure.error || failure.message);
    assert.equal(state.sending, false);
  }
});

test('late immediate instruction replies cannot mutate another conversation', async () => {
  for (const accepted of [true, false]) {
    const harness = steeringHarness(), { state } = harness;
    const pending = state.steerQueuedMessage(state.messageQueue[0]);
    state.sessionOpenSeq++;
    state.context.sessionId = 'other';
    state.messageQueue = [{ text: 'Other queued message', attachments: [] }];
    state.sending = true;
    state.status = 'Other status';
    harness.resolve({ ok: accepted, error: 'Late rejection' });
    await pending;
    assert.equal(state.messageQueue[0].text, 'Other queued message');
    assert.equal(state.messageQueue.length, 1);
    assert.equal(state.sending, true);
    assert.equal(state.status, 'Other status');
  }
});

test('unavailable turns and busy states cannot dispatch immediate instructions', async () => {
  for (const overrides of [
    { running: false }, { currentRunId: null }, { loadingSession: true }, { switchingEngine: true },
    { editingMessage: {} }, { drainingQueue: true }, { pendingConversationSend: () => ({}) }, { sharedChat: false },
  ]) {
    const { state, requests } = steeringHarness();
    Object.assign(state, overrides);
    await state.steerQueuedMessage(state.messageQueue[0]);
    assert.equal(requests.length, 0);
    assert.equal(state.messageQueue.length, 2);
  }
});
