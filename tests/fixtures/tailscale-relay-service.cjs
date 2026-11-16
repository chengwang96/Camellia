'use strict';

// Isolated real service/API adapter for the browser regression. Only the
// Tailscale HTTP endpoints and OS credential storage are replaced.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createRemoteService } = require('../../src/main/remote/service');
const { TailscaleAPI } = require('../../src/main/remote/tailscale-api');
const { removeTree } = require('../test-fs.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-relay-ui-'));
const storage = { isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
new TailscaleAPI({ file: path.join(root, 'remote/tailscale-oauth.json'), safeStorage: storage })
  .save({ clientId: 'test-client.example', clientSecret: 'tskey-client-test-secret' });
let relayName = 'izwz94tkwtju32rm6f4f9mz', renameMode = '', renameWrites = 0;
globalThis.fetch = async (url, options) => {
  let body;
  if (url.endsWith('/oauth/token')) body = { access_token: 'test-access-token', expires_in: 3600,
    scope: 'policy_file:write devices:core:write' };
  else if (url.endsWith('/device/relay1/name')) {
    renameWrites++;
    if (renameMode === 'timeout-before') throw new DOMException('Lost rename response', 'AbortError');
    relayName = JSON.parse(options.body).name;
    if (renameMode === 'timeout-after') throw new DOMException('Lost rename response', 'AbortError');
    return new Response(null, { status: 200 });
  }
  else if (options.method !== 'GET') throw new Error('Existing relay access must not be rewritten');
  else if (url.endsWith('/device/relay1')) {
    if (renameMode === 'read-failure') throw new DOMException('Device read timed out', 'AbortError');
    body = { id: 'relay1', name: relayName + '.example.ts.net', hostname: 'original-os-hostname' };
  }
  else if (url.endsWith('/tailnet/-/devices')) body = { devices: [
    { id: 'hp1', addresses: ['100.64.0.2'] },
    { id: 'relay1', name: relayName + '.example.ts.net', hostname: 'original-os-hostname', os: 'linux', addresses: ['100.64.0.9'], connectedToControl: true },
  ] };
  else if (url.endsWith('/tailnet/-/acl')) body = { grants: [
    { src: ['autogroup:member'], dst: ['100.64.0.9'], app: { 'tailscale.com/cap/relay': [] } },
  ] };
  else throw new Error(`Unexpected URL ${url}`);
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', etag: 'W/"policy"' } });
};
const service = createRemoteService({ dataDir: root, safeStorage: storage,
  preferences: () => ({ language: process.argv[2] || 'en', theme: 'light' }),
  manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } },
  networkFactory: () => ({ snapshot: { state: 'Stopped' }, async stop() {} }) });

void (async () => {
  try {
    await service.command('tailscale-status');
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const { action, payload } = JSON.parse(line);
      if (action === 'close') break;
      if (action === 'test-rename-mode') {
        renameMode = payload.mode;
        process.stdout.write(JSON.stringify({ ok: true, result: { renameMode, renameWrites, relayName } }) + '\n');
        continue;
      }
      // Reproduce a status cached before the embedded node was identified.
      if (action === 'tailscale-apply-peer-relay') service.setSourceDeviceId('embedded-node-id', '100.64.0.2');
      const result = await service.command(action, payload);
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } finally { await service.close(); removeTree(root); }
})().catch(error => { console.error(error); process.exitCode = 1; });
