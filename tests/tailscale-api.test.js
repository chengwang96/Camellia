'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TailscaleAPI, normalizeCredentials, redact } = require('../src/main/remote/tailscale-api');
const { removeTree } = require('./test-fs.cjs');

const CLIENT_ID = 'client-id.example';
// Build the fake secret for format checks without a key-shaped source literal.
const CLIENT_SECRET = ['tskey', 'client', 'test', 'secret'].join('-');
const ACCESS_TOKEN = 'test-access-token';

function storage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => String(value).replace(/^encrypted:/, ''),
  };
}

function response({ status = 200, body = {}, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fixture(context, { fetchImpl, storageImpl = storage() } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tailscale-'));
  context.after(() => removeTree(directory));
  const api = new TailscaleAPI({ file: path.join(directory, 'tailscale-oauth.json'), safeStorage: storageImpl, fetchImpl,
    now: () => 1_700_000_000_000 });
  return { api, directory };
}

function successfulFetch(seen = []) {
  return async (url, options) => {
    seen.push({ url, options });
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'a', name: 'a.example.ts.net', hostname: 'a', addresses: ['100.64.0.1'], tags: ['tag:camellia-desktop'], connectedToControl: true },
      { id: 'b', name: 'b.example.ts.net', hostname: 'b', addresses: ['100.64.0.2'], tags: [], connectedToControl: true, os: 'linux' },
    ] } });
    if (url.endsWith('/tailnet/-/acl')) return response({ headers: { etag: 'W/"acl-1"' }, body: { tagOwners: { 'tag:camellia-relay': ['autogroup:admin'] }, grants: [
      { src: ['*'], dst: ['tag:camellia-relay'], app: { 'tailscale.com/cap/relay': [] } },
    ] } });
    throw new Error(`Unexpected URL ${url}`);
  };
}

test('normalizes OAuth credentials and rejects API keys or secret-shaped client IDs', () => {
  assert.deepEqual(normalizeCredentials({ clientId: ` ${CLIENT_ID} `, clientSecret: ` ${CLIENT_SECRET} ` }), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.throws(() => normalizeCredentials({ clientId: ['tskey', 'api', 'abc'].join('-'), clientSecret: CLIENT_SECRET }), /Client ID/);
  assert.throws(() => normalizeCredentials({ clientId: CLIENT_ID, clientSecret: ['tskey', 'api', 'abc'].join('-') }), /starts with tskey-client-/);
  assert.throws(() => normalizeCredentials({ clientId: CLIENT_ID, clientSecret: 'short' }), /starts with tskey-client-/);
});

test('redacts every Tailscale token form from surfaced errors', () => {
  const text = redact(`failed ${['tskey', 'client', 'abcdef'].join('-')} and ${['tskey', 'api', '123456'].join('-')} client_secret=topsecretx access_token=abcdefgh`);
  assert.equal(text.includes('abcdef'), false);
  assert.equal(text.includes('123456'), false);
  assert.equal(text.includes('topsecret'), false);
  assert.equal(text.includes('abcdefgh'), false);
  assert.match(text, /\[redacted\]/);
});

test('replacing a saved OAuth secret verifies it instead of reusing the old token', async context => {
  const seen = [], fetchValid = successfulFetch(seen);
  const { api } = fixture(context, { fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token') && new URLSearchParams(options.body).get('client_secret') !== CLIENT_SECRET)
      return response({ status: 401, body: { error_description: 'Invalid client credentials' } });
    return fetchValid(url, options);
  } });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal((await api.status({ force: true })).state, 'connected');
  assert.ok(api.access, 'The existing credentials have a cached access token');
  const result = await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET + '-wrong' });
  assert.equal(result.saved, false);
  assert.equal(api.saved().clientSecret, CLIENT_SECRET, 'Rejected credentials must not replace the saved secret');
});

