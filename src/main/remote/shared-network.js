'use strict';

const { EmbeddedNetwork } = require('./embedded-network');

// One embedded Tailscale node per desktop app: Mobile access (inbound) and CLI
// devices (outbound) share the same login, node name and encrypted state. The
// helper supports listening and dialing on one node, so a failure or sign-out
// must be reported to every consumer.
function createSharedNetwork({ options, create = value => new EmbeddedNetwork(value) }) {
  const listeners = new Set();
  const network = create({ ...options, onFailure: () => { for (const listener of [...listeners]) { try { listener(); } catch { /* consumer is closing */ } } } });
  return {
    network,
    factory: ({ onFailure = () => {} } = {}) => { listeners.add(onFailure); return network; },
    listenerCount: () => listeners.size,
  };
}

module.exports = { createSharedNetwork };
