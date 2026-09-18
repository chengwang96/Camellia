'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./claude-harness.cjs');

test('close-to-tray preference defaults off, persists, and survives partial saves', () => {
  const first = createHarness();
  try {
    assert.equal(first.call('workbench-settings').closeToTray, false);
    assert.equal(first.call('workbench-save-settings', { language: 'en', theme: 'system', autoRefreshBalances: false, closeToTray: true }).ok, true);
    assert.equal(first.call('workbench-settings').closeToTray, true);
    const reopened = createHarness(first.root);
    assert.equal(reopened.call('workbench-settings').closeToTray, true);
    // Older callers that do not send the key must retain the saved choice.
    assert.equal(reopened.call('workbench-save-settings', { theme: 'dark' }).ok, true);
    assert.equal(reopened.call('workbench-settings').closeToTray, true);
    assert.equal(reopened.call('workbench-save-settings', { language: 'en', theme: 'system', autoRefreshBalances: false, closeToTray: false }).ok, true);
    assert.equal(reopened.call('workbench-settings').closeToTray, false);
  } finally { first.cleanup(); }
});
