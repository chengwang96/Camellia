'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/chat.js'), 'utf8');

test('stream following survives consecutive programmatic scroll events', () => {
  const { state, dispatch, layout } = scrollFixture();
  state.running = true;
  state.scrollToLatest();
  dispatch('scroll');
  state.chatScroll.scrollHeight = 3000;
  dispatch('scroll');
  assert.equal(state.followRunOutput, true);
  state.maybeScroll(false);
  layout();
  assert.equal(state.chatScroll.scrollTop, 2400);
});

test('explicitly submitted messages scroll again after the next layout', () => {
  assert.match(source, /function scrollToLatest\(\) \{[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?chatScroll\.scrollTop = chatScroll\.scrollHeight;/);
  assert.match(source, /if \(meta\.scrollToBottom\) scrollToLatest\(\);/);
});

function scrollFixture() {
  const frames = new Map();
  const listeners = { chat: new Map(), window: new Map() };
  let resize;
  let frameId = 0;
  let scrollTop = 0;
  const state = {
    chatScroll: {
      scrollHeight: 2000, clientHeight: 600,
      get scrollTop() { return scrollTop; },
      set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
      addEventListener(type, callback) { listeners.chat.set(type, callback); },
      contains(target) { return target === this; }, closest() { return null; },
    },
    chat: {}, document: { body: {} },
    window: { addEventListener(type, callback) { listeners.window.set(type, callback); } },
    performance: { now: () => 1000 }, setTimeout() {}, clearTimeout() {}, saveDraft() {},
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} },
    sessionOpenSeq: 1, userScrollIntentUntil: 0, userScrollActive: false,
    followScrollFrame: null, running: false, followRunOutput: false, replayingLiveSnapshot: false,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  vm.createContext(state);
  vm.runInContext(source.slice(source.indexOf('  function nearBottom()'), source.indexOf('  function clearEmpty()')), state);
  vm.runInContext(source.slice(source.indexOf('  let scrollSaveTimer;'), source.indexOf('  const SENT =')), state);
  return {
    state,
    dispatch(type, event = {}, target = 'chat') { listeners[target].get(type)?.({ target: state.chatScroll, ...event }); },
    resize() { resize(); },
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

test('upward wheel, keyboard, touch and scrollbar gestures pause following even near the bottom', () => {
  for (const gesture of ['wheel', 'keyboard', 'touch', 'pointer']) {
    const { state, dispatch, layout, resize } = scrollFixture();
    state.running = true;
    state.scrollToLatest();
    state.chatScroll.scrollTop = 1340;
    if (gesture === 'wheel') dispatch('wheel', { deltaY: -60 });
    if (gesture === 'keyboard') dispatch('keydown', { key: 'PageUp' }, 'window');
    if (gesture === 'touch') dispatch('touchstart');
    if (gesture === 'pointer') dispatch('pointerdown');
    state.maybeScroll(true);
    resize();
    assert.equal(state.chatScroll.scrollTop, 1340, gesture);
    dispatch('scroll');
    if (gesture === 'touch') dispatch('touchend');
    if (gesture === 'pointer') dispatch('pointerup', {}, 'window');
    assert.equal(state.followRunOutput, false, gesture);
    state.maybeScroll(true);
    layout();
    assert.equal(state.chatScroll.scrollTop, 1340, gesture);
  }
});

test('reply completion cannot override paused history reading', () => {
  const { state, layout } = scrollFixture();
  state.chatScroll.scrollTop = 1340;
  state.followRunOutput = false;
  state.running = false;
  state.maybeScroll(true);
  layout();
  assert.equal(state.chatScroll.scrollTop, 1340);
});

test('scrolling back to the bottom resumes automatic following', () => {
  const { state, dispatch, layout } = scrollFixture();
  state.running = true;
  state.followRunOutput = false;
  dispatch('wheel', { deltaY: 1000 });
  state.chatScroll.scrollTop = 1400;
  dispatch('scroll');
  assert.equal(state.followRunOutput, true);
  state.chatScroll.scrollHeight = 3000;
  state.maybeScroll(false);
  layout();
  assert.equal(state.chatScroll.scrollTop, 2400);
});

test('explicit submission resumes following after reading older messages', () => {
  const { state, layout } = scrollFixture();
  state.chatScroll.scrollTop = 100;
  state.followRunOutput = false;
  state.scrollToLatest();
  layout();
  assert.equal(state.followRunOutput, true);
  assert.equal(state.chatScroll.scrollTop, 1400);
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
      sharedChat: true, harnessId: 'codex', readUi: key => key === 'draft:session' ? saved : null, draftKey: () => 'session', input: {},
      context: { sessionId: 'session' }, conversationQueues: new Map(), messageQueue: [], renderMessageQueue() {},
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
    assert.equal(state.messageQueue.length, 0);
  }
});

test('history is revealed before live replay and final scrolling follows the reader', () => {
  const history = source.slice(source.indexOf('  async function openHistorySession(id)'), source.indexOf('  async function renderHistoryMessages(messages, pagination)'));
  assert.match(history, /resetConversationView\(\);\s*followRunOutput = true;\s*userScrollActive = false;\s*userScrollIntentUntil = 0;/);
  assert.match(history, /restoreDraft\(\);[\s\S]*await applyLiveRun\(res.live\)[\s\S]*void goalUI.refresh\(\);[\s\S]*if \(followRunOutput && !userScrollActive\) scrollToLatest\(\);\s*return true;/);
  const live = source.slice(source.indexOf('  async function applyLiveRun(live)'), source.indexOf('  // ---------- settings panel'));
  assert.match(live, /renderHistoryMessages\(live\.messages, live\.historyPage\)[\s\S]*scrollToLatest\(\);[\s\S]*classList\.remove\('history-opening'\)[\s\S]*for \(let index = 0; index < replayEvents\.length; index\+\+\)/);
});
