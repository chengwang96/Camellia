'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { view, notify, flush } = require('../src/engines/subagent-conversations');

function fixture() {
  const parent = { id: 'parent', title: 'Parent', currentEngine: 'codex' };
  const child = { id: 'child', title: 'Child', currentEngine: 'codex', controlParentId: 'parent',
    controlSends: [{ prompt: 'Work' }], controlHistoryBoundary: 0, controlUserSeq: 1, updatedAt: 1, createdAt: 1, seq: 0 };
  const active = { eventSeq: 1, events: [{ type: 'stream_event', event: {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' },
  } }], permissions: new Map(), facade: { gen: 1 }, engine: 'codex' };
  const events = [];
  const manager = {
    items: new Map([['parent', parent], ['child', child]]), active: new Map([['child', active]]), recovering: new Map(),
    workspaces: { sessionMeta: () => ({ titles: {}, archived: {} }) }, get: id => manager.items.get(id), busy: () => false,
    historyReads: 0,
    *historyRows() { manager.historyReads++; yield { role: 'assistant', seq: 1, text: 'Earlier result', at: 1 }; },
    onEvent: event => events.push(event),
  };
  manager.subagentView = id => view(manager, id);
  return { manager, child, active, events };
}

test('managed child streams coalesce publishes and reuse history until its sequence changes', async () => {
  const { manager, child, active, events } = fixture();
  notify(manager, child.id, { type: 'stream_event' });
  notify(manager, child.id, { type: 'stream_event' });
  assert.equal(events.length, 0);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(events.length, 1);
  assert.equal(manager.historyReads, 1);

  active.eventSeq++;
  active.events[0].event.delta.text += ' more';
  notify(manager, child.id, { type: 'stream_event' });
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(events.length, 2);
  assert.equal(events[1].tasks[0].progress, 'Working more');
  assert.equal(manager.historyReads, 1);

  child.seq++;
  manager.active.delete(child.id);
  notify(manager, child.id, { type: 'result' });
  assert.equal(manager.historyReads, 2);
  assert.ok(events.length >= 3);
  flush(manager);
});
