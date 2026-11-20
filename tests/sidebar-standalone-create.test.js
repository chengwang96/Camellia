'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/workbench-sidebar.js'), 'utf8');
const draftSource = source.slice(source.indexOf('  function sessionHasDraft('), source.indexOf('  function renderSessionSidebar('));
const renderSource = draftSource + source.slice(source.indexOf('  function sidebarButton('), source.indexOf('  async function runMetaOp('));
const updateSource = source.slice(source.indexOf('  function updateWorkspaceLabel('), source.indexOf('  async function loadSessionHistory('));

function element() {
  return {
    dataset: {}, children: [], listeners: {}, attributes: {}, scrollTop: 120, sourceText: '',
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute() {},
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    querySelector(selector) {
      if (!this.stamp) {
        this.stamp = { textContent: '', appendChild() {}, dataset: {}, classes: new Set(),
          classList: { toggle(name, value) { if (value) this.owner.classes.add(name); else this.owner.classes.delete(name); } } };
        this.stamp.classList.owner = this.stamp;
        this.stamp.dataset.i18n = selector === '.session-item-time' ? '' : undefined;
      }
      return this.stamp;
    },
    get childElementCount() { return this.children.length; },
    set textContent(value) { this.sourceText = value; },
    get textContent() { return this.sourceText; },
  };
}

function fixture() {
  const list = element(), topButton = element(), header = element(), created = [];
  header.textContent = 'New session';
  const context = {
    document: { createElement: element },
    window: { CamelliaI18n: { language: 'en' } },
    $: id => id === 'sessionList' ? list : id === 'newSessionBtn' ? topButton : id === 'headerTitle' ? header
      : list.children.flatMap(group => group.children).find(child => child.id === id),
    context: { sessionId: null, workspaceId: 'selected-workspace' },
    contextBusy: () => false,
    hasDraft: id => id === 'draft-session',
    renamingDiscussionId: null, renamingWorkspaceId: null, renamingWorkspaceInput: null,
    discussionVisible: () => false, getDiscussionId: () => null,
    sessionHistory: [{ id: 'draft-session', title: 'Unsent task', workspaceId: null, mtimeMs: Date.now() }],
    workspaces: [], pagination: {}, importableCount: 0, drag: null, navigation: null,
    sidebarRenderKey: '', discussionGroups: [], harnessId: 'codex',
    sidebarIcon: name => name,
    relTime: () => 'Now',
    discussionOpening: () => false,
    newSession: workspaceId => created.push(workspaceId),
  };
  vm.runInNewContext(updateSource + renderSource, context);
  return { context, list, topButton, created };
}

test('standalone heading has an accessible plus that creates a session without a workspace', () => {
  const { context, list, created } = fixture();
  context.renderSessionSidebar();
  const group = list.children.find(child => child.textContent === 'Standalone sessions');
  const button = group.children[0];
  assert.equal(group.className, 'sb-group sb-flex');
  assert.equal(group.dataset.dropGroup, 'recent');
  assert.equal(button.id, 'standaloneCreateBtn');
  assert.equal(button.type, 'button');
  assert.equal(button.className, 'session-more');
  assert.equal(button.innerHTML, 'plus');
  assert.equal(button.title, 'New standalone session');
  assert.equal(button.attributes['aria-label'], 'New standalone session');
  assert.equal(button.dataset.i18nAttrs, 'title aria-label');
  let stopped = false;
  button.listeners.click({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(created, [null]);
  assert.equal(list.scrollTop, 120);
});

test('standalone plus follows new-session busy state across updates and rerenders', () => {
  const { context, list, topButton } = fixture();
  context.updateWorkspaceLabel();
  context.renderSessionSidebar();
  const button = context.$('standaloneCreateBtn');
  assert.equal(button.disabled, false);
  context.contextBusy = () => true;
  context.updateWorkspaceLabel();
  assert.equal(button.disabled, true);
  assert.equal(topButton.disabled, true);
  context.renderSessionSidebar();
  assert.equal(context.$('standaloneCreateBtn').disabled, true);
  assert.equal(list.children.filter(child => child.textContent === 'Standalone sessions').length, 1);
  context.contextBusy = () => false;
  context.updateWorkspaceLabel();
  assert.equal(context.$('standaloneCreateBtn').disabled, false);
  assert.equal(topButton.disabled, false);
});

test('a saved standalone draft replaces the timestamp with a localized status', () => {
  const { context, list } = fixture();
  context.renderSessionSidebar();
  const independent = list.children.find(child => child.id === 'independentSessions');
  const item = independent.children.find(child => child.dataset?.sid === 'draft-session');
  assert.equal(item.stamp.textContent, 'Draft');
});