test('verifies OAuth scope and read-only endpoints without exposing the secret', async context => {
  const seen = [];
  const { api } = fixture(context, { fetchImpl: successfulFetch(seen) });
  const result = await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(result.saved, true);
  assert.equal(result.configured, true);
  assert.equal(result.state, 'connected');
  assert.equal(result.changedAcl, false);
  assert.equal(result.tailnet.deviceCount, 2);
  assert.equal(result.tailnet.onlineCount, 2);
  assert.equal(result.tailnet.taggedCount, 1);
  assert.equal(result.acl.hasRelayGrant, true);
  assert.equal(seen.filter(entry => entry.url.endsWith('/oauth/token')).length, 1);
  const tokenRequest = seen.find(entry => entry.url.endsWith('/oauth/token'));
  const form = new URLSearchParams(tokenRequest.options.body);
  assert.equal(form.get('client_id'), CLIENT_ID);
  assert.equal(form.get('client_secret'), CLIENT_SECRET);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), 'policy_file:write devices:core:write');
  assert.equal(tokenRequest.options.headers.Authorization, undefined);
  assert.equal(seen.filter(entry => entry.options.method === 'GET').length, 2);
  assert.equal(seen.some(entry => entry.options.method !== 'GET' && !entry.url.endsWith('/oauth/token')), false);
  const saved = fs.readFileSync(path.join(path.dirname(api.file), 'tailscale-oauth.json'), 'utf8');
  assert.equal(saved.includes(CLIENT_SECRET), false);
  assert.equal(JSON.stringify(result).includes(CLIENT_SECRET), false);
  assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(api.saved()).includes(CLIENT_SECRET), true, 'the encrypted record must be decryptable in-process');
});

test('reports missing OAuth scope without saving credentials', async context => {
  const { api, directory } = fixture(context, { fetchImpl: async () => response({ body: { access_token: ACCESS_TOKEN,
    expires_in: 3600, scope: 'devices:core:write' } }) });
  const result = await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(result.saved, false);
  assert.equal(result.state, 'scope');
  assert.deepEqual(result.missingScopes, ['policy_file:write']);
  assert.equal(fs.existsSync(path.join(directory, 'tailscale-oauth.json')), false);
});

test('maps rejected credentials to a safe actionable error', async context => {
  const { api } = fixture(context, { fetchImpl: async () => response({ status: 401, body: { error_description: `bad ${CLIENT_SECRET}` } }) });
  const result = await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(result.saved, false);
  assert.equal(result.state, 'invalid');
  assert.equal(JSON.stringify(result).includes(CLIENT_SECRET), false);
});

test('status distinguishes unconfigured, connected, missing scope and invalid storage', async context => {
  const { api, directory } = fixture(context, { fetchImpl: successfulFetch() });
  assert.equal((await api.status()).state, 'unconfigured');
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal((await api.status()).state, 'connected');
  fs.writeFileSync(path.join(directory, 'tailscale-oauth.json'), JSON.stringify({ version: 1, encrypted: 'not-base64' }));
  assert.equal((await api.status()).state, 'invalid');
  const unavailable = new TailscaleAPI({ file: path.join(directory, 'tailscale-oauth.json'),
    safeStorage: { isEncryptionAvailable: () => false }, fetchImpl: successfulFetch() });
  assert.equal((await unavailable.status()).state, 'invalid');
});

test('an in-flight verification cannot restore credentials after removal', async context => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const { api } = fixture(context, { fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token')) { entered(); await delayed; }
    return successfulFetch()(url, options);
  } });
  const pending = api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await started;
  api.remove();
  release();
  await assert.rejects(pending, /credentials changed/i);
  assert.equal(api.saved(), null);
  assert.equal(api.access, null);
  assert.equal(api.statusCache, null);
});

test('removes stored credentials and clears the token cache', async context => {
  const { api, directory } = fixture(context, { fetchImpl: successfulFetch() });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(fs.existsSync(path.join(directory, 'tailscale-oauth.json')), true);
  api.remove();
  assert.equal(fs.existsSync(path.join(directory, 'tailscale-oauth.json')), false);
  assert.equal((await api.status()).state, 'unconfigured');
  assert.equal(api.access, null);
});

