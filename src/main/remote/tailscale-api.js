'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('../../shared/json-store');

const OAUTH_URL = 'https://api.tailscale.com/api/v2/oauth/token';
const API_ROOT = 'https://api.tailscale.com/api/v2';
const CONSOLE_URL = 'https://console.tailscale.com/admin/settings/oauth';
const REQUIRED_SCOPES = ['policy_file:write', 'devices:core:write'];
const CLIENT_ID = /^[A-Za-z0-9._-]{4,200}$/;
const CLIENT_SECRET = /^tskey-client-[A-Za-z0-9_-]{8,300}$/;
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;
const RELAY_CAPABILITY = 'tailscale.com/cap/relay';
const MAX_STATUS_DEVICES = 200;
const DEVICE_ID = /^[A-Za-z0-9]+$/;

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasRelayGrant(policy) {
  return relayGrantTargets(policy).length > 0;
}

function relayGrantTargets(policy) {
  const grants = Array.isArray(policy?.grants) ? policy.grants : [];
  const targets = new Set();
  for (const grant of grants) {
    if (!isRecord(grant) || !Array.isArray(grant.dst) || !isRecord(grant.app)
        || !Object.prototype.hasOwnProperty.call(grant.app, RELAY_CAPABILITY)) continue;
    for (const target of grant.dst) if (typeof target === 'string' && target) targets.add(target);
  }
  return [...targets].slice(0, 100);
}

function isTailnetIPv4(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}

function relayGranted(device, policy) {
  return relayGrantsForDevice(device, policy).length > 0;
}

function grantMatchesDevice(device, selectors, { wildcard = true } = {}) {
  const values = Array.isArray(selectors) ? selectors : [];
  return (wildcard && (values.includes('*') || values.includes('autogroup:member')))
    || (Array.isArray(device.addresses) && device.addresses.some(address => values.includes(address)))
    || (Array.isArray(device.tags) && device.tags.some(tag => values.includes(tag)))
    || (typeof device.hostname === 'string' && values.includes(device.hostname))
    || (typeof device.name === 'string' && values.includes(device.name));
}

function relayGrantsForDevice(device, policy) {
  const grants = Array.isArray(policy?.grants) ? policy.grants : [];
  return grants.filter(grant => {
    if (!isRecord(grant) || !Array.isArray(grant.dst) || !isRecord(grant.app)
        || !Object.prototype.hasOwnProperty.call(grant.app, RELAY_CAPABILITY)) return false;
    // Tailscale's admin console marks a device as Peer Relay whenever it is a
    // relay grant destination, regardless of which source devices may use it.
    // Exclude "*" so a broad grant does not label every device as a relay.
    return grantMatchesDevice(device, grant.dst, { wildcard: false });
  });
}

function relayGrantsForPair(source, relay, policy) {
  const grants = Array.isArray(policy?.grants) ? policy.grants : [];
  return grants.filter(grant => isRecord(grant) && Array.isArray(grant.src) && Array.isArray(grant.dst)
    && isRecord(grant.app) && Object.prototype.hasOwnProperty.call(grant.app, RELAY_CAPABILITY)
    && grantMatchesDevice(source, grant.src) && grantMatchesDevice(relay, grant.dst));
}

function exactRelayGrants(source, relay, policy) {
  const sourceAddress = (Array.isArray(source.addresses) ? source.addresses : []).find(isTailnetIPv4);
  const relayAddress = (Array.isArray(relay.addresses) ? relay.addresses : []).find(isTailnetIPv4);
  if (!sourceAddress || !relayAddress) return [];
  const grants = Array.isArray(policy?.grants) ? policy.grants : [];
  return grants.filter(grant => isRecord(grant) && Array.isArray(grant.src) && Array.isArray(grant.dst)
    && isRecord(grant.app) && Object.prototype.hasOwnProperty.call(grant.app, RELAY_CAPABILITY)
    && grant.src.length === 1 && grant.src[0] === sourceAddress
    && grant.dst.length === 1 && grant.dst[0] === relayAddress);
}

function secureStorage(storage) {
  if (!storage?.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') {
    throw new Error('Unlock secure system storage before saving Tailscale credentials');
  }
}

