'use strict';

const { NativeOwnershipInventory } = require('./native-inventory');
const { NativeSessionOwnership } = require('./native-ownership');
const { DiscussionAdapterRegistry } = require('./adapter-registry');
const { installDiscussionGuards } = require('./native-access');

// Main-process composition only. Ordinary reverse protection is usable before
// raw native coverage is ready. Forward admission requires that complete source
// plus a separately registered, reviewed adapter; the registry starts empty.
function createDiscussionBoundary({ dataDir, drivers, conversations, external, managedNative, nativeStorage, ordinaryNativeSeparate, limits }) {
  const inventory = new NativeOwnershipInventory({ dataDir, drivers, conversations, external, managedNative, limits,
    claims: () => ownership.listClaims() });
  const ownership = new NativeSessionOwnership({ readOwners: () => inventory.read() });
  const registry = new DiscussionAdapterRegistry({ ownership });
  installDiscussionGuards({ dataDir, drivers, ownership, nativeStorage, ordinaryNativeSeparate });
  return Object.freeze({ ownership, inventory, registry });
}

module.exports = { createDiscussionBoundary };