test('enables Peer Relay for this computer by validating the full policy, preserving ETag and authorizing only this source', async context => {
  const seen = [];
  let policy = { tagOwners: { 'tag:existing': ['autogroup:admin'] }, acls: [{ action: 'accept', src: ['autogroup:member'], dst: ['*:*'] }] };
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices') && options.method === 'GET') return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'hp1', name: 'hp.example.ts.net', hostname: 'hp', os: 'windows', addresses: ['100.64.0.2'], tags: [], connectedToControl: true },
      { id: 'relay1', name: 'vps.example.ts.net', hostname: 'vps', os: 'linux', addresses: ['100.64.0.9'], tags: ['tag:existing'], connectedToControl: true },
    ] } });
    if (url.endsWith('/tailnet/-/acl') && options.method === 'GET') return response({ headers: { etag: 'W/"policy-1"' }, body: policy });
    if (url.endsWith('/tailnet/-/acl/validate')) {
      const candidate = JSON.parse(options.body);
      assert.ok(candidate.grants.some(grant => grant.dst?.includes('100.64.0.9')));
      assert.deepEqual(candidate.acls, policy.acls);
      return response({});
    }
    if (url.endsWith('/tailnet/-/acl') && options.method === 'POST') {
      assert.equal(options.headers['If-Match'], 'W/"policy-1"');
      policy = JSON.parse(options.body);
      return response({ body: policy });
    }
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const result = await api.applyPeerRelay({ deviceId: 'relay1', sourceDeviceId: 'hp1' });
  assert.equal(result.applied, true);
  assert.equal(result.changedAcl, true);
  assert.equal(result.changedDevices, false);
  assert.deepEqual(policy.acls, [{ action: 'accept', src: ['autogroup:member'], dst: ['*:*'] }]);
  assert.deepEqual(policy.tagOwners['tag:existing'], ['autogroup:admin']);
  assert.equal(policy.grants.length, 1);
  assert.deepEqual(policy.grants[0].dst, ['100.64.0.9']);
  assert.deepEqual(policy.grants[0].src, ['100.64.0.2']);
  assert.equal(policy.grants[0].app['tailscale.com/cap/relay'].length, 0);
  assert.equal(seen.some(entry => entry.url.endsWith('/tags')), false);
  assert.ok(seen.some(entry => entry.url.endsWith('/acl/validate')));
  assert.equal(JSON.stringify(result).includes(CLIENT_SECRET), false);
});

test('does not write when the selected relay IP already has Peer Relay access', async context => {
  let writes = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'hp1', name: 'hp.example.ts.net', hostname: 'hp', os: 'windows', addresses: ['100.64.0.2'], tags: [], connectedToControl: true },
      { id: 'relay1', name: 'VPS', hostname: 'vps', os: 'linux', addresses: ['100.64.0.9'], tags: [], connectedToControl: true },
    ] } });
    if (url.endsWith('/tailnet/-/acl')) return response({ headers: { etag: 'W/"same"' }, body: {
      grants: [{ src: ['autogroup:member'], dst: ['100.64.0.9'], app: { 'tailscale.com/cap/relay': [] } }] } });
    if (options.method === 'POST') writes++;
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const result = await api.applyPeerRelay({ deviceId: 'relay1', sourceDeviceId: 'hp1' });
  assert.equal(result.alreadyConfigured, true);
  assert.equal(result.changedAcl, false);
  assert.equal(writes, 0);
  assert.equal(result.devices.find(device => device.id === 'relay1').relaySelected, true);
});

test('accepts an existing tag grant without rewriting policy', async context => {
  let writes = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'hp1', name: 'hp.example.ts.net', hostname: 'hp', os: 'windows', addresses: ['100.64.0.2'], tags: [], connectedToControl: true },
      { id: 'relay1', name: 'VPS', hostname: 'vps', os: 'linux', addresses: ['100.64.0.9'], tags: ['tag:camellia-relay'], connectedToControl: true },
    ] } });
    if (url.endsWith('/tailnet/-/acl')) return response({ headers: { etag: 'W/"same"' }, body: {
      grants: [{ src: ['autogroup:member'], dst: ['tag:camellia-relay'], app: { 'tailscale.com/cap/relay': [] } }] } });
    if (options.method === 'POST') writes++;
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const result = await api.applyPeerRelay({ deviceId: 'relay1', sourceDeviceId: 'hp1' });
  assert.equal(result.alreadyConfigured, true);
  assert.equal(writes, 0);
  assert.equal(result.devices.find(device => device.id === 'relay1').relaySelected, true);
});

