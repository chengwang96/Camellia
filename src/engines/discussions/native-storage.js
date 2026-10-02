'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SDK_ID = /^[0-9a-f]{32}$/;
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const idKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

function nativeStorage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['connection', 'storageDir', 'conversationId'].includes(key))
    || !['api', 'subscription'].includes(value.connection)
    || typeof value.storageDir !== 'string' || value.storageDir.length > 8192 || value.storageDir.includes('\0') || !path.isAbsolute(value.storageDir)
    || typeof value.conversationId !== 'string' || !(value.connection === 'api' ? SDK_ID : UUID).test(value.conversationId)) {
    throw new Error('Invalid native storage identity');
  }
  return { connection: value.connection, storageDir: path.resolve(value.storageDir), conversationId: value.conversationId };
}
function storageKey(value) {
  const storage = nativeStorage(value);
  return JSON.stringify([storage.connection, pathKey(storage.storageDir), storage.conversationId]);
}
const sameStorage = (a, b) => Boolean(a && b) && storageKey(a) === storageKey(b);

// Project trusted raw topology onto logical owners without erasing unmanaged
// bridge aliases or orphan storage. Never infer an owner from a file name alone.
// Saved identities remain reserved when the bridge is absent; only a current
// mapping backed by a checked database supplies storageVerified for admission.
function projectAntigravityStorage(owners, topology, maxEntries = 100000) {
  if (topology && typeof topology.then === 'function') {
    Promise.resolve(topology).catch(() => {}); throw new Error('Native storage topology must be synchronous');
  }
  if (!Array.isArray(owners) || !Number.isSafeInteger(maxEntries) || maxEntries < 1
    || !topology || !Array.isArray(topology.bridges) || !Array.isArray(topology.histories)
    || owners.length + topology.bridges.length + topology.histories.length > maxEntries) throw new Error('Invalid or oversized native storage topology');
  const result = owners.map(row => ({ ...row, ...(row.engine === 'antigravity' ? { storageVerified: false } : {}) }));
  const byNative = new Map();
  for (const row of result) if (row.engine === 'antigravity' && row.nativeId) {
    const id = idKey(row.nativeId); if (!byNative.has(id)) byNative.set(id, []); byNative.get(id).push(row);
  }
  const bridges = new Set();
  for (const bridge of topology.bridges) {
    if (!bridge || typeof bridge.nativeId !== 'string'
      || bridge.databaseVerified !== undefined && typeof bridge.databaseVerified !== 'boolean'
      || bridge.databaseVerified === true && bridge.conversationId === null
      || !(bridge.connection === 'api' ? UUID.test(bridge.nativeId) : bridge.connection === 'subscription' && bridge.nativeId.startsWith('agy-') && UUID.test(bridge.nativeId.slice(4)))) {
      throw new Error('Invalid native storage bridge');
    }
    const id = idKey(bridge.nativeId);
    if (bridges.has(id)) throw new Error('Ambiguous native storage bridge');
    bridges.add(id);
    // Validate the scope even while a bridge has not allocated a native ID.
    const scope = nativeStorage({ connection: bridge.connection, storageDir: bridge.storageDir,
      conversationId: bridge.conversationId === null ? bridge.connection === 'api' ? '0'.repeat(32) : '00000000-0000-0000-0000-000000000000' : bridge.conversationId });
    const observed = bridge.conversationId === null ? null : scope;
    let rows = byNative.get(id);
    if (!rows) {
      rows = [{ engine: 'antigravity', nativeId: bridge.nativeId, ownerId: 'external/antigravity-bridge/' + id }];
      byNative.set(id, rows); result.push(...rows);
    }
    for (const row of rows) {
      if (row.nativeStorage && observed && !sameStorage(row.nativeStorage, observed)) throw new Error('Native storage mapping changed ownership');
      if (observed) { row.nativeStorage = { ...observed }; row.storageVerified = bridge.databaseVerified === true; }
    }
  }
  const attributed = new Set(result.filter(row => row.engine === 'antigravity' && row.nativeStorage).map(row => storageKey(row.nativeStorage)));
  for (const history of topology.histories) {
    const storage = nativeStorage(history), key = storageKey(storage);
    if (attributed.has(key)) continue;
    attributed.add(key);
    const id = 'agy-storage-' + createHash('sha256').update(key).digest('hex');
    result.push({ engine: 'antigravity', nativeId: id, nativeStorage: storage, storageVerified: false, ownerId: 'external/' + id });
  }
  if (result.length > maxEntries) throw new Error('Native storage topology exceeds its owner limit');
  return result;
}

module.exports = { nativeStorage, storageKey, sameStorage, projectAntigravityStorage };
