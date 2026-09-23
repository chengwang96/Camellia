'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const setRunningSource = source.slice(source.indexOf('  function setRunning(v) {'), source.indexOf('  // ---------- event handling ----------'));

// Only the in-turn run-status row proves an agent reply is on its way; the
// status line under the composer is easy to miss and is not part of a turn.
function fixture() {
  const state = {
    running: false, startTicker: 0, stopTicker: 0, controls: 0, labels: 0, sendEnabled: 0,
    lastCallUsage: { input_tokens: 9 }, runStatus: [], statusRow: null, turnEl: null,
    updateConversationControls() { state.controls++; },
    sidebar: { updateLabel() { state.labels++; } },
    startRunTicker() { state.startTicker++; },
    stopRunTicker() { state.stopTicker++; },
    updateSendEnabled() { state.sendEnabled++; },
    setRunStatus(text) { state.runStatus.push(text); state.statusRow = { text: text || 'Working…' }; },
  };
  vm.createContext(state);
  vm.runInContext(setRunningSource, state);
  return state;
}

test('starting a run renders the animated placeholder without an explicit status', () => {
  const state = fixture();
  state.setRunning(true);
  assert.equal(state.running, true);
  assert.equal(state.runStatus.length, 1);
  assert.equal(state.runStatus[0], 'Working…');
  assert.equal(state.lastCallUsage, null);
  assert.equal(state.startTicker, 1);
});

test('an existing status row is reused so the elapsed clock survives', () => {
  const state = fixture();
  state.setRunning(true);
  const row = state.statusRow;
  state.turnEl = { querySelector: selector => (selector === '.run-status' ? row : null) };
  state.setRunStatus('Running a tool…');
  state.setRunning(true);
  assert.deepEqual(state.runStatus, ['Working…', 'Running a tool…']);
});

test('every restart path that clears the turn gets a fresh placeholder', () => {
  for (const clearTurn of [true, false]) {
    const state = fixture();
    state.setRunning(true);
    if (clearTurn) state.turnEl = null;
    state.setRunStatus('Waiting for the engine to respond…');
    state.setRunning(true);
    assert.match(state.runStatus.at(-1), /Working…|Waiting for the engine/);
  }
});

test('stopping the run removes no placeholder and keeps the ticker stopped', () => {
  const state = fixture();
  state.setRunning(true);
  state.setRunning(false);
  assert.equal(state.running, false);
  assert.equal(state.stopTicker, 1);
  assert.equal(state.runStatus.length, 1);
});
