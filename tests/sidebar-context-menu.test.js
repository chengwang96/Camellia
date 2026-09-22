'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude-sidebar.js'), 'utf8');
const itemSource = source.slice(source.indexOf('  function makeSessionItem(s)'), source.indexOf('  async function runMetaOp('));
const buttonSource = source.slice(source.indexOf('  function sidebarButton('), source.indexOf('  function appendGroup('));

function element() {
  return {
    dataset: {}, children: [], listeners: {},
    setAttribute() {},
    querySelector() { return { textContent: '' }; },
    appendChild(child) { this.children.push(child); },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    closest() { return null; },
  };
}

function fixture(session) {
  const menus = [], opened = [];
  const context = {
    document: { createElement: element },
    context: { sessionId: 'active' },
    $: () => ({ textContent: 'New session' }),
    input: { focus() { opened.push('input'); } },
    sidebarIcon: () => '', relTime: () => 'Now',
    openHistorySession: id => opened.push(id),
    openSessionActions: (...args) => menus.push(['session', ...args]),
    openWorkspacePicker: (...args) => menus.push(['workspace', ...args]),
  };
  vm.runInNewContext(buttonSource + itemSource, context);
  const item = context.makeSessionItem(session);
  const event = {
    target: item, clientX: 84, clientY: 156, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  return { item, event, menus, opened, button: item.children.at(-1) };
}

test('right-click opens the same session menu as the more button without switching sessions', () => {
  for (const session of [
    { id: 'active', title: 'Active' },
    { id: 'other', title: 'Other', workspaceId: 'workspace' },
    { id: 'pinned', title: 'Pinned', pinned: true },
  ]) {
    const { item, event, menus, opened, button } = fixture(session);
    item.listeners.contextmenu(event);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.deepEqual(menus[0].slice(0, 4), ['session', button, item, session]);
    assert.equal(menus[0][4].x, event.clientX);
    assert.equal(menus[0][4].y, event.clientY);
    button.listeners.click(event);
    assert.deepEqual(menus[1], ['session', button, item, session, undefined]);
    assert.deepEqual(opened, []);
    item.listeners.click();
    assert.deepEqual(opened, [session.id === 'active' ? 'input' : session.id]);
  }
});

test('right-click and more on a new session open its action menu', () => {
  const { item, event, menus, button } = fixture(null);
  item.listeners.contextmenu(event);
  assert.deepEqual(menus[0].slice(0, 4), ['session', button, item, null]);
  assert.equal(menus[0][4].x, event.clientX);
  assert.equal(menus[0][4].y, event.clientY);
  button.listeners.click(event);
  assert.deepEqual(menus[1], ['session', button, item, null, undefined]);
});

function actionFixture({ busy = false, fixedCwd = false } = {}) {
  const menus = [], picked = [];
  const context = {
    contextBusy: () => busy,
    chatProfile: { fixedCwd },
    canFork: () => true,
    openActionMenu: (anchor, actions, position) => menus.push({ anchor, actions, position }),
    openWorkspacePicker: (...args) => picked.push(args),
  };
  const actionsSource = source.slice(source.indexOf('  function openSessionActions('), source.indexOf('  function openWorkspacePicker('));
  vm.runInNewContext(actionsSource, context);
  return { context, menus, picked };
}

test('new session actions defer workspace selection and hide saved-session operations', () => {
  for (const fixedCwd of [false, true]) {
    const { context, menus, picked } = actionFixture({ fixedCwd });
    const anchor = element();
    context.openSessionActions(anchor, element(), null);
    assert.equal(menus[0].anchor, anchor);
    assert.deepEqual(Array.from(menus[0].actions, action => action.label), ['Change workspace…']);
    assert.equal(menus[0].actions[0].disabled, false);
    assert.deepEqual(picked, []);
    menus[0].actions[0].run();
    assert.deepEqual(picked, [[anchor, null, undefined]]);
  }
});

test('new session workspace action is disabled while context is busy', () => {
  const { context, menus } = actionFixture({ busy: true });
  context.openSessionActions(element(), element(), null);
  assert.equal(menus[0].actions[0].disabled, true);
});

test('right-click position is preserved when opening a workspace picker', () => {
  for (const session of [null, { id: 'saved', workspaceId: 'workspace' }]) {
    const { context, menus, picked } = actionFixture();
    const anchor = element();
    const position = { x: 42, y: 240 };
    context.openSessionActions(anchor, element(), session, position);
    assert.equal(menus[0].position, position);
    menus[0].actions.find(action => action.label.endsWith('workspace…')).run();
    assert.deepEqual(picked, [[anchor, session, position]]);
  }
});

test('saved session actions retain their existing operations and directory restrictions', () => {
  for (const fixedCwd of [false, true]) {
    const { context, menus } = actionFixture({ fixedCwd });
    context.openSessionActions(element(), element(), { id: 'saved', workspaceId: 'workspace' });
    assert.deepEqual(Array.from(menus[0].actions, action => action.label), [
      'Rename', 'Pin session',
      ...(!fixedCwd ? ['Move to workspace…', 'Move out of workspace'] : []),
      'Fork session', 'Archive session',
    ]);
  }
});

test('right-click on the more button opens the session menu once', () => {
  const { item, event, menus, button } = fixture({ id: 'other', title: 'Other' });
  event.target = button;
  item.listeners.contextmenu(event);
  assert.equal(menus.length, 1);
  assert.equal(event.prevented, true);
});

test('right-click in an inline rename field retains the native editing menu', () => {
  const { item, event, menus } = fixture({ id: 'other', title: 'Other' });
  event.target = { closest: selector => selector === 'input, textarea, [contenteditable]' ? {} : null };
  item.listeners.contextmenu(event);
  assert.equal(event.prevented, false);
  assert.equal(event.stopped, false);
  assert.deepEqual(menus, []);
});
