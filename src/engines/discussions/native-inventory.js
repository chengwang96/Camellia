'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validSessionId } = require('../claude-history');
const { readJson } = require('../../shared/json-store');
const { readDiscussionRecords } = require('./store');
const { collectNativeOwners, sameStoredId, validateNativeOwners } = require('./native-ownership');
const { getDiscussionLaunch } = require('./native-launch');
const { readJobJournalRecords } = require('./windows-job-journal');
const { projectAntigravityStorage } = require('./native-storage');

const ENGINES = new Set(['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi']);
const object = value => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  // Main-process hosts can run in a separate VM realm. Compare the native
  // Object constructor, not its realm-specific prototype identity; Maps and
  // class instances still cannot masquerade as persisted record dictionaries.
  return prototype === null || Object.hasOwn(prototype, 'constructor')
    && typeof prototype.constructor === 'function'
    && Function.prototype.toString.call(prototype.constructor) === Function.prototype.toString.call(Object);
};
const key = (engine, id) => JSON.stringify([engine, process.platform === 'win32' ? id.toLowerCase() : id]);
function synchronous(value, label) {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    throw new Error(label + ' must be synchronous');
  }
  return value;
}
function conversationRecord(record) {
  if (!object(record) || !validSessionId(record.id) || !ENGINES.has(record.origin)
    || !ENGINES.has(record.currentEngine) || !object(record.segments)
    || record.modelSessions !== undefined && !object(record.modelSessions)
    || record.retiredSegments !== undefined && !Array.isArray(record.retiredSegments)) {
    throw new Error('Invalid conversation ownership index');
  }
  const segments = [...Object.entries(record.segments).map(([engine, segment]) => ({ engine, segment })),
    ...Object.values(record.modelSessions || {}).map(segment => ({ engine: segment?.engine, segment })),
    ...(record.retiredSegments || []).map(segment => ({ engine: segment?.engine, segment }))];
  if (segments.some(({ engine, segment }) => !ENGINES.has(engine) || !object(segment)
    || segment.engine !== undefined && segment.engine !== engine
    || segment.nativeId != null && !validSessionId(segment.nativeId))) throw new Error('Invalid conversation native ownership');
  return record;
}