test('relay status cache follows the source identity, including address fallback from embedded node IDs', async context => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { devices: [
      { id: 'hp1', addresses: ['100.64.0.2'] },
      { id: 'other', addresses: ['100.64.0.3'] },
      { id: 'relay1', addresses: ['100.64.0.9'] },
    ] } });
    if (url.endsWith('/tailnet/-/acl') && options.method === 'GET') return response({ body: {
      grants: [{ src: ['100.64.0.2'], dst: ['100.64.0.9'], app: { 'tailscale.com/cap/relay': [] } }],
    } });
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  const selected = view => view.devices.find(device => device.id === 'relay1').relaySelected;
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(selected(await api.status()), false);
  assert.equal(selected(await api.status({ sourceDeviceId: 'hp1' })), true);
  assert.equal(selected(await api.status({ sourceDeviceId: 'other' })), false);
  assert.equal(selected(await api.status({ sourceDeviceId: 'embedded-node-id' })), false);
  assert.equal(selected(await api.status({ sourceDeviceId: 'embedded-node-id', sourceAddress: '100.64.0.2' })), true);
});

test('credential verification reports relay access for the current source on its first render', async context => {
  const { api } = fixture(context, { fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { devices: [
      { id: 'hp1', addresses: ['100.64.0.2'] }, { id: 'relay1', addresses: ['100.64.0.9'] },
    ] } });
    if (url.endsWith('/tailnet/-/acl') && options.method === 'GET') return response({ body: {
      grants: [{ src: ['100.64.0.2'], dst: ['100.64.0.9'], app: { 'tailscale.com/cap/relay': [] } }],
    } });
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  } });
  const result = await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    { sourceDeviceId: 'embedded-node-id', sourceAddress: '100.64.0.2' });
  assert.equal(result.saved, true);
  assert.equal(result.devices.find(device => device.id === 'relay1').relaySelected, true);
});

test('applying an existing grant refreshes a cached off state after an external ACL change', async context => {
  let grants = [], writes = 0;
  const { api } = fixture(context, { fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { devices: [
      { id: 'hp1', addresses: ['100.64.0.2'] }, { id: 'relay1', addresses: ['100.64.0.9'] },
    ] } });
    if (url.endsWith('/tailnet/-/acl') && options.method === 'GET') return response({ headers: { etag: 'W/"acl"' }, body: { grants } });
    writes++;
    throw new Error(`Unexpected write ${url}`);
  } });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await api.status({ sourceDeviceId: 'hp1' });
  grants = [{ src: ['100.64.0.2'], dst: ['100.64.0.9'], app: { 'tailscale.com/cap/relay': [] } }];
  const result = await api.applyPeerRelay({ deviceId: 'relay1', sourceDeviceId: 'hp1' });
  assert.equal(result.alreadyConfigured, true);
  assert.equal(result.devices.find(device => device.id === 'relay1').relaySelected, true);
  assert.equal(writes, 0);
});

test('does not treat a wildcard destination as every relay', async context => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'relay1', name: 'VPS', os: 'linux', addresses: ['100.64.0.9'], tags: [], connectedToControl: true },
    ] } });
    if (url.endsWith('/tailnet/-/acl') && options.method === 'GET') return response({ headers: { etag: 'W/"same"' }, body: {
      grants: [{ src: ['autogroup:member'], dst: ['*'], app: { 'tailscale.com/cap/relay': [] } }] } });
    if (url.endsWith('/acl/validate')) return response({});
    if (url.endsWith('/tailnet/-/acl') && options.method === 'POST') return response({ body: {} });
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  const result = await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(result.devices[0].relayGranted, false);
});

