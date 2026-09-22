'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const statusSource = source.slice(source.indexOf("  let statusText = '';"), source.indexOf('  // ---------- context usage ring'));

function harness() {
  const stopButton = { hidden: true };
  const state = {
    context: { sessionId: 'conversation-a' }, running: true, runStartedAt: 0, runTimer: null,
    pendingConversationSends: new Map(),
    statusLine: { textContent: '' }, rows: [],
    $: () => stopButton,
    setRunStatus: text => state.rows.push(text),
    renderCompactionStatus() {},
    setInterval: callback => { state.tick = callback; return 1; },
    clearInterval() {}, fmtDuration: () => '5m',
  };
  vm.createContext(state);
  vm.runInContext(statusSource, state);
  return { state, stopButton };
}

test('internal compaction remains visible while send is pending and the timer ticks', () => {
  const { state, stopButton } = harness();
  state.startRunTicker();
  state.handleConversationStatus({ sessionId: 'conversation-a', text: 'Asking the engine to summarize the conversation…' });
  for (let count = 0; count < 300; count++) state.tick();
  assert.equal(state.statusLine.textContent, 'Asking the engine to summarize the conversation… · Elapsed 5m');
  assert.equal(state.rows.at(-1), 'Asking the engine to summarize the conversation…');
  assert.equal(stopButton.hidden, false);
  state.handleConversationStatus({ sessionId: 'conversation-a', text: '' });
  state.tick();
  assert.equal(state.statusLine.textContent, 'Running… · Elapsed 5m');
  assert.equal(state.rows.at(-1), 'Waiting for the engine to respond…');
  assert.equal(stopButton.hidden, true);
});

test('other conversations cannot replace or clear the visible phase', () => {
  const { state, stopButton } = harness();
  state.startRunTicker();
  state.handleConversationStatus({ sessionId: 'conversation-a', text: 'Compacting context before continuing the task…' });
  state.handleConversationStatus({ sessionId: 'conversation-b', text: '' });
  state.tick();
  assert.match(state.statusLine.textContent, /^Compacting context/);
  assert.equal(stopButton.hidden, false);
});

test('background pending compaction retains its phase for reentry without changing the current view', () => {
  const { state, stopButton } = harness();
  state.pendingConversationSends.set('conversation-a', {});
  state.context.sessionId = 'conversation-b';
  state.handleConversationStatus({ sessionId: 'conversation-a', text: 'Asking the engine to summarize the conversation…' });
  assert.equal(state.statusLine.textContent, '');
  assert.equal(stopButton.hidden, true);
  state.context.sessionId = 'conversation-a';
  state.running = false;
  state.handleConversationStatus({ sessionId: 'conversation-a', text: state.pendingConversationSends.get('conversation-a').phase });
  assert.match(state.statusLine.textContent, /^Asking the engine/);
  assert.match(state.rows.at(-1), /^Asking the engine/);
  assert.equal(stopButton.hidden, false);
});

test('stopping survives timer ticks and the next run starts without a stale phase', () => {
  const { state } = harness();
  state.startRunTicker();
  state.handleConversationStatus({ sessionId: 'conversation-a', text: 'Compacting context before continuing the task…' });
  state.setStatus('Stopping…');
  state.handleConversationStatus({ sessionId: 'conversation-a', text: '' });
  state.tick();
  assert.equal(state.statusLine.textContent, 'Stopping…');
  state.stopRunTicker();
  state.startRunTicker();
  state.tick();
  assert.equal(state.statusLine.textContent, 'Running… · Elapsed 5m');
});
