'use strict';

const { readJson, writeJson } = require('../../shared/json-store');
const { fail } = require('./access');

// The receipt survives relaunch. Repeating an acknowledged request, including
// after reconnecting to the new process, must never restart the desktop twice.
function createDesktopRestart({ file, prepare = async () => {}, restart, schedule = setTimeout, log = () => {} }) {
  const receipts = readJson(file, []).slice(-1000);
  let pending = null;
  const result = (entry, instanceId) => ({ ok: true, requestId: entry.requestId,
    instanceId: entry.instanceId, state: entry.state === 'failed' ? 'failed' : entry.instanceId === instanceId ? 'accepted' : 'complete',
    ...(entry.error ? { error: entry.error } : {}) });
  return {
    async submit(deviceId, payload, instanceId, validate = () => {}) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).some(key => !['requestId', 'instanceId', 'confirmed'].includes(key))
          || !/^[a-f0-9-]{36}$/.test(payload.requestId || '') || typeof payload.instanceId !== 'string'
          || payload.confirmed !== true) fail(400, 'Confirm restarting desktop Camellia');
      const prior = receipts.find(entry => entry.deviceId === deviceId && entry.requestId === payload.requestId);
      if (prior) {
        if (prior.instanceId !== payload.instanceId) fail(409, 'Restart request ID already used');
        return result(prior, instanceId);
      }
      if (payload.instanceId !== instanceId) fail(409, 'Desktop restarted; refresh its status before choosing again');
      if (pending) {
        if (pending.deviceId === deviceId && pending.requestId === payload.requestId) return pending.ready;
        fail(409, 'Desktop restart already requested');
      }
      const entry = { deviceId, requestId: payload.requestId, instanceId, state: 'accepted' };
      pending = entry;
      entry.ready = Promise.resolve().then(prepare).then(() => {
        validate();
        const saved = { deviceId, requestId: entry.requestId, instanceId, state: 'accepted' };
        writeJson(file, [...receipts, saved].slice(-1000));
        receipts.push(saved);
        if (receipts.length > 1000) receipts.shift();
        return result(saved, instanceId);
      }).catch(error => { pending = null; throw error; });
      return entry.ready;
    },
    afterReply(deviceId, requestId) {
      const entry = pending;
      if (!entry || entry.deviceId !== deviceId || entry.requestId !== requestId || entry.scheduled) return;
      entry.scheduled = true;
      // Start only after the HTTP reply has been written, allowing the tunnel
      // to deliver it before normal application shutdown closes the gateway.
      schedule(() => {
        void Promise.resolve().then(restart).catch(error => {
          const saved = receipts.find(item => item.deviceId === deviceId && item.requestId === requestId);
          saved.state = 'failed'; saved.error = 'Desktop could not restart. Check desktop settings and try again.';
          try { writeJson(file, receipts.slice(-1000)); } catch (saveError) { log(saveError.message); }
          pending = null;
          log('Remote desktop restart failed: ' + error.message);
        });
      }, 1000)?.unref?.();
    },
  };
}

module.exports = { createDesktopRestart };