function normalizeCredentials(payload = {}) {
  const clientId = typeof payload.clientId === 'string' ? payload.clientId.trim() : '';
  const clientSecret = typeof payload.clientSecret === 'string' ? payload.clientSecret.trim() : '';
  if (!CLIENT_ID.test(clientId) || /^tskey-(?:api|client)-/i.test(clientId)) throw new Error('Enter the OAuth Client ID, not an API key or client secret');
  if (!CLIENT_SECRET.test(clientSecret)) throw new Error('Client Secret must be a Tailscale OAuth client secret that starts with tskey-client-');
  return { clientId, clientSecret };
}

function redact(value) {
  return String(value || '')
    .replace(/tskey-client-[A-Za-z0-9_-]+/g, 'tskey-client-[redacted]')
    .replace(/tskey-api-[A-Za-z0-9_-]+/g, 'tskey-api-[redacted]')
    .replace(/\b(client_secret|access_token|token)=([^&\s]+)/gi, '$1=[redacted]')
    .slice(0, 300);
}

function validTailnet(...values) {
  return values.find(value => typeof value === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(value)) || '-';
}

function deviceSummary(device) {
  const addresses = Array.isArray(device.addresses) ? device.addresses.filter(address => typeof address === 'string').slice(0, 8) : [];
  return {
    id: typeof device.id === 'string' ? device.id : '',
    name: typeof device.name === 'string' ? device.name : typeof device.hostname === 'string' ? device.hostname : '',
    hostname: typeof device.hostname === 'string' ? device.hostname : '',
    os: typeof device.os === 'string' ? device.os : '',
    addresses,
    tags: Array.isArray(device.tags) ? device.tags.filter(tag => typeof tag === 'string').slice(0, 32) : [],
    online: device.connectedToControl === true || device.online === true,
  };
}

class TailscaleAPI {
  constructor({ file, safeStorage, fetchImpl = globalThis.fetch, now = Date.now, openExternal = null }) {
    Object.assign(this, { file, safeStorage, fetchImpl, now, openExternal });
    this.access = null;
    this.statusCache = null;
    this.credentialRevision = 0;
  }

  saved() {
    const value = readJson(this.file, null);
    if (!value) return null;
    if (value.version !== 1 || typeof value.encrypted !== 'string') throw new Error('Saved Tailscale credentials are invalid; remove and add them again');
    secureStorage(this.safeStorage);
    try {
      const credentials = JSON.parse(this.safeStorage.decryptString(Buffer.from(String(value.encrypted), 'base64')));
      if (!credentials || typeof credentials.clientId !== 'string' || typeof credentials.clientSecret !== 'string'
          || !CLIENT_ID.test(credentials.clientId) || !CLIENT_SECRET.test(credentials.clientSecret)
          || Object.keys(credentials).some(key => !['clientId', 'clientSecret'].includes(key))) throw new Error();
      return { clientId: credentials.clientId, clientSecret: credentials.clientSecret, savedAt: Number(value.savedAt) || null };
    } catch {
      throw new Error('Cannot unlock saved Tailscale credentials; remove and add them again');
    }
  }

  save(credentials) {
    secureStorage(this.safeStorage);
    const normalized = normalizeCredentials(credentials);
    const encrypted = this.safeStorage.encryptString(JSON.stringify(normalized)).toString('base64');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeJson(this.file, { version: 1, encrypted, savedAt: this.now() });
    this.credentialRevision++;
    this.access = null;
    this.statusCache = null;
    return { clientId: normalized.clientId, savedAt: this.now() };
  }

  remove() {
    fs.rmSync(this.file, { force: true });
    this.credentialRevision++;
    this.access = null;
    this.statusCache = null;
  }

  assertCredentials(revision) {
    if (revision !== this.credentialRevision) throw new Error('Tailscale credentials changed while this request was running');
  }

