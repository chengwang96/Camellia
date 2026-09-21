'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8').replace(/\r\n/g, '\n');
const sendSource = source.slice(source.indexOf('  async function send('), source.indexOf('    if (editingMessage || !canChangeContext()')) + '\n  }';
const activitySource = source.slice(source.indexOf('  function handleEvent(ev)'), source.indexOf('    if (restoringRun) { eventsDuringRestore.push(ev); return; }\n    if (sharedChat')) + '\n  }';

function harness(cancel, overrides = {}) {
  const state = {
    running: true, sending: false, loadingSession: false, input: { value: '' }, attachments: [], conversationActivity: 'running', currentRunId: 12, sessionOpenSeq: 1,
    context: { sessionId: 'conversation-a' }, sharedChat: true, restoringRun: false,
    statusText: 'Running…', statusLine: { textContent: 'Running…' }, queueComposerMessage: () => false,
    chatApi: { cancel: payload => cancel(state, payload) },
    sidebar: { load() {} }, updateConversationControls() {}, drainMessageQueue() {},
    ...overrides,
  };
  state.setStatus = text => { state.statusText = text; state.statusLine.textContent = text; };
  vm.createContext(state);
  vm.runInContext(sendSource + '\n' + activitySource, state);
  return state;
}

test('stop completion before the IPC reply is not overwritten with Stopping', async () => {
  const state = harness((ui, payload) => {
    assert.equal(ui.statusLine.textContent, 'Stopping…');
    assert.equal(payload.sessionId, 'conversation-a');
    assert.equal(payload.runId, 12);
    ui.running = false;
    ui.currentRunId = null;
    ui.setStatus('Stopped · Elapsed 1s');
    return { ok: true };
  });
  await state.send();
  assert.equal(state.statusLine.textContent, 'Stopped · Elapsed 1s');
});

test('pending stop remains visible until completion arrives', async () => {
  const state = harness(() => ({ ok: true }));
  await state.send();
  assert.equal(state.statusLine.textContent, 'Stopping…');
  state.setStatus('Stopped · Elapsed 2s');
  assert.equal(state.statusLine.textContent, 'Stopped · Elapsed 2s');
});

test('stop failure and rejected IPC display the error', async () => {
  for (const cancel of [
    () => ({ ok: false, error: 'This response has already finished' }),
    () => Promise.reject(new Error('IPC unavailable')),
  ]) {
    const state = harness(cancel);
    await state.send();
    assert.match(state.statusLine.textContent, /already finished|IPC unavailable/);
  }
});

test('late stop errors do not overwrite another conversation or run', async () => {
  for (const change of [
    ui => { ui.context.sessionId = 'conversation-b'; },
    ui => { ui.currentRunId = 13; },
    ui => { ui.sessionOpenSeq++; },
    ui => { ui.setStatus('Stopped · Elapsed 1s'); },
  ]) {
    const state = harness(ui => {
      change(ui);
      return { ok: false, error: 'Late failure' };
    });
    await state.send();
    assert.notEqual(state.statusLine.textContent, 'Late failure');
  }
});

test('activity-only stop clears Stopping without requiring a turn result', async () => {
  const state = harness(ui => {
    ui.handleEvent({ type: 'conversation:activity', session_id: 'conversation-a', activity: null });
    return { ok: true };
  }, { running: false, currentRunId: null });
  await state.send();
  assert.equal(state.statusLine.textContent, 'Stopped');
});

test('translated status text does not prevent activity-only stop cleanup', async () => {
  const state = harness(() => ({ ok: true }), { running: false, currentRunId: null });
  await state.send();
  state.statusLine.textContent = '正在停止…';
  state.handleEvent({ type: 'conversation:activity', session_id: 'conversation-a', activity: null });
  assert.equal(state.statusLine.textContent, 'Stopped');
});

test('unrelated activity does not clear the current stop status', async () => {
  const state = harness(() => ({ ok: true }));
  await state.send();
  state.handleEvent({ type: 'conversation:activity', session_id: 'conversation-b', activity: null });
  assert.equal(state.statusLine.textContent, 'Stopping…');
  state.handleEvent({ type: 'conversation:activity', session_id: 'conversation-a', activity: null });
  assert.equal(state.statusLine.textContent, 'Stopping…');
});

test('legacy stop still uses the run ID and accepts an empty IPC reply', async () => {
  const state = harness((_ui, payload) => { assert.equal(payload, 12); }, { sharedChat: false });
  await state.send();
  assert.equal(state.statusLine.textContent, 'Stopping…');
});