test('recognizes a narrowed relay grant as the console Peer Relay marker without rewriting it', async context => {
  let writes = 0;
  let policy = { grants: [{ src: ['tag:restricted-client'], dst: ['100.64.0.9'], app: { 'tailscale.com/cap/relay': [] } }] };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'hp1', name: 'hp.example.ts.net', hostname: 'hp', os: 'windows', addresses: ['100.64.0.2'], tags: [], connectedToControl: true },
      { id: 'relay1', name: 'VPS', hostname: 'vps', os: 'linux', addresses: ['100.64.0.9'], tags: [], connectedToControl: true },
    ] } });
    if (url.endsWith('/tailnet/-/acl') && options.method === 'GET') return response({ headers: { etag: 'W/"same"' }, body: policy });
    if (url.endsWith('/tailnet/-/acl/validate')) return response({});
    if (url.endsWith('/tailnet/-/acl') && options.method === 'POST') { writes++; policy = JSON.parse(options.body); return response({ body: policy }); }
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  const result = await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(result.devices.find(device => device.id === 'relay1').relayGranted, true);
  const applied = await api.applyPeerRelay({ deviceId: 'relay1', sourceDeviceId: 'hp1' });
  // The VPS is marked as a relay, but this computer is not in that grant's src.
  // Enabling the switch adds a separate exact grant for this computer only.
  assert.equal(applied.applied, true);
  assert.equal(applied.changedAcl, true);
  assert.equal(writes, 1);
});

test('rejects relay candidates without a Tailnet IPv4', async context => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'hp1', name: 'hp.example.ts.net', hostname: 'hp', os: 'windows', addresses: ['100.64.0.2'], tags: [], connectedToControl: true },
      { id: 'relay1', name: 'VPS', os: 'linux', addresses: [], tags: [], connectedToControl: true },
    ] } });
    if (url.endsWith('/tailnet/-/acl')) return response({ headers: { etag: 'W/"same"' }, body: {} });
    if (url.endsWith('/acl/validate')) return response({});
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await assert.rejects(api.applyPeerRelay({ deviceId: 'relay1', sourceDeviceId: 'hp1' }), /no Tailnet IPv4/);
});

test('does not add a duplicate when the existing grant is narrower than this computer', async context => {
  let writes = 0;
  let policy = { grants: [{ src: ['tag:one-client'], dst: ['100.64.0.9'], app: { 'tailscale.com/cap/relay': [] } }] };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'hp1', name: 'hp.example.ts.net', hostname: 'hp', os: 'windows', addresses: ['100.64.0.2'], tags: [], connectedToControl: true },
      { id: 'relay1', name: 'VPS', os: 'linux', addresses: ['100.64.0.9'], tags: [], connectedToControl: true },
    ] } });
    if (url.endsWith('/tailnet/-/acl') && options.method === 'GET') return response({ headers: { etag: 'W/"same"' }, body: policy });
    if (url.endsWith('/tailnet/-/acl/validate')) return response({});
    if (url.endsWith('/tailnet/-/acl') && options.method === 'POST') { writes++; policy = JSON.parse(options.body); return response({ body: policy }); }
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const result = await api.applyPeerRelay({ deviceId: 'relay1', sourceDeviceId: 'hp1' });
  // A grant for someone else is not a grant for this computer, so a separate
  // exact rule is added while the unrelated rule stays untouched.
  assert.equal(result.applied, true);
  assert.equal(writes, 1);
  assert.equal(policy.grants.length, 2);
  assert.deepEqual(policy.grants[0].src, ['tag:one-client']);
  assert.deepEqual(policy.grants[1], { src: ['100.64.0.2'], dst: ['100.64.0.9'], app: { 'tailscale.com/cap/relay': [] } });
});