  async requestToken(credentials, signal) {
    let response;
    try {
      response = await this.fetchImpl(OAUTH_URL, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret,
          grant_type: 'client_credentials', scope: REQUIRED_SCOPES.join(' ') }).toString(),
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Tailscale token request timed out');
      throw new Error(`Cannot reach Tailscale: ${redact(error.message)}`);
    }
    let body = {};
    try { body = await response.json(); } catch { /* status text is enough */ }
    if (!response.ok) {
      const detail = typeof body.error_description === 'string' ? body.error_description : typeof body.message === 'string' ? body.message : '';
      if (response.status === 401 || response.status === 403) throw new Error('Tailscale rejected the client credentials or their scope');
      throw new Error(`Tailscale token request failed (${response.status})${detail ? `: ${redact(detail)}` : ''}`);
    }
    if (typeof body.access_token !== 'string' || !/^[A-Za-z0-9._~-]{8,4096}$/.test(body.access_token)) throw new Error('Tailscale returned an invalid access token');
    const lifetime = Number(body.expires_in);
    const expiresAt = this.now() + (Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime * 1000, 60 * 60 * 1000) : TOKEN_LIFETIME_MS) - 60_000;
    return { token: body.access_token, expiresAt, scope: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [] };
  }

  async token(credentials, { fresh = false } = {}) {
    if (!fresh && this.access && this.access.clientId === credentials.clientId && this.access.expiresAt > this.now()) return this.access;
    const controller = new AbortController();
    const revision = this.credentialRevision;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await this.requestToken(credentials, controller.signal);
      this.assertCredentials(revision);
      this.access = { ...result, clientId: credentials.clientId };
      return this.access;
    } finally { clearTimeout(timer); }
  }

  async get(endpoint, token, signal) {
    let response;
    try {
      response = await this.fetchImpl(API_ROOT + endpoint, { method: 'GET', signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Tailscale API request timed out', { cause: error });
      throw new Error(`Cannot reach the Tailscale API: ${redact(error.message)}`, { cause: error });
    }
    const text = await response.text();
    let body = null, parsed = false;
    try { body = text ? JSON.parse(text) : null; parsed = Boolean(text); }
    catch { /* handled below */ }
    if (!response.ok) {
      const detail = isRecord(body) && typeof body.message === 'string' ? body.message : '';
      if (response.status === 401) { this.access = null; throw new Error('Tailscale access token expired or was revoked'); }
      if (response.status === 403) throw new Error('The OAuth client is missing a required scope');
      throw new Error(`Tailscale API request failed (${response.status})${detail ? `: ${redact(detail)}` : ''}`);
    }
    return { body, parsed, etag: response.headers.get('etag') || '' };
  }

  async post(endpoint, token, { body, headers = {}, signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(API_ROOT + endpoint, { method: 'POST', signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body ?? {}) });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Tailscale API request timed out', { cause: error });
      throw new Error(`Cannot reach the Tailscale API: ${redact(error.message)}`, { cause: error });
    }
    const text = await response.text();
    let parsedBody = null, parsed = false;
    try { parsedBody = text ? JSON.parse(text) : null; parsed = Boolean(text); } catch { /* handled below */ }
    if (!response.ok) {
      const detail = isRecord(parsedBody) && typeof parsedBody.message === 'string' ? parsedBody.message : '';
      if (response.status === 401) { this.access = null; throw new Error('Tailscale access token expired or was revoked'); }
      if (response.status === 403) throw new Error('The OAuth client is missing a required scope');
      if (response.status === 412) throw new Error('Tailscale ACL changed since it was loaded; refresh and retry');
      throw new Error(`Tailscale API request failed (${response.status})${detail ? `: ${redact(detail)}` : ''}`);
    }
    return { body: parsedBody, parsed, etag: response.headers.get('etag') || '', status: response.status };
  }

  async validatePolicy(token, policy, signal) {
    return this.post('/tailnet/-/acl/validate', token, { body: policy, signal });
  }

  async validate(credentials, { signal, sourceDeviceId = '', sourceAddress = '', freshToken = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const access = await this.token(credentials, { fresh: freshToken });
      const scope = access.scope || [];
      const readable = ['devices:core:read', 'devices:core', 'devices'];
      const policyReadable = ['policy_file:read', 'policy_file', 'all'];
      const anyReadable = scope.includes('all');
      // The token endpoint can return a narrower default scope even when the
      // OAuth client was created with the required write scopes. Ask for them
      // explicitly; write includes the corresponding read operation.
      const hasDevices = readable.some(value => scope.includes(value)) || scope.includes('devices:core:write')
        || scope.includes('devices:core');
      const hasPolicy = policyReadable.some(value => scope.includes(value)) || scope.includes('policy_file:write')
        || scope.includes('policy_file');
      if (scope.length && !anyReadable && (!hasDevices || !hasPolicy)) {
        return { valid: false, reason: 'scope', scope,
          missingScopes: [...(hasDevices ? [] : ['devices:core:write']), ...(hasPolicy ? [] : ['policy_file:write'])] };
      }
      const devices = await this.get('/tailnet/-/devices', access.token, combined);
      const acl = await this.get('/tailnet/-/acl', access.token, combined);
      const tailnet = validTailnet(isRecord(devices.body) ? devices.body.tailnet : '',
        isRecord(acl.body) ? acl.body.tailnet : '');
      const entries = isRecord(devices.body) && Array.isArray(devices.body.devices) ? devices.body.devices : [];
      const counts = { devices: entries.length, online: 0, tagged: 0 };
      for (const entry of entries) {
        const summary = deviceSummary(entry);
        if (summary.online) counts.online++;
        if (summary.tags.length) counts.tagged++;
      }
      const relayTargets = relayGrantTargets(acl.body);
      const summaries = entries.slice(0, MAX_STATUS_DEVICES).map(deviceSummary);
      for (const summary of summaries) summary.relayGranted = relayGranted(summary, acl.body);
      const source = summaries.find(device => device.id === sourceDeviceId)
        || (sourceAddress ? summaries.find(device => device.addresses.includes(sourceAddress)) : undefined);
      for (const summary of summaries) {
        const pairGrants = source ? relayGrantsForPair(source, summary, acl.body) : [];
        summary.relaySelected = pairGrants.length > 0;
        summary.relayExact = pairGrants.length > 0 && exactRelayGrants(source, summary, acl.body).length > 0;
      }
      return {
        valid: true, scope, missingScopes: [],
        tailnet: { name: tailnet, deviceCount: counts.devices, onlineCount: counts.online, taggedCount: counts.tagged },
        devices: summaries,
        acl: { present: isRecord(acl.body), etag: acl.etag || null, hasRelayGrant: relayTargets.length > 0, relayTargets },
        checkedAt: this.now(), changedAcl: false, changedDevices: false,
      };
    } finally { clearTimeout(timer); }
  }

  async status({ sourceDeviceId = '', sourceAddress = '', force = false } = {}) {
    const revision = this.credentialRevision;
    let credentials;
    try { credentials = this.saved(); }
    catch (error) { return this.view({ configured: true, state: 'invalid', error: error.message, changedAcl: false }); }
    if (!credentials) return this.view({ configured: false, state: 'unconfigured', changedAcl: false });
    const token = this.access && this.access.clientId === credentials.clientId ? this.access.scope : null;
    // Relay access belongs to a source/relay pair. A status read before the
    // embedded node is identified must not become that computer's off state.
    if (!force && this.statusCache && this.statusCache.clientId === credentials.clientId
        && this.statusCache.sourceDeviceId === sourceDeviceId && this.statusCache.sourceAddress === sourceAddress
        && this.statusCache.expiresAt > this.now()) {
      return this.view({ ...this.statusCache.view, ...(token ? { scope: token } : {}) });
    }
    try {
      const result = await this.validate(credentials, { sourceDeviceId, sourceAddress });
      this.assertCredentials(revision);
      if (!result.valid) return this.view({ configured: true, clientId: credentials.clientId, state: result.reason,
        missingScopes: result.missingScopes, scope: result.scope, changedAcl: false });
      const view = this.view({ configured: true, clientId: credentials.clientId, state: 'connected', savedAt: credentials.savedAt, ...result });
      this.statusCache = { clientId: credentials.clientId, sourceDeviceId, sourceAddress, expiresAt: this.now() + 60_000, view };
      return view;
    } catch (error) {
      this.assertCredentials(revision);
      return this.view({ configured: true, clientId: credentials.clientId, state: /scope/i.test(error.message) ? 'scope' : 'error',
        error: error.message, changedAcl: false });
    }
  }

  async verifyAndSave(payload, { sourceDeviceId = '', sourceAddress = '' } = {}) {
    const revision = this.credentialRevision;
    const credentials = normalizeCredentials(payload);
    let result;
    // Saving is a credential check, so it must validate the entered secret
    // even when this client already has a usable access token.
    try { result = await this.validate(credentials, { sourceDeviceId, sourceAddress, freshToken: true }); }
    catch (error) {
      this.assertCredentials(revision);
      return { saved: false, state: /credentials|scope/i.test(error.message) ? 'invalid' : 'error',
        error: redact(error.message), changedAcl: false };
    }
    this.assertCredentials(revision);
    if (!result.valid) return { saved: false, state: result.reason, missingScopes: result.missingScopes, scope: result.scope, changedAcl: false };
    const saved = this.save(credentials);
    const view = this.view({ configured: true, state: 'connected', clientId: saved.clientId, savedAt: saved.savedAt, ...result });
    this.statusCache = { clientId: saved.clientId, sourceDeviceId, sourceAddress, expiresAt: this.now() + 60_000, view };
    return { saved: true, ...view };
  }

  async applyPeerRelay({ deviceId, sourceDeviceId, sourceAddress: preferredAddress, enabled = true } = {}) {
    const revision = this.credentialRevision;
    const credentials = this.saved();
    if (!credentials) throw new Error('Configure Tailscale admin API credentials first');
    if (enabled && (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId))) throw new Error('Choose a valid relay device');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const access = await this.token(credentials);
      const devices = await this.get('/tailnet/-/devices', access.token, controller.signal);
      const acl = await this.get('/tailnet/-/acl', access.token, controller.signal);
      this.assertCredentials(revision);
      const entries = isRecord(devices.body) && Array.isArray(devices.body.devices) ? devices.body.devices : [];
      const source = entries.find(entry => isRecord(entry) && entry.id === sourceDeviceId)
        || (preferredAddress ? entries.find(entry => isRecord(entry)
          && Array.isArray(entry.addresses) && entry.addresses.includes(preferredAddress)) : undefined);
      if (!source) throw new Error('This computer is no longer available in the tailnet');
      if (!enabled) {
        if (!acl.etag) throw new Error('Tailscale did not return an ACL version; refresh and retry');
        if (!isRecord(acl.body)) throw new Error('Tailscale returned an unsupported ACL document');
        const policy = JSON.parse(JSON.stringify(acl.body));
        if (policy.grants !== undefined && !Array.isArray(policy.grants)) throw new Error('The existing ACL has an unsupported grants section');
        const sourceAddress = (Array.isArray(source.addresses) ? source.addresses : []).find(isTailnetIPv4);
        if (!sourceAddress) throw new Error('This computer has no Tailnet IPv4 address');
        const existing = (Array.isArray(policy.grants) ? policy.grants : []).filter(grant => isRecord(grant)
          && Array.isArray(grant.src) && grant.src.length === 1 && grant.src[0] === sourceAddress
          && Array.isArray(grant.dst) && grant.dst.length === 1
          && isRecord(grant.app) && Object.prototype.hasOwnProperty.call(grant.app, RELAY_CAPABILITY));
        if (!existing.length) {
          const status = await this.status({ sourceDeviceId: source.id, force: true });
          return { ...status, applied: false, changedAcl: false, changedDevices: false, relayEnabled: false };
        }
        policy.grants = policy.grants.filter(grant => !existing.includes(grant));
        await this.validatePolicy(access.token, policy, controller.signal);
        this.assertCredentials(revision);
        await this.post('/tailnet/-/acl', access.token, { body: policy, headers: { 'If-Match': acl.etag }, signal: controller.signal });
        this.assertCredentials(revision);
        this.statusCache = null;
        const status = await this.status({ sourceDeviceId: source.id, force: true });
        return { ...status, applied: true, changedAcl: true, changedDevices: false, relayEnabled: false, removed: existing.length };
      }
      const device = entries.find(entry => isRecord(entry) && entry.id === deviceId);
      if (!device) throw new Error('The selected Tailscale device is no longer available');
      if (/^(?:ios|tvos|android)$/i.test(String(device.os || ''))) throw new Error('iOS, tvOS and Android devices cannot act as Peer Relay servers');
      if (!acl.etag) throw new Error('Tailscale did not return an ACL version; refresh and retry');
      if (!isRecord(acl.body)) throw new Error('Tailscale returned an unsupported ACL document');

      const policy = JSON.parse(JSON.stringify(acl.body));
      if (policy.grants !== undefined && !Array.isArray(policy.grants)) throw new Error('The existing ACL has an unsupported grants section');
      policy.grants = Array.isArray(policy.grants) ? policy.grants : [];
      const currentTags = Array.isArray(device.tags) ? device.tags.filter(tag => typeof tag === 'string') : [];
      const address = (Array.isArray(device.addresses) ? device.addresses : []).find(isTailnetIPv4);
      if (!address) throw new Error('The selected relay device has no Tailnet IPv4 address');
      const targets = relayGrantTargets(policy);
      const matching = exactRelayGrants(deviceSummary(source), deviceSummary(device), policy);
      if (matching.length) {
        const status = await this.status({ sourceDeviceId: source.id, force: true });
        return { ...status, applied: false, alreadyConfigured: true, changedAcl: false, changedDevices: false,
          relayEnabled: true, relayDeviceId: deviceId, relayAddress: address, relayTargets: targets };
      }
      if (relayGrantsForPair(deviceSummary(source), deviceSummary(device), policy).length) {
        // A grant already covers this computer and relay through broader
        // selectors. The relay is usable; do not add a second, narrower rule.
        const status = await this.status({ sourceDeviceId: source.id, force: true });
        return { ...status, applied: false, alreadyConfigured: true, changedAcl: false, changedDevices: false,
          relayEnabled: true, relayDeviceId: deviceId, relayAddress: address, relayTargets: targets };
      }
      // Authorize only this computer as a client of the chosen relay. This is
      // the client-side "use this relay" switch; it does not turn every tailnet
      // member into a consumer of the relay.
      const sourceAddress = (Array.isArray(source.addresses) ? source.addresses : []).find(isTailnetIPv4);
      if (!sourceAddress) throw new Error('This computer has no Tailnet IPv4 address');
      policy.grants.push({ src: [sourceAddress], dst: [address], app: { [RELAY_CAPABILITY]: [] } });

      // Validate first. This endpoint never changes the live policy file.
      await this.validatePolicy(access.token, policy, controller.signal);
      this.assertCredentials(revision);
      await this.post('/tailnet/-/acl', access.token, {
        body: policy, headers: { 'If-Match': acl.etag }, signal: controller.signal,
      });
      this.assertCredentials(revision);
      this.statusCache = null;
      const status = await this.status({ sourceDeviceId: source.id, force: true });
      return { ...status, applied: true, changedAcl: true, changedDevices: false,
        relayEnabled: true, relayDeviceId: deviceId, relayAddress: address, relaySourceAddress: sourceAddress,
        relayTags: currentTags, alreadyConfigured: false };
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Tailscale configuration request timed out');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async renameDevice({ deviceId, name } = {}) {
    const revision = this.credentialRevision;
    const credentials = this.saved();
    if (!credentials) throw new Error('Configure Tailscale admin API credentials first');
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw new Error('Choose a valid Tailscale device');
    const shortName = typeof name === 'string' ? name.trim() : '';
    if (!shortName || shortName.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(shortName)) {
      throw new Error('Use 1–63 letters, digits or hyphens; start and end with a letter or digit');
    }
    const access = await this.token(credentials);
    const previous = this.statusCache?.clientId === credentials.clientId ? this.statusCache : null;
    let writeError = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      await this.post(`/device/${deviceId}/name`, access.token, { body: { name: shortName }, signal: controller.signal });
    } catch (error) {
      // A lost response does not tell us whether Tailscale applied the name.
      // Verify through a read, never send the mutation a second time.
      if (!error.cause && !['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      writeError = error;
    } finally { clearTimeout(timer); }

    const verification = new AbortController();
    const verifyTimer = setTimeout(() => verification.abort(), 5000);
    let device = null;
    try {
      const result = await this.get(`/device/${deviceId}`, access.token, verification.signal);
      if (isRecord(result.body) && typeof result.body.name === 'string') device = result.body;
    } catch (error) {
      if (writeError) throw writeError;
      // An acknowledged write is successful even if the metadata refresh fails.
    } finally { clearTimeout(verifyTimer); }
    this.assertCredentials(revision);
    const verified = Boolean(device && device.name.split('.')[0].toLowerCase() === shortName.toLowerCase());
    if (writeError && !verified) throw writeError;

    // Updating the device name does not update its OS hostname. Reuse the ACL
    // snapshot and refresh just this device, keeping relay selection intact.
    const devices = (previous?.view.devices || []).map(entry => entry.id === deviceId
      ? { ...entry, name: verified ? device.name : shortName } : entry);
    if (!devices.some(entry => entry.id === deviceId)) devices.push({ ...deviceSummary(device || {}),
      id: deviceId, name: verified ? device.name : shortName });
    const view = this.view({ ...previous?.view, configured: true, clientId: credentials.clientId, state: 'connected',
      devices, changedAcl: false, changedDevices: true, renamed: true,
      renamedDeviceId: deviceId, renamedName: shortName, renameVerified: verified, renameRecovered: Boolean(writeError) });
    if (previous) this.statusCache = { ...previous, expiresAt: this.now() + 60_000, view };
    return view;
  }

  async renameCurrentDevice({ name, sourceDeviceId = '', sourceAddress = '', timeoutMs = 5000 } = {}) {
    const revision = this.credentialRevision;
    const credentials = this.saved();
    if (!credentials) return { synced: false, reason: 'unconfigured' };
    const controller = new AbortController();
    // Saving the local display name must stay responsive. A slow control
    // plane leaves the local name saved and reports that sync is pending.
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 5000));
    try {
      let deviceId = typeof sourceDeviceId === 'string' ? sourceDeviceId : '';
      const access = await this.token(credentials);
      const cached = this.statusCache?.clientId === credentials.clientId ? this.statusCache.view.devices || [] : [];
      const cachedSource = cached.find(entry => entry.id === deviceId)
        || (sourceAddress ? cached.find(entry => entry.addresses?.includes(sourceAddress)) : null);
      if (cachedSource) deviceId = cachedSource.id;
      else {
        const devices = await this.get('/tailnet/-/devices', access.token, controller.signal);
        const entries = isRecord(devices.body) && Array.isArray(devices.body.devices) ? devices.body.devices : [];
        const source = entries.find(entry => isRecord(entry) && entry.id === deviceId)
          || (sourceAddress ? entries.find(entry => isRecord(entry)
            && Array.isArray(entry.addresses) && entry.addresses.includes(sourceAddress)) : null);
        deviceId = source && typeof source.id === 'string' ? source.id : '';
      }
      this.assertCredentials(revision);
      if (!deviceId) return { synced: false, reason: 'device-not-found' };
      const shortName = typeof name === 'string' ? name.trim() : '';
      if (!shortName || shortName.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(shortName)) {
        return { synced: false, reason: 'invalid-name' };
      }
      await this.post(`/device/${deviceId}/name`, access.token, { body: { name: shortName }, signal: controller.signal });
      this.assertCredentials(revision);
      this.statusCache = null;
      return { synced: true, deviceId, name: shortName };
    } catch (error) {
      if (error.name === 'AbortError') return { synced: false, reason: 'timeout' };
      return { synced: false, reason: 'error', error: error.message };
    } finally { clearTimeout(timer); }
  }

  view(value) {
    // Keep the serialized view free of the access token. statusCache is also
    // exposed to the settings page and the separate mobile-access window.
    return { ...value, ...(value.savedAt ? { savedAt: value.savedAt } : {}) };
  }

  async openCredentials() {
    if (typeof this.openExternal !== 'function') throw new Error('Opening the Tailscale console is unavailable');
    await this.openExternal(CONSOLE_URL);
  }
}

module.exports = { TailscaleAPI, normalizeCredentials, redact, CONSOLE_URL };
