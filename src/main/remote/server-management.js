'use strict';

const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');
const { fail } = require('./access');

const ACTIONS = new Set(['settings', 'runtime-state', 'runtime-install', 'runtime-check', 'runtime-update', 'runtime-uninstall', 'engine-settings', 'usage', 'storage-scan', 'storage-clean']);
const READS = new Set(['settings', 'runtime-state', 'runtime-check', 'usage', 'storage-scan']);

function createServerManagement({ file, command, publish = () => {} }) {
  const jobs = readJson(file, []).slice(-1000);
  const reads = new Map();
  let busy = false;
  const save = () => writeJson(file, jobs);
  function get(deviceId, id) {
    const job = reads.get(deviceId + ':' + id) || jobs.find(entry => entry.deviceId === deviceId && entry.id === id);
    if (!job) fail(404, 'Server operation not found');
    return { id: job.id, state: job.state, result: job.result, error: job.error };
  }
  for (const job of jobs) if (job.state === 'running') { job.state = 'unknown'; job.error = 'Server restarted during this operation. Check its state before retrying.'; }
  return {
    get,
    submit(deviceId, request) {
      if (!request || !ACTIONS.has(request.action) || !/^[a-f0-9-]{36}$/.test(request.requestId || '') || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)
        || Object.keys(request).some(key => !['action', 'payload', 'requestId'].includes(key))) fail(400, 'Invalid server management request');
      const fields = { 'runtime-install': ['engine', 'connection', 'confirmed'], 'runtime-update': ['engine', 'connection', 'confirmed'], 'runtime-uninstall': ['engine', 'connection', 'confirmed'], 'engine-settings': ['engine', 'connection', 'model', 'permissionMode', 'thinkingBudget'], 'storage-clean': ['token', 'confirmed'] };
      if (Object.keys(request.payload).some(key => !(fields[request.action] || []).includes(key))) fail(400, 'Unsupported management field');
      if (['runtime-install', 'runtime-update', 'runtime-uninstall', 'storage-clean'].includes(request.action) && request.payload.confirmed !== true) fail(400, 'Explicit confirmation required');
      const fingerprint = createHash('sha256').update(JSON.stringify([request.action, request.payload])).digest('hex');
      const prior = reads.get(deviceId + ':' + request.requestId) || jobs.find(entry => entry.deviceId === deviceId && entry.id === request.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, 'Operation ID already used');
        return get(deviceId, prior.id);
      }
      if (busy) fail(409, 'Wait for the current server settings operation');
      const reading = READS.has(request.action);
      if (!reading && jobs.length >= 1000) fail(409, 'Server operation journal is full');
      const job = { deviceId, id: request.requestId, fingerprint, state: 'running' };
      if (reading) {
        if (reads.size >= 128) reads.delete(reads.keys().next().value);
        reads.set(deviceId + ':' + job.id, job);
      } else {
        jobs.push(job);
        try { save(); } catch (error) { jobs.pop(); throw error; }
      }
      busy = true;
      void Promise.resolve().then(() => command(request.action, request.payload)).then(reply => {
        if (!reply.ok) throw new Error(reply.error || 'Server operation failed');
        job.result = reply.result; job.state = 'complete';
      }).catch(error => { job.state = 'failed'; job.error = String(error.message).slice(0, 300); }).finally(() => {
        busy = false;
        try { if (!reading) save(); } catch { job.state = 'unknown'; job.error = 'Could not save operation result. Verify server state before retrying.'; }
        publish();
      });
      return get(deviceId, job.id);
    },
  };
}

module.exports = { createServerManagement, ACTIONS };
