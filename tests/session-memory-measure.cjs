'use strict';
// Measures resident memory for SharedConversations as conversations accumulate.
// This is a diagnostic, not a regression gate: run it before deciding whether a
// session-object LRU is warranted.
//
// Measured on this machine (Node 24, --expose-gc):
//   200 conversations x 40 turns  -> +0.8 MB after create, +1.2 MB after reload
//  1000 conversations x 60 turns  -> +1.1 MB after create, +3.0 MB after reload
// The loaded objects are metadata plus the history index, not message bodies,
// so a 1000-conversation profile stays a few megabytes. Do not add an LRU until
// a real profile shows growth that matters; the index cache already has a
// separate 16 MB bound.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');

const COUNT = Number(process.argv[2]) || 200;
const MESSAGES = Number(process.argv[3]) || 40;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-memory-'));
const drivers = Object.fromEntries(ENGINES.map(engine => [engine, {
  settings: () => ({ model: 'fixture' }), saveSettings: value => value,
  ensure(opts) {
    return { gen: 1, sessionId: opts.sessionId || 'memory-' + engine, running: false,
      settings: { cwd: opts.cwd }, opts, sendUserMessage() { return true; },
      interrupt() {}, answerPermission() { return true; } };
  },
}]));

const manager = new SharedConversations({
  dir, skillsDir: path.join(dir, 'skills'), loadConfig: () => ({}), saveConfig: () => {}, drivers,
});

const mb = bytes => Math.round(bytes / 1024 / 1024 * 10) / 10;
const heap = () => {
  global.gc?.();
  return process.memoryUsage().heapUsed;
};

const before = heap();
const conversations = [];
for (let index = 0; index < COUNT; index += 1) {
  const conversation = manager.create('claude', null, 'Memory ' + index);
  for (let turn = 0; turn < MESSAGES; turn += 1) {
    manager.append(conversation, { role: 'user', text: 'Question ' + turn + ' '.repeat(200) });
    manager.append(conversation, { role: 'assistant', engine: 'claude',
      text: 'Answer ' + turn + ' '.repeat(1200) });
  }
  conversations.push(conversation);
}
const after = heap();

const reloaded = new SharedConversations({
  dir, skillsDir: path.join(dir, 'skills'), loadConfig: () => ({}), saveConfig: () => {}, drivers,
});
const afterReload = heap();

const bytesPerConversation = (after - before) / Math.max(1, COUNT);
console.log(JSON.stringify({
  conversations: COUNT,
  messagesPerConversation: MESSAGES,
  heapBeforeMB: mb(before),
  heapAfterCreateMB: mb(after),
  heapAfterReloadMB: mb(afterReload),
  deltaPerConversationKB: Math.round(bytesPerConversation / 1024),
  loadedOnStartup: reloaded.items.size,
  totalRowsAcrossConversations: conversations.length * MESSAGES * 2,
}, null, 2));

removeTree(dir);
