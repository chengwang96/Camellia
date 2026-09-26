'use strict';

const { randomUUID } = require('node:crypto');
const { exportProviders } = require('./api-import');

function createApiImportClient({ client, source, now = Date.now }) {
  const pending = new Map();
  function prune() { for (const [id, entry] of pending) if (entry.expiresAt <= now()) pending.delete(id); }
  return {
    async prepare(deviceId) {
      prune();
      if (pending.size >= 8) throw new Error('Cancel an API import before preparing another');
      const device = client.list().find(entry => entry.id === deviceId);
      if (!device) throw new Error('CLI device not found');
      const { providers, skipped } = exportProviders(source());
      const state = await client.json(deviceId, '/v1/api-import');
      if (!/^[a-f0-9]{64}$/.test(state.revision) || state.policy !== 'keep-server') throw new Error('Server does not support safe API import');
      const id = randomUUID();
      const summary = { id, target: device.name, providers: providers.length, keys: providers.reduce((total, provider) => total + provider.keys.length, 0), skipped, policy: 'keep-server' };
      pending.set(id, { deviceId, summary, expiresAt: now() + 5 * 60_000, payload: { requestId: randomUUID(), expectedRevision: state.revision, providers } });
      return summary;
    },
    async apply(deviceId, id) {
      prune();
      const entry = pending.get(id);
      if (!entry || entry.deviceId !== deviceId) throw new Error('API import preview expired or target changed; prepare again');
      if (entry.busy) throw new Error('API import is already in progress');
      entry.busy = true;
      try {
        const result = await client.json(deviceId, '/v1/api-import', { method: 'POST', body: entry.payload });
        if (!result || typeof result.ok !== 'boolean' || !['accepted', 'failed', 'unknown'].includes(result.state)) throw new Error('Invalid API import receipt');
        const receipt = { ok: result.ok, state: result.state };
        for (const key of ['added', 'keys', 'skipped']) if (Number.isSafeInteger(result[key]) && result[key] >= 0) receipt[key] = result[key];
        if (typeof result.enabled === 'boolean') receipt.enabled = result.enabled;
        if (result.ok || result.state === 'failed') pending.delete(id);
        return receipt;
      } finally { entry.busy = false; }
    },
    cancel(id) { pending.delete(id); },
    clear() { pending.clear(); },
  };
}

module.exports = { createApiImportClient };
