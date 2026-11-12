'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const shortcuts = require('../src/shared/shortcuts.js');

const key = (value, overrides = {}) => ({
  key: value, code: overrides.code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides,
});

test('shortcut normalization is canonical, platform-neutral and rejects unsafe bindings', () => {
  assert.equal(shortcuts.normalize('cmdorctrl+shift+h'), 'CommandOrControl+Shift+H');
  assert.equal(shortcuts.normalize('Command+Alt+Up'), 'Command+Alt+Up');
  assert.equal(shortcuts.normalize('  '), '');
  assert.equal(shortcuts.normalize('F5'), 'F5');
  assert.equal(shortcuts.normalize('G'), null);
  assert.equal(shortcuts.normalize('CommandOrControl+Shift'), null);
  assert.equal(shortcuts.normalize('CommandOrControl+Control+H'), null);
  assert.equal(shortcuts.normalize('CommandOrControl+Banana'), null);
  assert.equal(shortcuts.normalize(null), null);
  assert.equal(shortcuts.normalize(42), null);
});

test('shortcut resolution keeps explicit empty bindings and falls back from invalid values', () => {
  const resolved = shortcuts.resolve({ goal: '', home: 'CmdOrCtrl+Alt+H', review: 'broken' });
  assert.equal(resolved.goal, '');
  assert.equal(resolved.home, 'CommandOrControl+Alt+H');
  assert.equal(resolved.review, 'CommandOrControl+Shift+R');
  assert.equal(shortcuts.resolve().settings, 'CommandOrControl+,');
});

test('keyboard events map to accelerators across layouts and modifier sets', () => {
  assert.equal(shortcuts.fromEvent(key('!', { code: 'Digit1', ctrlKey: true, shiftKey: true }), 'win32'), 'CommandOrControl+Shift+1');
  assert.equal(shortcuts.fromEvent(key(',', { code: 'Comma', ctrlKey: true }), 'win32'), 'CommandOrControl+,');
  assert.equal(shortcuts.fromEvent(key('Control', { code: 'ControlLeft', ctrlKey: true }), 'win32'), null);
  assert.equal(shortcuts.fromEvent(key('h', { code: 'KeyH', ctrlKey: true, shiftKey: true }), 'win32'), 'CommandOrControl+Shift+H');
  assert.equal(shortcuts.fromEvent(key('g', { code: 'KeyG', metaKey: true }), 'darwin'), 'CommandOrControl+G');
});

test('shortcut matching respects the platform primary modifier and exact modifier set', () => {
  const win = key('H', { code: 'KeyH', ctrlKey: true, shiftKey: true });
  assert.equal(shortcuts.matches(win, 'CommandOrControl+Shift+H', 'win32'), true);
  assert.equal(shortcuts.matches(win, 'CommandOrControl+H', 'win32'), false);
  assert.equal(shortcuts.matches({ ...win, altKey: true }, 'CommandOrControl+Shift+H', 'win32'), false);
  const mac = key('G', { code: 'KeyG', metaKey: true });
  assert.equal(shortcuts.matches(mac, 'CommandOrControl+G', 'darwin'), true);
  assert.equal(shortcuts.matches(mac, 'CommandOrControl+G', 'win32'), false);
  assert.equal(shortcuts.matches(win, '', 'win32'), false);
});

test('renderer bindings load from the host and follow live changes', async () => {
  let changed;
  const desktop = {
    platform: 'win32',
    shortcutsGet: async () => ({ ok: true, shortcuts: { goal: 'CommandOrControl+Alt+G' } }),
    onShortcutsChanged: callback => { changed = callback; },
  };
  const bindings = shortcuts.watchBindings(desktop);
  await new Promise(resolve => setImmediate(resolve));
  const event = key('g', { code: 'KeyG', ctrlKey: true, altKey: true });
  assert.equal(bindings.matches(event, 'goal'), true);
  changed({ ...shortcuts.resolve(), goal: '' });
  assert.equal(bindings.matches(event, 'goal'), false);
  changed({ ...shortcuts.resolve(), home: 'CommandOrControl+Alt+H' });
  assert.equal(bindings.matches(key('h', { code: 'KeyH', ctrlKey: true, altKey: true }), 'home'), true);
});

test('display text and reserved bindings follow the platform', () => {
  assert.deepEqual(shortcuts.displayParts('CommandOrControl+Shift+H', 'win32'), ['Ctrl', 'Shift', 'H']);
  assert.deepEqual(shortcuts.displayParts('CommandOrControl+Shift+H', 'darwin'), ['⌘', '⇧', 'H']);
  assert.deepEqual(shortcuts.displayParts('CommandOrControl+Alt+Up', 'win32'), ['Ctrl', 'Alt', '↑']);
  assert.equal(shortcuts.reserved('CmdOrCtrl+R'), true);
  assert.equal(shortcuts.reserved('Alt+F4'), true);
  assert.equal(shortcuts.reserved('F10'), true);
  assert.equal(shortcuts.reserved('F11'), true);
  assert.equal(shortcuts.reserved('CommandOrControl+Shift+R'), false);
  assert.equal(shortcuts.equals('CmdOrCtrl+Shift+H', 'CommandOrControl+Shift+H'), true);
  assert.equal(shortcuts.equals('', ''), false);
});
