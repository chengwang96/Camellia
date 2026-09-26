'use strict';

const { randomUUID } = require('node:crypto');

function permissionNotice(line) {
  const text = String(line).replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!/headless mode cannot prompt for/i.test(text) || !/auto-denied/i.test(text)) return null;
  return { sessionUpdate: 'tool_call_update', toolCallId: 'permission-' + randomUUID(),
    title: 'Antigravity CLI permission blocked', status: 'failed', permissionBlocked: true,
    content: [{ type: 'content', content: { type: 'text', text } }] };
}

module.exports = { permissionNotice };
