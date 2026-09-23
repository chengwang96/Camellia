'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude-sidebar.js'), 'utf8');
const renderSource = source.slice(source.indexOf('  function sidebarButton('), source.indexOf('  function makeSessionItem('));
const updateSource = source.slice(source.indexOf('  function updateWorkspaceLabel('), source.indexOf('  async function loadSessionHistory('));

function element() {
  return {
    dataset: {}, children: [], listeners: {}, attributes: {}, scrollTop: 120,
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    get childElementCount() { return this.children.length; },
  };
}

function fixture() {
  const list = element(), topButton = element(), created = [];
  const context = {
    document: { createElement: element },
    $: id => id === 'sessionList' ? list : id === 'newSessionBtn' ? topButton
      : list.children.flatMap(group => group.children).find(child => child.id === id),
    context: { sessionId: null, workspaceId: 'selected-workspace' },
    contextBusy: () => false,
    sessionHistory: [], workspaces: [], pagination: {}, importableCount: 0, drag: null,
    sidebarIcon: name => name,
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
