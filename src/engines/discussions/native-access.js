'use strict';

const path = require('node:path');
const { readDiscussionRecords } = require('./store');
const { collectNativeOwners, sameStoredId } = require('./native-ownership');
const { getDiscussionLaunch } = require('./native-launch');
const { readJobJournalRecords } = require('./windows-job-journal');
const { projectAntigravityStorage, sameStorage } = require('./native-storage');

// Reverse admission only. This does not supply the complete ordinary/external
// inventory required to authorize a discussion launch. Installing it neither
// registers a discussion adapter nor opens a production connection.
function installDiscussionGuards({ dataDir, drivers, ownership, nativeStorage, ordinaryNativeSeparate }) {
  const dir = path.join(dataDir, 'discussions');
  const snapshot = () => {
    const discussions = readDiscussionRecords(dir);
    const owners = collectNativeOwners({ discussions });
    for (const journalKind of ['windows-jobs', 'unix-jobs']) owners.push(...readJobJournalRecords(path.join(dir, journalKind)));
    if (ownership) owners.push(...ownership.listClaims());
    for (const [engine, driver] of Object.entries(drivers)) {
      for (const session of driver.sessions.sessions.values()) {
        if (!session.opts?.discussionLaunch) continue;
        const scope = getDiscussionLaunch(session.opts, engine);
        owners.push({ engine, runtimeId: scope.runtimeId, nativeId: session.sessionId || scope.nativeId });
      }
    }
    return { discussions, owners };
  };
  const assertOrdinary = (engine, opts = {}) => {
    const { discussions, owners } = snapshot();
    if (discussions.some(group => sameStoredId(group.id, opts.conversationId))
      || owners.some(owner => sameStoredId(owner.runtimeId, opts.conversationId)
        || owner.engine === engine && sameStoredId(owner.nativeId, opts.sessionId))) {
      throw new Error('Native session is owned by a discussion');
    }
    const protectedStorage = owners.filter(owner => owner.engine === 'antigravity' && owner.nativeId);
    if (engine === 'antigravity' && opts.sessionId && protectedStorage.length) {
      // Discussion CLI and SDK sessions own separate, fixed save directories.
      // A main-process path proof can exclude that namespace without scanning
      // every unrelated CLI index/version. Unknown or aliased paths still use
      // the existing conservative topology check below.
      if (ordinaryNativeSeparate?.({ nativeId: opts.sessionId, owners: protectedStorage }) === true) return;
      const topology = nativeStorage?.();
      if (topology && typeof topology.then === 'function') {
        Promise.resolve(topology).catch(() => {}); throw new Error('Native storage coverage must be synchronous');
      }
      if (!topology) throw new Error('Native storage coverage is required to exclude discussion aliases');
      const projected = projectAntigravityStorage(protectedStorage.map(owner => ({ ...owner,
        ownerId: owner.ownerId || 'discussion/protected/' + owner.runtimeId })), topology);
      const candidate = projected.find(owner => sameStoredId(owner.nativeId, opts.sessionId) && owner.storageVerified);
      if (!candidate) throw new Error('Current native storage mapping is unavailable');
      if (projected.some(owner => owner.ownerId.startsWith('discussion/') && sameStorage(owner.nativeStorage, candidate.nativeStorage))) {
        throw new Error('Native storage is owned by a discussion');
      }
    }
  };
  for (const [engine, driver] of Object.entries(drivers)) {
    driver.sessions.setAccessGuard(opts => {
      // Only the exact internal launch capability can take the discussion path.
      // A serialized flag, an unsupported engine or an expired token fails here.
      if (getDiscussionLaunch(opts, engine)) return;
      assertOrdinary(engine, opts);
    });
    if (driver.history?.remove) {
      const remove = driver.history.remove.bind(driver.history);
      driver.history.remove = id => { assertOrdinary(engine, { sessionId: id }); return remove(id); };
    }
  }
  return Object.freeze({ assertOrdinary });
}

module.exports = { installDiscussionGuards };
