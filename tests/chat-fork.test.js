'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { translate } = require('../src/shared/i18n');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const forkSource = source.slice(source.indexOf('  async function forkSession(s)'), source.indexOf('  async function openHistorySession(id)'));

function fixture(overrides = {}) {
  const calls = [];
  const state = {
    sharedChat: true, pendingForkId: null, loadingSession: false,
    context: { sessionId: 'source', workspaceId: 'workspace' },
    input: { disabled: false, focus() { calls.push('focus'); } },
    window: { CamelliaI18n: { ready: Promise.resolve(), t: text => translate(text, 'zh-CN') } },
    conversationBusy: () => false,
    updateConversationControls() {}, updateSendEnabled() {},
    sidebar: {
      workspaces: [{ id: 'workspace', collapsed: true }],
      updateLabel() {}, async load() { calls.push('list'); },
    },
    chatApi: {
      async forkSession(payload) { calls.push(['fork', payload.sessionId, payload.title]); return { ok: true, sessionId: 'fork' }; },
      async metaOp(payload) { calls.push(['expand', payload.workspaceId]); return { ok: true }; },
    },
    async openHistorySession(id) {
      assert.equal(state.loadingSession, false);
      calls.push(['open', id]);
      state.context.sessionId = id;
      return true;
    },
    setStatus(text) { state.status = text; },
    ...overrides,
  };
  vm.createContext(state);
  vm.runInContext(forkSource, state);
  return { state, calls };
}

test('fork click creates, lists and opens a named branch without waiting for a message', async () => {
  const { state, calls } = fixture();
  await state.forkSession({ id: 'source', title: 'Research' });
  assert.deepEqual(calls, [['open', 'source'], ['fork', 'source', '分叉 · Research'], ['expand', 'workspace'], 'list', ['open', 'fork'], 'focus']);
  assert.equal(state.context.sessionId, 'fork');
  assert.equal(state.pendingForkId, null);
  assert.equal(state.loadingSession, false);
  assert.equal(state.input.disabled, false);
  assert.match(state.status, /Rename/);
});

test('failed fork keeps the original session and unlocks the composer', async () => {
  for (const forkSession of [async () => ({ ok: false, error: 'Fork failed' }), async () => { throw new Error('Fork failed'); }]) {
    const { state, calls } = fixture({ chatApi: { forkSession } });
    await state.forkSession({ id: 'source', title: 'Research' });
    assert.deepEqual(calls, [['open', 'source']]);
    assert.equal(state.context.sessionId, 'source');
    assert.equal(state.pendingForkId, null);
    assert.equal(state.loadingSession, false);
    assert.equal(state.input.disabled, false);
    assert.match(state.status, /Fork failed/);
  }
});

test('fork prefixes use the loaded language and follow subsequent language changes', async () => {
  let language = 'en', loadLanguage;
  const ready = new Promise(resolve => { loadLanguage = () => { language = 'zh-CN'; resolve(); }; });
  const { state, calls } = fixture({ window: { CamelliaI18n: { ready, t: text => translate(text, language) } } });
  const pending = state.forkSession({ id: 'source', title: 'Research $&' });
  await Promise.resolve();
  assert.equal(calls.some(call => call[0] === 'fork'), false);
  loadLanguage();
  await pending;
  assert.deepEqual(calls.find(call => call[0] === 'fork'), ['fork', 'source', '分叉 · Research $&']);
  calls.length = 0;
  language = 'en';
  await state.forkSession({ id: 'source', title: 'Research $&' });
  assert.deepEqual(calls.find(call => call[0] === 'fork'), ['fork', 'source', 'Fork of Research $&']);
});

test('busy source cannot be forked from the sidebar', async () => {
  const { state, calls } = fixture({ conversationBusy: () => true });
  await state.forkSession({ id: 'source', title: 'Research' });
  assert.deepEqual(calls, [['open', 'source']]);
  assert.match(state.status, /finish before forking/);
});
