'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(headers) {
  const listeners = new Map(), updates = [];
  const ctx = { agents: { get: id => headers[id] && { session: { header: headers[id] } } },
    on: (name, callback) => listeners.set(name, callback) };
  const source = fs.readFileSync(path.join(__dirname, '../src/engines/dsh-subagents.mjs'), 'utf8');
  vm.runInNewContext(source.replace('export function apply', 'function apply') + '\napply(ctx);', {
    ctx, process: { stdout: { write: line => updates.push(JSON.parse(line).params) } },
  });
  return { updates, emit: (name, ...args) => listeners.get(name)(...args) };
}

test('DSH child events stop at the active ordinary fork instead of its historical parent', () => {
  const h = fixture({ source: {}, fork: { parentSession: 'source', isSeeded: true },
    child: { parentSession: 'fork', origin: 'subagent' }, grandchild: { parentSession: 'child', origin: 'subagent' } });
  for (const id of ['child', 'grandchild']) {
    h.emit('subagent/start', { id, runId: id + '-run' });
    h.emit('subagent/end', { id, runId: id + '-run', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'Done' }] });
    assert.equal(h.updates.at(-1).sessionId, 'fork');
    assert.equal(h.updates.at(-1).update.task.status, 'completed');
  }
});

test('DSH current user-message shape supplies the child goal and title', () => {
  const h = fixture({ root: {}, child: { parentSession: 'root', origin: 'subagent' } });
  h.emit('subagent/start', { id: 'child', runId: 'run' });
  h.emit('session/event', { id: 'child' }, { type: 'user/message', data: { content: [{ type: 'text', text: 'Inspect the parser\nRead the source' }] } });
  assert.equal(h.updates.at(-1).update.task.title, 'Inspect the parser');
  assert.equal(h.updates.at(-1).update.task.goal, 'Inspect the parser\nRead the source');
});

test('DSH replayed startup and stale completion cannot revive or finish another child activation', () => {
  const h = fixture({ root: {}, child: { parentSession: 'root', origin: 'subagent' } });
  const start = runId => h.emit('subagent/start', { id: 'child', runId });
  const end = (runId, stopReason) => h.emit('subagent/end', { id: 'child', runId, stopReason });
  start('one'); end('one', 'completed'); start('one');
  assert.equal(h.updates.at(-1).update.task.status, 'completed');
  start('two'); end('one', 'aborted');
  assert.equal(h.updates.at(-1).update.task.status, 'running');
  end('two', 'aborted'); assert.equal(h.updates.at(-1).update.task.status, 'stopped');
});