test('surfaces an ETag conflict instead of overwriting a concurrent ACL edit', async context => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'hp1', name: 'hp.example.ts.net', hostname: 'hp', os: 'windows', addresses: ['100.64.0.2'], tags: [], connectedToControl: true },
      { id: 'relay1', name: 'VPS', hostname: 'vps', os: 'linux', addresses: ['100.64.0.9'], tags: [], connectedToControl: true },
    ] } });
    if (url.endsWith('/tailnet/-/acl') && options.method === 'GET') return response({ headers: { etag: 'W/"old"' }, body: {} });
    if (url.endsWith('/acl/validate')) return response({});
    if (url.endsWith('/tailnet/-/acl')) return response({ status: 412, body: { message: 'etag mismatch' } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const { api } = fixture(context, { fetchImpl });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await assert.rejects(api.applyPeerRelay({ deviceId: 'relay1', sourceDeviceId: 'hp1' }), /changed since it was loaded/);
});

test('renames a relay through a targeted device read without reloading ACLs or changing its OS hostname', async context => {
  const seen = [];
  let renamed = false;
  const fetchImpl = async (url, options) => {
    seen.push({ url, method: options.method, body: options.body });
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/device/relay1/name') && options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { name: 'vps-relay' });
      renamed = true;
      return response({ body: {} });
    }
    if (url.endsWith('/device/relay1') && options.method === 'GET') return response({ body: {
      id: 'relay1', name: renamed ? 'vps-relay.example.ts.net' : 'vps.example.ts.net', hostname: 'vps',
    } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { tailnet: 'example.ts.net', devices: [
      { id: 'hp1', name: 'hp.example.ts.net', hostname: 'hp', os: 'windows', addresses: ['100.64.0.2'], tags: [], connectedToControl: true },
      { id: 'relay1', name: renamed ? 'vps-relay.example.ts.net' : 'vps.example.ts.net', hostname: 'vps',
        os: 'linux', addresses: ['100.64.0.9'], tags: [], connectedToControl: true },
    ] } });
    if (url.endsWith('/tailnet/-/acl')) return response({ headers: { etag: 'W/"same"' }, body: {} });
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const result = await api.renameDevice({ deviceId: 'relay1', name: ' vps-relay ', sourceDeviceId: 'hp1' });
  assert.equal(result.renamed, true);
  assert.equal(result.renamedDeviceId, 'relay1');
  assert.equal(result.state, 'connected');
  assert.equal(result.renameVerified, true);
  assert.equal(result.devices.find(device => device.id === 'relay1').name, 'vps-relay.example.ts.net');
  assert.equal(result.devices.find(device => device.id === 'relay1').hostname, 'vps');
  assert.equal(seen.filter(entry => entry.url.endsWith('/tailnet/-/acl')).length, 1);
  assert.equal(seen.some(entry => entry.url.endsWith('/device/relay1/name') && entry.method === 'POST'), true);
});

for (const scenario of [
  { title: 'confirms a rename after a lost POST response without resending the mutation', lostWrite: true, applied: true, verified: true },
  { title: 'keeps an acknowledged rename when the follow-up read times out', lostRead: true, applied: true, verified: false },
  { title: 'does not report success when a timed-out rename was not applied', lostWrite: true, applied: false, fails: true },
  { title: 'does not report success when both rename and verification time out', lostWrite: true, lostRead: true, applied: true, fails: true },
]) {
  test(scenario.title, async context => {
    let writes = 0, reads = 0;
    const { api } = fixture(context, { fetchImpl: async (url, options) => {
      if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
        scope: 'policy_file:write devices:core:write' } });
      if (url.endsWith('/tailnet/-/devices')) return response({ body: { devices: [
        { id: 'relay1', name: 'vps.example.ts.net', hostname: 'original-os-name', addresses: ['100.64.0.9'] },
      ] } });
      if (url.endsWith('/tailnet/-/acl')) return response({ body: {} });
      if (url.endsWith('/device/relay1/name')) {
        writes++;
        if (scenario.lostWrite) throw new DOMException('response lost', 'AbortError');
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/device/relay1')) {
        reads++;
        assert.equal(options.signal.aborted, false, 'verification must have its own live deadline');
        if (scenario.lostRead) throw new DOMException('read timed out', 'AbortError');
        return response({ body: { id: 'relay1', name: `${scenario.applied ? 'aliyun' : 'vps'}.example.ts.net`, hostname: 'original-os-name' } });
      }
      throw new Error(`Unexpected URL ${url}`);
    } });
    await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    if (scenario.fails) {
      await assert.rejects(api.renameDevice({ deviceId: 'relay1', name: 'aliyun' }), /timed out/);
      assert.equal(api.statusCache.view.devices[0].name, 'vps.example.ts.net');
    } else {
      const result = await api.renameDevice({ deviceId: 'relay1', name: 'aliyun' });
      assert.equal(result.renamed, true);
      assert.equal(result.renameVerified, scenario.verified);
      assert.equal(result.renameRecovered, Boolean(scenario.lostWrite));
      assert.equal(result.devices[0].hostname, 'original-os-name');
      assert.equal(result.devices[0].name, scenario.verified ? 'aliyun.example.ts.net' : 'aliyun');
      assert.equal((await api.status()).devices[0].name, result.devices[0].name);
    }
    assert.equal(writes, 1);
    assert.equal(reads, 1);
  });
}

