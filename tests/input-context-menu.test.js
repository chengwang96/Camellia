'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachInputContextMenu } = require('../src/main/input-context-menu');
const { translate } = require('../src/shared/i18n');

function createHarness() {
  const contents = new EventEmitter();
  const templates = [];
  const popups = [];
  let language = 'zh-CN';
  attachInputContextMenu(contents, {
    Menu: {
      buildFromTemplate(template) {
        templates.push(template);
        return { popup: options => popups.push(options) };
      },
    },
    uiText: text => translate(text, language),
  });
  return { contents, templates, popups, setLanguage: value => { language = value; } };
}

test('editable context menu contains only cut, copy, paste and select all', () => {
  const harness = createHarness();
  const frame = {};
  harness.contents.emit('context-menu', {}, {
    isEditable: true, frame,
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
  });
  assert.deepEqual(harness.templates[0], [
    { role: 'cut', label: '剪切', enabled: true },
    { role: 'copy', label: '复制', enabled: true },
    { role: 'paste', label: '粘贴', enabled: true },
    { role: 'selectAll', label: '全选', enabled: true },
  ]);
  assert.equal(harness.popups[0].frame, frame);
});

test('non-editable content does not open an input menu', () => {
  const harness = createHarness();
  harness.contents.emit('context-menu', {}, { isEditable: false });
  assert.equal(harness.templates.length, 0);
  assert.equal(harness.popups.length, 0);
});

test('unavailable actions are disabled and labels follow the current language', () => {
  const harness = createHarness();
  const params = {
    isEditable: true,
    editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: false },
  };
  harness.contents.emit('context-menu', {}, params);
  assert.deepEqual(harness.templates[0].map(item => item.enabled), [false, false, true, false]);
  harness.setLanguage('en');
  harness.contents.emit('context-menu', {}, params);
  assert.deepEqual(harness.templates[1].map(item => item.label), ['Cut', 'Copy', 'Paste', 'Select all']);
  params.editFlags.canPaste = false;
  harness.contents.emit('context-menu', {}, params);
  assert.equal(harness.templates[2][2].enabled, false);
});
