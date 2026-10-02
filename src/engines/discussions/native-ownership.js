'use strict';

const { validSessionId } = require('../claude-history');
const { nativeStorage, storageKey, sameStorage } = require('./native-storage');

const ENGINES = new Set(['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nativeKey = (engine, nativeId) => JSON.stringify([engine, process.platform === 'win32' && typeof nativeId === 'string' ? nativeId.toLowerCase() : nativeId]);
const runtimeKey = id => id.toLowerCase();
const discussionOwner = value => `discussion/${value.discussionId.toLowerCase()}/${value.participantId.toLowerCase()}/${value.generation}`;
const sameStoredId = (a, b) => typeof a === 'string' && typeof b === 'string' && Boolean(a && b)
  && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function validateNativeOwners(owners) {
  if (!Array.isArray(owners) || owners.some(row => !row || !ENGINES.has(row.engine)
    || typeof row.ownerId !== 'string' || !row.ownerId
    || row.runtimeId != null && !validSessionId(row.runtimeId)
    || row.nativeId != null && !validSessionId(row.nativeId)
    || row.nativeStorage != null && (row.engine !== 'antigravity' || !row.nativeId)
    || row.storageVerified !== undefined && (row.engine !== 'antigravity' || typeof row.storageVerified !== 'boolean'
      || row.storageVerified && !row.nativeStorage)
    || !row.runtimeId && !row.nativeId
    || row.retired !== undefined && typeof row.retired !== 'boolean')) {
    throw new Error('Invalid native ownership inventory');
  }
  for (const row of owners) if (row.nativeStorage != null) nativeStorage(row.nativeStorage);
  return owners;
}

function rememberForeignNatives(record, owners) {
  for (const owner of owners) {
    if (owner.engine === record.engine && owner.nativeId
      && (owner.ownerId !== record.ownerId || owner.retired === true)) {
      record.preexistingNatives.add(nativeKey(owner.engine, owner.nativeId));
      if (owner.nativeStorage) record.preexistingStorage.add(storageKey(owner.nativeStorage));
    }
  }
}

// Flatten authoritative application records, including parked, removed and
// retired histories. `external` contains unmanaged native histories/activities,
// not a second copy of histories already attributed to a logical owner. The
// main process must supply a complete, current inventory; no IPC declarations.
function collectNativeOwners({ discussions = [], conversations = [], external = [] } = {}) {
  const owners = [];
  for (const group of discussions) {
    for (const participant of group.participants) {
      for (const [session, engine, retired] of [[participant.session, participant.engine, participant.removed === true],
        ...participant.retiredSessions.map(session => [session, session.profile.engine, true])]) {
        owners.push({ engine, runtimeId: session.runtimeId, nativeId: session.nativeId,
          ...(session.nativeStorage ? { nativeStorage: session.nativeStorage } : {}),
          ownerId: discussionOwner({ discussionId: group.id, participantId: participant.id, generation: session.generation }), retired });
      }
    }
  }
  for (const conversation of conversations) {
    for (const segment of [
      ...Object.entries(conversation.segments).map(([engine, value]) => ({ ...value, engine })),
      ...Object.values(conversation.modelSessions || {}), ...(conversation.retiredSegments || []),
    ]) {
      owners.push({ engine: segment.engine, runtimeId: conversation.id, nativeId: segment.nativeId,
        ownerId: 'conversation/' + conversation.id });
    }
    // A newly created ordinary conversation may not have a native segment yet.
    if (conversation.currentEngine) owners.push({ engine: conversation.currentEngine, runtimeId: conversation.id,
      ownerId: 'conversation/' + conversation.id });
  }
  for (const row of external) owners.push({ engine: row.engine, nativeId: row.nativeId, runtimeId: row.runtimeId,
    ...(row.nativeStorage ? { nativeStorage: row.nativeStorage } : {}),
    ownerId: 'external/' + nativeKey(row.engine, row.nativeId || row.runtimeId) });
  return validateNativeOwners(owners);
}

// Synchronous claims close the await gaps between preparation, opening and
// dispatch. Released claims are retained as ownership tombstones; stopping a
// process does not make its history available to another member or generation.
// This is an application boundary, not an OS lock against another CLI process.
class NativeSessionOwnership {
  constructor({ readOwners }) {
    if (typeof readOwners !== 'function') throw new Error('Native ownership inventory is required');
    this.readOwners = readOwners;
    this.leases = new Map(); this.active = new Map();
    this.runtimes = new Map(); this.natives = new Map(); this.storages = new Map();
  }
  snapshot() {
    const owners = this.readOwners();
    if (owners && typeof owners.then === 'function') {
      Promise.resolve(owners).catch(() => {});
      throw new Error('Native ownership inventory must be synchronous');
    }
    return structuredClone(validateNativeOwners(owners));
  }
  check(record, owners, nativeId = record.nativeId) {
    const runtimeClaim = this.runtimes.get(runtimeKey(record.runtimeId));
    if (runtimeClaim && (runtimeClaim.ownerId !== record.ownerId || runtimeClaim.engine !== record.engine)) throw new Error('Native runtime belongs to another owner');
    if (runtimeClaim?.nativeId && !sameStoredId(runtimeClaim.nativeId, nativeId)) throw new Error('Native runtime continuation must retain its native ID');
    const nativeClaim = nativeId && this.natives.get(nativeKey(record.engine, nativeId));
    if (nativeClaim && nativeClaim !== record.ownerId) throw new Error('Native session belongs to another owner');
    let storage = record.nativeStorage || runtimeClaim?.nativeStorage || null;
    for (const owner of owners) if (owner.engine === record.engine && sameStoredId(owner.nativeId, nativeId) && owner.nativeStorage) {
      if (storage && !sameStorage(storage, owner.nativeStorage)) throw new Error('Native storage mapping changed ownership');
      storage = owner.nativeStorage;
    }
    if (storage) {
      const key = storageKey(storage), claimed = this.storages.get(key);
      if (claimed && claimed !== record.ownerId || record.preexistingStorage?.has(key)) throw new Error('Native storage belongs to another owner');
      if (owners.some(owner => owner.engine === record.engine && sameStorage(owner.nativeStorage, storage)
        && (owner.ownerId !== record.ownerId || owner.retired === true))) throw new Error('Native storage belongs to another or retired owner');
    }
    for (const owner of owners) {
      if (sameStoredId(owner.runtimeId, record.runtimeId) || owner.engine === record.engine && sameStoredId(owner.nativeId, nativeId)) {
        if (owner.ownerId !== record.ownerId || owner.retired === true) throw new Error('Native session belongs to another or retired owner');
        if (owner.engine !== record.engine || !sameStoredId(owner.runtimeId, record.runtimeId)) throw new Error('Native ownership identity mismatch');
        if (owner.nativeId && !sameStoredId(owner.nativeId, nativeId)) throw new Error('Native runtime continuation must retain its native ID');
      }
    }
    return storage;
  }
  reserve(input) {
    if (!input || !ENGINES.has(input.engine)
      || ['discussionId', 'participantId', 'runtimeId'].some(key => !UUID.test(input[key]))
      || !Number.isSafeInteger(input.generation) || input.generation < 1
      || input.nativeId != null && !validSessionId(input.nativeId)) throw new Error('Invalid native ownership identity');
    if (this.active.has(runtimeKey(input.runtimeId))) throw new Error('Native runtime is already reserved');
    const record = { engine: input.engine, runtimeId: input.runtimeId, nativeId: input.nativeId || null,
      ownerId: discussionOwner(input), processGeneration: this.runtimes.get(runtimeKey(input.runtimeId))?.processGeneration || 0 };
    const owners = this.snapshot(); const storage = this.check(record, owners);
    if (record.nativeId && this.natives.get(nativeKey(record.engine, record.nativeId)) !== record.ownerId
      && !owners.some(owner => owner.engine === record.engine && sameStoredId(owner.nativeId, record.nativeId)
        && owner.ownerId === record.ownerId && owner.retired !== true)) {
      throw new Error('Native continuation has no verified owner');
    }
    // A native thread can appear in the driver's mirror during open(), before
    // the discussion records it. A live scoped handle can explain that new
    // file, but can never erase a foreign owner observed before this launch.
    record.preexistingNatives = new Set(); record.preexistingStorage = new Set(); rememberForeignNatives(record, owners);
    if (storage) { record.nativeStorage = nativeStorage(storage); this.storages.set(storageKey(storage), record.ownerId); }
    const lease = Object.freeze({});
    this.leases.set(lease, record); this.active.set(runtimeKey(record.runtimeId), lease);
    this.runtimes.set(runtimeKey(record.runtimeId), record);
    if (record.nativeId) this.natives.set(nativeKey(record.engine, record.nativeId), record.ownerId);
    return lease;
  }
  record(lease) {
    const record = this.leases.get(lease);
    if (!record || this.active.get(runtimeKey(record.runtimeId)) !== lease) throw new Error('Native ownership lease is not active');
    return record;
  }
  assert(lease) {
    const record = this.record(lease), owners = this.snapshot();
    // Preparation can await while another native history appears. Preserve
    // every foreign ID seen before open(), even if its file later disappears
    // or the newly opened scoped handle reports that same ID.
    rememberForeignNatives(record, owners); this.check(record, owners);
    if (record.storageRequired && !owners.some(owner => owner.engine === record.engine && sameStoredId(owner.nativeId, record.nativeId)
      && owner.storageVerified === true && sameStorage(owner.nativeStorage, record.nativeStorage))) throw new Error('Current native storage mapping is unavailable');
  }
  claimNative(lease, nativeId) {
    if (!validSessionId(nativeId)) throw new Error('Invalid native session ID');
    const record = this.record(lease);
    if (record.nativeId && !sameStoredId(record.nativeId, nativeId)) throw new Error('Native continuation changed ownership');
    if (record.preexistingNatives.has(nativeKey(record.engine, nativeId))) throw new Error('Native session belonged to another owner before launch');
    const owners = this.snapshot(), storage = this.check(record, owners, nativeId);
    if (record.engine === 'antigravity' && (!storage || !owners.some(owner => owner.engine === record.engine
      && sameStoredId(owner.nativeId, nativeId) && owner.storageVerified === true && sameStorage(owner.nativeStorage, storage)))) {
      throw new Error('Verified native storage is required before discussion input');
    }
    if (storage) { record.nativeStorage = nativeStorage(storage); this.storages.set(storageKey(storage), record.ownerId); record.storageRequired = true; }
    this.natives.set(nativeKey(record.engine, nativeId), record.ownerId); record.nativeId = nativeId;
    return storage ? nativeStorage(storage) : undefined;
  }
  claimProcess(lease, generation) {
    const record = this.record(lease);
    if (!Number.isSafeInteger(generation) || generation <= record.processGeneration) throw new Error('Native process generation was reused');
    record.processGeneration = generation;
  }
  release(lease) {
    const record = this.record(lease);
    this.active.delete(runtimeKey(record.runtimeId)); this.leases.delete(lease); delete record.preexistingNatives; delete record.preexistingStorage;
  }
  listClaims() {
    return [...this.runtimes.values()].map(({ engine, runtimeId, nativeId, ownerId, nativeStorage: storage }) => ({ engine, runtimeId, nativeId, ownerId,
      ...(storage ? { nativeStorage: nativeStorage(storage) } : {}) }));
  }
  assertOrdinary({ engine, runtimeId, nativeId }) {
    const owners = [...this.snapshot(), ...this.runtimes.values()];
    const storage = owners.find(owner => owner.engine === engine && sameStoredId(owner.nativeId, nativeId) && owner.storageVerified)?.nativeStorage;
    if (owners.some(owner => owner.ownerId.startsWith('discussion/')
      && (sameStoredId(owner.runtimeId, runtimeId) || owner.engine === engine && (sameStoredId(owner.nativeId, nativeId) || sameStorage(owner.nativeStorage, storage))))) {
      throw new Error('Native session is owned by a discussion');
    }
  }
}

module.exports = { NativeSessionOwnership, collectNativeOwners, sameStoredId, validateNativeOwners };
