'use strict';

const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');
const routerConfig = require('../../api/api-router-config');
const { fail } = require('./access');

const PROVIDER = ['id', 'type', 'name', 'enabled', 'priority', 'protocol', 'baseUrl', 'anthropicBaseUrl', 'models', 'keys'];
const MODEL = ['id', 'upstream', 'protocol', 'contextWindow', 'maxContext'];
const KEY = ['id', 'key', 'name', 'enabled'];
const pick = (value, fields) => Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
function shape(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail(400, 'Invalid API import schema');
}
function remoteEndpoint(value) {
  const endpoint = routerConfig.endpoint(value);
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(400, 'Local API endpoints cannot be transferred to another device');
  return endpoint;
}
function validateProviders(providers) {
  if (!Array.isArray(providers) || !providers.length || providers.length > 100 || Buffer.byteLength(JSON.stringify(providers)) > 1024 * 1024) fail(400, 'Invalid API import size');
  try {
    for (const provider of providers) {
      shape(provider, PROVIDER);
      if (!identifier(provider.id) || typeof provider.type !== 'string' || provider.type === 'qclaw' || !Array.isArray(provider.models) || !Array.isArray(provider.keys)
        || provider.models.length > 200 || provider.keys.length > 100) fail(400, 'Invalid API provider');
      if (provider.enabled !== undefined && typeof provider.enabled !== 'boolean') fail(400, 'Invalid provider enabled state');
      remoteEndpoint(provider.baseUrl);
      if (provider.anthropicBaseUrl) remoteEndpoint(provider.anthropicBaseUrl);
      for (const model of provider.models) shape(model, MODEL);
      for (const key of provider.keys) {
        shape(key, KEY);
        if (key.enabled !== undefined && typeof key.enabled !== 'boolean') fail(400, 'Invalid key enabled state');
        if (!identifier(key.id) || typeof key.key !== 'string' || !key.key.trim() || key.key.length > 8192 || /[\x00-\x1f\x7f]/.test(key.key)) fail(400, 'Invalid API key entry');
      }
    }
    return routerConfig.normalizeConfig({ providers }).providers;
  } catch { fail(400, 'API import validation failed; verify provider URLs, models and keys'); }
}
function exportProviders(config) {
  let skipped = 0;
  const providers = [];
  for (const provider of config.providers || []) {
    try {
      if (provider.type === 'qclaw') throw new Error();
      remoteEndpoint(provider.baseUrl);
      if (provider.anthropicBaseUrl) remoteEndpoint(provider.anthropicBaseUrl);
    } catch { skipped++; continue; }
    providers.push({ ...pick(provider, PROVIDER), models: provider.models.map(model => pick(model, MODEL)), keys: provider.keys.map(key => pick(key, KEY)) });
  }
  if (!providers.length) throw new Error('No transferable API providers; local-only services and subscription accounts are excluded');
  return { providers: validateProviders(providers), skipped };
}
function createApiImport({ configFile, journalFile, isBusy, reload = () => {}, publish = () => {} }) {
  const load = () => routerConfig.loadConfig(configFile);
  const revision = config => hash([config.enabled, config.port, config.providers]);
  return {
    state() { const config = load(); return { revision: revision(config), providers: config.providers.length, keys: config.providers.reduce((total, provider) => total + provider.keys.length, 0), policy: 'keep-server' }; },
    apply(deviceId, payload) {
      shape(payload, ['requestId', 'expectedRevision', 'providers']);
      if (typeof payload.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.requestId) || !/^[a-f0-9]{64}$/.test(payload.expectedRevision)) fail(400, 'Invalid import identity');
      const providers = validateProviders(payload.providers);
      const journal = readJson(journalFile, []);
      const fingerprint = hash(payload);
      const prior = journal.find(entry => entry.deviceId === deviceId && entry.requestId === payload.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, 'Import request ID was already used');
        return prior.result || { ok: false, state: 'unknown', error: 'Import outcome is uncertain; inspect server configuration before creating another import' };
      }
      if (isBusy()) fail(409, 'Stop server conversations before importing API settings');
      const previous = load();
      if (revision(previous) !== payload.expectedRevision) fail(409, 'Server API settings changed; prepare the import again');
      if (journal.length >= 1000) fail(409, 'API import journal is full');
      const combined = [...previous.providers];
      const ids = new Set(combined.flatMap(provider => [provider.id, ...provider.keys.map(key => key.id)]));
      let added = 0, keys = 0, skipped = 0;
      for (const provider of providers) {
        if (combined.some(existing => existing.id === provider.id || existing.baseUrl === provider.baseUrl)
          || ids.has(provider.id) || provider.keys.some(key => ids.has(key.id))) { skipped++; continue; }
        combined.push(provider); ids.add(provider.id); provider.keys.forEach(key => ids.add(key.id)); added++; keys += provider.keys.length;
      }
      const next = routerConfig.normalizeConfig({ ...previous, providers: combined }, previous);
      const entry = { deviceId, requestId: payload.requestId, fingerprint, at: Date.now() };
      journal.push(entry);
      writeJson(journalFile, journal);
      try {
        if (added) { writeJson(configFile, next); reload(); }
      } catch {
        try { writeJson(configFile, previous); reload(); }
        catch { fail(500, 'API import rollback failed; inspect server configuration before further operations'); }
        entry.result = { ok: false, state: 'failed', error: 'API import failed; previous configuration restored' };
        writeJson(journalFile, journal);
        return entry.result;
      }
      entry.result = { ok: true, state: 'accepted', added, keys, skipped, policy: 'keep-server', revision: revision(next), enabled: next.enabled };
      writeJson(journalFile, journal);
      publish();
      return entry.result;
    },
  };
}

module.exports = { createApiImport, exportProviders, validateProviders };
