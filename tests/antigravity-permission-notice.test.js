'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { permissionNotice } = require('../src/engines/antigravity/permission-notice.cjs');

test('native headless denial becomes a failed tool notice, never an approval request', () => {
  const line = 'write_file required the permission confirmation that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json';
  const notice = permissionNotice('\u001b[33m' + line + '\u001b[0m');
  assert.equal(notice.sessionUpdate, 'tool_call_update');
  assert.equal(notice.status, 'failed');
  assert.equal(notice.permissionBlocked, true);
  assert.equal(notice.content[0].content.text, line);
  assert.equal(notice.options, undefined);
  assert.notEqual(notice.toolCallId, permissionNotice(line).toolCallId);
});

test('ordinary diagnostics and filesystem errors are not approval notices', () => {
  for (const line of ['permission denied', 'network timeout', 'Print mode: soft-denying tool confirmation', '', 'Tool completed']) {
    assert.equal(permissionNotice(line), null);
  }
});
