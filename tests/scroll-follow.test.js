'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');

test('stream following survives consecutive programmatic scroll events', () => {
  assert.doesNotMatch(source, /programmaticScroll/);
  assert.match(source, /if \(running && \(userScrollActive \|\| performance\.now\(\) < userScrollIntentUntil\)\) followRunOutput = nearBottom\(\)/);
  assert.match(source, /new ResizeObserver\(\(\) => \{\s*if \(running && followRunOutput\) scrollToLatest\(\);/);
});

test('explicitly submitted messages scroll again after the next layout', () => {
  assert.match(source, /function scrollToLatest\(\) \{[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?chatScroll\.scrollTop = chatScroll\.scrollHeight;/);
  assert.match(source, /if \(meta\.scrollToBottom\) scrollToLatest\(\);/);
});

function scrollFixture() {
  const frames = new Map();
  let frameId = 0;
  let scrollTop = 0;
  const state = {
    chatScroll: {
      scrollHeight: 2000, clientHeight: 600,
      get scrollTop() { return scrollTop; },
      set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    },
    sessionOpenSeq: 1, userScrollIntentUntil: 0, userScrollActive: false,
    followScrollFrame: null, running: false, followRunOutput: false,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  vm.createContext(state);
  vm.runInContext(source.slice(source.indexOf('  function nearBottom()'), source.indexOf('  new ResizeObserver(')), state);
  return {
    state,
    layout() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test('opening idle history reaches the bottom again after layout grows', () => {
  const { state, layout } = scrollFixture();
  state.scrollToLatest();
  assert.equal(state.chatScroll.scrollTop, 1400);
  state.chatScroll.scrollHeight = 3000;
  layout();
  assert.equal(state.chatScroll.scrollTop, 2400);
});

test('a pending bottom scroll does not affect a different session', () => {
  const { state, layout } = scrollFixture();
  state.scrollToLatest();
  state.sessionOpenSeq++;
  state.chatScroll.scrollTop = 0;
  layout();
  assert.equal(state.chatScroll.scrollTop, 0);
});

test('user scrolling cancels the deferred bottom scroll', () => {
  for (const gesture of ['wheel', 'drag']) {
    const { state, layout } = scrollFixture();
    state.scrollToLatest();
    if (gesture === 'wheel') state.userScrollIntentUntil = 250;
    else state.userScrollActive = true;
    state.chatScroll.scrollTop = 100;
    layout();
    assert.equal(state.chatScroll.scrollTop, 100);
  }
});

test('restoring a draft ignores legacy scroll positions without losing composer data', () => {
  for (const saved of [null, { text: 'draft', attachments: [{ path: 'image.png' }], pendingForkId: 'fork', scrollTop: 0, bottom: false }]) {
    const { state, layout } = scrollFixture();
    Object.assign(state, {
      sharedChat: true, readUi: () => saved, draftKey: () => 'session', input: {},
      attachments: [], pendingForkId: null, renderAttachments() {}, autoResize() {}, updateSendEnabled() {},
    });
    vm.runInContext(source.slice(source.indexOf('  function restoreDraft()'), source.indexOf("  window.addEventListener('beforeunload'")), state);
    state.restoreDraft();
    state.scrollToLatest();
    layout();
    state.restoreDraft();
    assert.equal(state.chatScroll.scrollTop, 1400);
    assert.equal(state.input.value, saved?.text || '');
    assert.equal(state.pendingForkId, saved?.pendingForkId || null);
    assert.equal(state.attachments.length, saved?.attachments.length || 0);
  }
});

test('history scrolls after draft and live state restoration', () => {
  const history = source.slice(source.indexOf('  async function openHistorySession(id)'), source.indexOf('  async function renderHistoryMessages(messages)'));
  assert.match(history, /restoreDraft\(\);[\s\S]*await applyLiveRun\(res.live\)[\s\S]*void goalUI.refresh\(\);[\s\S]*scrollToLatest\(\);\s*return true;/);
});
