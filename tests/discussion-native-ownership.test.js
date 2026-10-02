'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NativeSessionOwnership, collectNativeOwners } = require('../src/engines/discussions/native-ownership');

function identity() {
  return { engine: 'codex', discussionId: randomUUID(), participantId: randomUUID(),
    runtimeId: randomUUID(), generation: 1, nativeId: null };
}
function owned(input, nativeId = input.nativeId) {
  return { engine: input.engine, runtimeId: input.runtimeId, nativeId,
    ownerId: `discussion/${input.discussionId}/${input.participantId}/${input.generation}` };
}

test('ordinary current, parked, retired and external histories all exclude discussion continuation', () => {
  const ordinary = { id: randomUUID(), currentEngine: 'codex', segments: { codex: { nativeId: 'current' } },
    modelSessions: { parked: { engine: 'codex', nativeId: 'parked' } },
    retiredSegments: [{ engine: 'codex', nativeId: 'retired' }] };
  const ownership = new NativeSessionOwnership({ readOwners: () => collectNativeOwners({
    conversations: [ordinary], external: [{ engine: 'codex', nativeId: 'external' }],
  }) });
  for (const nativeId of ['current', 'parked', 'retired', 'external']) {
    assert.throws(() => ownership.reserve({ ...identity(), nativeId }), /another.*owner/);
    const lease = ownership.reserve(identity());
    assert.throws(() => ownership.claimNative(lease, nativeId), /another.*owner/);
    ownership.release(lease);
  }
  assert.throws(() => ownership.reserve({ ...identity(), runtimeId: ordinary.id }), /another.*owner/);
});

test('live claims isolate duplicate bindings, retain ownership after stop, and require exact continuation', () => {
  const ownership = new NativeSessionOwnership({ readOwners: () => [] });
  const a = identity(), b = identity(), first = ownership.reserve(a), second = ownership.reserve(b);
  assert.throws(() => ownership.reserve(a), /reserved/);
  ownership.claimNative(first, 'native-a'); ownership.claimNative(second, 'native-b');
  assert.throws(() => ownership.claimNative(second, 'native-a'), /changed ownership/);
  ownership.release(first); ownership.release(second);
  assert.throws(() => ownership.reserve({ ...b, nativeId: 'native-a' }), /native ID/);
  assert.throws(() => ownership.reserve({ ...identity(), nativeId: 'native-a' }), /another owner/);
  assert.throws(() => ownership.reserve(a), /native ID/);
  const continuation = ownership.reserve({ ...a, nativeId: 'native-a' });
  ownership.assert(continuation); ownership.release(continuation);
  assert.throws(() => ownership.assert(continuation), /not active/);
  assert.throws(() => ownership.reserve({ ...a, engine: 'antigravity', nativeId: 'native-a' }), /another owner/);
});

test('restart inventory permits only the recorded current generation; removed and retired owners remain reserved', () => {
  const a = identity(), b = identity();
  const groups = [{ id: a.discussionId, participants: [{ id: a.participantId, engine: a.engine, removed: true,
    session: { generation: 2, runtimeId: b.runtimeId, nativeId: 'current' },
    retiredSessions: [{ generation: 1, runtimeId: a.runtimeId, nativeId: 'old', profile: { engine: a.engine } }],
  }] }];
  const ownership = new NativeSessionOwnership({ readOwners: () => collectNativeOwners({ discussions: groups }) });
  assert.throws(() => ownership.reserve({ ...a, nativeId: 'old' }), /retired owner/);
  assert.throws(() => ownership.reserve({ ...identity(), nativeId: 'current' }), /another.*owner/);
  // Manager admission blocks removed members; the inventory independently keeps
  // their native history owned even though no process is running.
  const current = { ...a, generation: 2, runtimeId: b.runtimeId, nativeId: 'current' };
  assert.throws(() => ownership.reserve(current), /retired owner/);
  groups[0].participants[0].removed = false;
  const lease = ownership.reserve(current); ownership.release(lease);
  assert.throws(() => ownership.reserve({ ...identity(), nativeId: 'untracked' }), /no verified owner/);
});

test('process generations remain monotonic across released leases and adapter replacements', () => {
  const ownership = new NativeSessionOwnership({ readOwners: () => [] }), input = identity();
  const first = ownership.reserve(input);
  ownership.claimProcess(first, 9); ownership.claimNative(first, 'native'); ownership.release(first);
  const second = ownership.reserve({ ...input, nativeId: 'native' });
  for (const generation of [1, 9, 0, null, Infinity]) assert.throws(() => ownership.claimProcess(second, generation), /generation was reused/);
  ownership.claimProcess(second, 10); ownership.release(second);
});

test('ownership is rechecked against live sources and never becomes free after a failed inventory read', () => {
  const a = identity(); let rows = [owned(a)], failure;
  const ownership = new NativeSessionOwnership({ readOwners: () => { if (failure) throw failure; return rows; } });
  const lease = ownership.reserve(a);
  rows.push({ engine: 'codex', nativeId: 'collision', ownerId: 'conversation/foreign' });
  assert.throws(() => ownership.claimNative(lease, 'collision'), /another.*owner/);
  ownership.claimNative(lease, 'new');
  rows.push({ engine: 'codex', runtimeId: a.runtimeId, ownerId: 'conversation/foreign' });
  assert.throws(() => ownership.assert(lease), /another.*owner/);
  failure = new Error('inventory damaged');
  assert.throws(() => ownership.assert(lease), /damaged/);
  assert.throws(() => ownership.reserve(a), /reserved/);
  // Termination can release the active lease even when inventory reads fail;
  // tombstones still prevent reassignment when the inventory becomes readable.
  ownership.release(lease); failure = null; rows = [];
  assert.throws(() => ownership.reserve({ ...identity(), nativeId: 'new' }), /another owner/);
});

test('missing, invalid or asynchronous inventory cannot authorize a native session', async () => {
  assert.throws(() => new NativeSessionOwnership({}), /required/);
  for (const rows of [undefined, {}, [{ engine: 'codex', ownerId: 'x' }],
    [{ engine: 'codex', nativeId: '../unsafe', ownerId: 'x' }]]) {
    const ownership = new NativeSessionOwnership({ readOwners: () => rows });
    assert.throws(() => ownership.reserve(identity()), /Invalid.*inventory/);
  }
  const ownership = new NativeSessionOwnership({ readOwners: async () => { throw new Error('late rejection'); } });
  assert.throws(() => ownership.reserve(identity()), /synchronous/);
  await new Promise(resolve => setImmediate(resolve));
});