// A bounded, synchronous admission scan. No history content, account secret,
// runtime process or inference is needed to enumerate mirrored native IDs.
class InventoryScan {
  constructor({ maxEntries = 100000, maxBytes = 64 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid inventory bounds');
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.entriesRead = 0; this.bytesRead = 0; this.checked = new Map();
  }
  stat(file) {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error('Linked ownership paths cannot be verified');
    return stat || null;
  }
  entries(dir) {
    const stat = this.stat(dir); this.checked.set(dir, stat);
    if (!stat) return [];
    if (!stat.isDirectory()) throw new Error('Invalid ownership directory');
    const names = fs.readdirSync(dir);
    this.entriesRead += names.length;
    if (this.entriesRead > this.maxEntries) throw new Error('Native ownership inventory exceeds its entry limit');
    return names;
  }
  json(file) {
    const stat = this.stat(file);
    if (!stat?.isFile()) throw new Error('Missing ownership record');
    this.bytesRead += stat.size;
    if (stat.size > 32 * 1024 * 1024 || this.bytesRead > this.maxBytes) throw new Error('Native ownership inventory exceeds its byte limit');
    this.checked.set(file, stat);
    return readJson(file, null);
  }
  conversations(dir) {
    return this.entries(dir).filter(name => /\.json$/i.test(name)).map(name => {
      const record = conversationRecord(this.json(path.join(dir, name)));
      if (!sameStoredId(record.id, name.slice(0, -5))) throw new Error('Conversation ownership filename mismatch');
      return record;
    });
  }
  history(engine, root) {
    if (!ENGINES.has(engine) || typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Invalid native history source');
    const rows = [];
    for (const folder of this.entries(root)) {
      const dir = path.join(root, folder), stat = this.stat(dir);
      if (!stat?.isDirectory()) continue;
      for (const name of this.entries(dir).filter(name => /\.jsonl$/i.test(name))) {
        const nativeId = name.slice(0, -6), file = path.join(dir, name), info = this.stat(file);
        if (!validSessionId(nativeId) || !info?.isFile()) throw new Error('Invalid native history ownership record');
        rows.push({ engine, nativeId });
      }
    }
    return rows;
  }
  verify() {
    for (const [file, before] of this.checked) {
      const after = this.stat(file);
      if (!before && !after) continue;
      if (!before || !after || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Native ownership sources changed during inventory');
    }
  }
}

// Complete application records are combined with a trusted, explicitly complete
// external native inventory. Missing raw CLI/account coverage fails closed; the
// app's transcript mirrors alone cannot prove native storage has been covered.
class NativeOwnershipInventory {
  constructor({ dataDir, drivers, conversations, claims = () => [], external, managedNative, limits }) {
    if (!path.isAbsolute(dataDir) || !object(drivers) || typeof conversations !== 'function'
      || typeof claims !== 'function') throw new Error('Native ownership sources are required');
    Object.assign(this, { dataDir, drivers, conversations, claims, external, managedNative, limits });
  }
  read() {
    const scan = new InventoryScan(this.limits);
    const discussionDir = path.join(this.dataDir, 'discussions');
    // Register discussion files with this scan as well, so synchronous source
    // callbacks cannot replace them unnoticed while building the final view.
    for (const name of scan.entries(discussionDir).filter(name => /\.json$/i.test(name))) scan.json(path.join(discussionDir, name));
    const discussions = readDiscussionRecords(discussionDir);
    const memory = synchronous(this.conversations(), 'Conversation ownership source');
    if (!Array.isArray(memory)) throw new Error('Conversation ownership source is not ready');
    const conversations = [...scan.conversations(path.join(this.dataDir, 'conversations')), ...memory.map(conversationRecord)];
    const claims = synchronous(this.claims(), 'Native ownership claims');
    const owners = [...collectNativeOwners({ discussions, conversations }), ...structuredClone(validateNativeOwners(claims))];
    const journalDir = path.join(discussionDir, 'windows-jobs');
    for (const name of scan.entries(journalDir)) {
      const dir = path.join(journalDir, name); scan.entries(dir); scan.json(path.join(dir, 'record.json'));
    }
    for (const identity of readJobJournalRecords(journalDir)) {
      const deliveries = discussions.flatMap(group => group.deliveries
        .filter(delivery => sameStoredId(delivery.id, identity.deliveryId) && sameStoredId(delivery.runtimeId, identity.runtimeId)
          && delivery.generation === identity.generation)
        .map(delivery => `discussion/${group.id.toLowerCase()}/${delivery.participantId.toLowerCase()}/${identity.generation}`));
      const recorded = owners.filter(owner => deliveries.length === 1 && owner.ownerId === deliveries[0]
        && sameStoredId(owner.runtimeId, identity.runtimeId));
      if (!recorded.length) {
        // An orphan launch record names no trusted engine or participant. Keep
        // its runtime reserved for every engine until controlled recovery has
        // restored that association; never guess an owner from an absent PID.
        owners.push(...[...ENGINES].map(engine => ({ engine, runtimeId: identity.runtimeId,
          ownerId: 'external/windows-job/' + identity.deliveryId })));
      }
    }
    const histories = [];
    for (const [engine, driver] of Object.entries(this.drivers)) {
      if (!ENGINES.has(engine) || !(driver.sessions?.sessions instanceof Map) || !driver.history) throw new Error('Invalid native driver inventory');
      histories.push(...scan.history(engine, driver.history.root));
      for (const [runtimeId, session] of driver.sessions.sessions) {
        const nativeIds = [...new Set([session.sessionId, session.opts?.sessionId].filter(value => value != null))];
        if (nativeIds.some(id => !validSessionId(id))) throw new Error('Invalid live native ownership');
        if (session.opts?.discussionLaunch) {
          const scope = getDiscussionLaunch(session.opts, engine);
          if (!sameStoredId(runtimeId, scope.runtimeId)) throw new Error('Discussion pool identity mismatch');
          const attributed = owners.filter(owner => owner.engine === engine && sameStoredId(owner.runtimeId, runtimeId));
          if (!attributed.length || new Set(attributed.map(row => row.ownerId)).size !== 1
            || !attributed[0].ownerId.startsWith('discussion/')) throw new Error('Discussion process has no unique recorded owner');
          for (const nativeId of nativeIds) owners.push({ ...attributed[0], nativeId,
            retired: attributed.some(owner => owner.retired === true) });
        } else {
          if (runtimeId !== 'legacy' && (!validSessionId(runtimeId) || !sameStoredId(runtimeId, session.opts?.conversationId))) throw new Error('Ordinary pool identity mismatch');
          const logical = runtimeId !== 'legacy' && conversations.some(record => sameStoredId(record.id, runtimeId));
          for (const nativeId of nativeIds.length ? nativeIds : [null]) owners.push({ engine, nativeId, runtimeId,
            ownerId: logical ? 'conversation/' + runtimeId : 'external/' + JSON.stringify([engine, runtimeId, nativeId]) });
        }
      }
    }
    // A policy restricted to application-created homes cannot import arbitrary
    // external threads. Its explicitly scoped native scan is sufficient for the
    // frozen v1; it does not claim that every external CLI has been inventoried.
    const external = synchronous(this.managedNative ? this.managedNative() : this.external?.(), 'Native ownership source');
    if (!external || (this.managedNative ? external.scope !== 'managed-discussion-homes' : external.complete !== true)
      || !Array.isArray(external.histories) || !Array.isArray(external.activities)) {
      throw new Error('Complete external native ownership coverage is not available');
    }
    owners.push(...collectNativeOwners({ external: external.activities }));
    histories.push(...external.histories);
    if (owners.length + histories.length > scan.maxEntries) throw new Error('Native ownership inventory exceeds its owner limit');
    const attributed = new Set(owners.filter(owner => owner.nativeId).map(owner => key(owner.engine, owner.nativeId)));
    for (const row of histories) {
      if (!row || !ENGINES.has(row.engine) || !validSessionId(row.nativeId)) throw new Error('Invalid external native history inventory');
      if (!attributed.has(key(row.engine, row.nativeId))) owners.push(...collectNativeOwners({ external: [row] }));
    }
    scan.verify();
    const projected = external.antigravity === undefined ? owners : projectAntigravityStorage(owners, external.antigravity, scan.maxEntries);
    return structuredClone(validateNativeOwners(projected));
  }
}

module.exports = { NativeOwnershipInventory };
