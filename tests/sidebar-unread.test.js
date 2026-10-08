'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude-sidebar.js'), 'utf8');
const readSource = source.slice(source.indexOf('  function markReplyRead'), source.indexOf('  // ---------- Workspaces'));

function fixture() {
  const calls = [], errors = [];
  const sessions = [{ id: 'opened', unread: true }, { id: 'other', unread: true }];
  const items = ['opened', 'other', 'opened'].map(id => ({
    dataset: { sid: id },
    classList: { classes: new Set(['session-item', 'unread']), remove(name) { this.classes.delete(name); } },
  }));
  const list = { scrollTop: 120, querySelectorAll: () => items };
  const context = {
    harnessId: 'codex',
    sessionHistory: sessions,
    window: { dshDesktop: { conversationCommand: payload => { calls.push(payload); return Promise.resolve({ ok: true }); } } },
    setStatus: text => errors.push(text),
    $: id => { assert.equal(id, 'sessionList'); return list; },
  };
  vm.runInNewContext(readSource, context);
  return { context, sessions, items, list, calls, errors };
}

test('marking a reply read immediately clears its rendered dots without rebuilding the sidebar', () => {
  const { context, sessions, items, list, calls } = fixture();
  context.markReplyRead('opened', 1234);
  assert.equal(sessions[0].unread, false);
  assert.equal(calls[0].payload.id, 'opened');
  assert.equal(calls[0].payload.at, 1234);
  assert.equal(items[0].classList.classes.has('unread'), false);
  assert.equal(items[2].classList.classes.has('unread'), false);
  assert.equal(items[0].classList.classes.has('session-item'), true);
  assert.equal(list.scrollTop, 120);
  assert.equal(sessions[1].unread, true);
  assert.equal(items[1].classList.classes.has('unread'), true);
});

test('repeated read acknowledgements are safe and a missing session does not clear other dots', () => {
  const { context, items, calls } = fixture();
  context.markReplyRead('missing', 100);
  context.markReplyRead(null, 100);
  assert.equal(calls.length, 1);
  assert.ok(items.every(item => item.classList.classes.has('unread')));
  context.markReplyRead('opened', 200);
  context.markReplyRead('opened', 200);
  assert.equal(items[0].classList.classes.has('unread'), false);
  assert.equal(items[1].classList.classes.has('unread'), true);
});

test('desktop read acknowledgements always use the conversation manager', () => {
  const { context, calls, items } = fixture();
  context.markReplyRead('opened', 1234);
  assert.equal(calls[0].engine, 'codex');
  assert.equal(calls[0].action, 'mark-reply-read');
  assert.equal(calls[0].payload.id, 'opened');
  assert.equal(calls[0].payload.at, 1234);
  assert.equal(items[0].classList.classes.has('unread'), false);
});
