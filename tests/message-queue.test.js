'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.html'), 'utf8');

test('active conversations queue composed messages instead of stopping', () => {
  assert.match(markup, /id="messageQueue"/);
  assert.match(source, /if \(active && !queuedMessage\) \{\s*if \(queueComposerMessage\(\)\) return;/);
  assert.match(source, /messageQueue\.push\(\{ text, attachments: queuedAttachments \}\)/);
  assert.match(source, /function queueComposerMessage\(\) \{[\s\S]*?followRunOutput = true;\s*maybeScroll\(true\);/);
});

test('queued messages drain after result and shared activity completion', () => {
  assert.match(source, /setRunning\(false\);[\s\S]*currentRunId = null;[\s\S]*drainMessageQueue\(\)/);
  assert.match(source, /if \(!conversationActivity\) drainMessageQueue\(\)/);
  assert.match(source, /const next = messageQueue\.shift\(\);[\s\S]*send\(next\)/);
});

test('an empty composer preserves the active stop action', () => {
  assert.match(source, /if \(queueComposerMessage\(\)\) return;[\s\S]*await chatApi\.cancel/);
  assert.match(source, /sendBtn\.classList\.toggle\('stop', active && !hasMessage\)/);
  assert.match(source, /sendBtn\.classList\.toggle\('queue', active && hasMessage\)/);
});

test('send button click does not pass the event as a queued message', () => {
  assert.doesNotMatch(source, /addEventListener\('click', send\)/);
  assert.match(source, /sendBtn\.addEventListener\('click', \(\) => void send\(\)\)/);
});