test('a rejected rename surfaces the scope error without a verification request or optimistic name', async context => {
  const { api } = fixture(context, { fetchImpl: async (url, options) => {
    if (url.endsWith('/device/relay1/name')) return response({ status: 403 });
    if (url.endsWith('/device/relay1')) assert.fail('An explicit rejection is not an uncertain write');
    return successfulFetch()(url, options);
  } });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await assert.rejects(api.renameDevice({ deviceId: 'relay1', name: 'aliyun' }), /required scope/);
  assert.equal(api.statusCache.view.devices.some(device => device.name === 'aliyun'), false);
});

test('rejects invalid relay device names before calling Tailscale', async context => {
  const { api } = fixture(context, { fetchImpl: successfulFetch() });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await assert.rejects(api.renameDevice({ deviceId: 'relay1', name: 'bad name' }), /letters, digits or hyphens/);
  await assert.rejects(api.renameDevice({ deviceId: 'relay1', name: '-bad' }), /letters, digits or hyphens/);
});

test('renames the current device without requiring a cached device id', async context => {
  let renamed = false;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ body: { access_token: ACCESS_TOKEN, expires_in: 3600,
      scope: 'policy_file:write devices:core:write' } });
    if (url.endsWith('/tailnet/-/devices')) return response({ body: { devices: [
      { id: 'hp1', name: 'hp.example.ts.net', hostname: 'hp', addresses: ['100.64.0.2'] },
    ] } });
    if (url.endsWith('/tailnet/-/acl')) return response({ headers: { etag: 'W/"same"' }, body: {} });
    if (url.endsWith('/device/hp1/name') && options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { name: 'work-pc' });
      renamed = true;
      return response({ body: {} });
    }
    throw new Error(`Unexpected URL ${url} ${options.method}`);
  };
  const { api } = fixture(context, { fetchImpl });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const result = await api.renameCurrentDevice({ name: 'work-pc', sourceAddress: '100.64.0.2' });
  assert.deepEqual(result, { synced: true, deviceId: 'hp1', name: 'work-pc' });
  assert.equal(renamed, true);
});

test('current-device rename resolves an embedded node id through its Tailnet address', async context => {
  const seen = [];
  const { api } = fixture(context, { fetchImpl: async (url, options) => {
    if (url.endsWith('/device/a/name')) return response();
    if (/\/device\//.test(url)) assert.fail('An embedded node ID is not a management API ID');
    return successfulFetch(seen)(url, options);
  } });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const result = await api.renameCurrentDevice({ name: 'work-pc', sourceDeviceId: 'embedded-node-id', sourceAddress: '100.64.0.1' });
  assert.deepEqual(result, { synced: true, deviceId: 'a', name: 'work-pc' });
});

test('reports why the current device rename was not synced', async context => {
  const { api } = fixture(context, { fetchImpl: successfulFetch() });
  assert.deepEqual(await api.renameCurrentDevice({ name: 'work-pc' }), { synced: false, reason: 'unconfigured' });
  await api.verifyAndSave({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.deepEqual(await api.renameCurrentDevice({ name: 'bad name', sourceDeviceId: 'a' }),
    { synced: false, reason: 'invalid-name' });
});
