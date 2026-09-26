'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const { createHeadlessHost } = require('../src/cli/host');
const { dataDirectory, privateDirectory, readPrivate, networkKey, acquireLock } = require('../src/cli/private-storage');
const { listenControl, requestControl, socketPath } = require('../src/cli/local-control');
const { removeTree } = require('./test-fs.cjs');

function directory(context, cleanup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-server-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  if (cleanup) context.after(() => removeTree(root));
  return root;
}

function harness(context) {
  const dataDir = directory(context, false);
  let target, token, failure;
  const network = { snapshot: { state: 'Stopped' },
    async start() { this.snapshot = { state: 'NeedsLogin' }; },
    async login() { this.snapshot.loginUrl = 'https://login.tailscale.com/a/test'; },
    async status() { return this.snapshot; },
    async listen(address, value) { target = address; token = value; },
    async stop() { this.snapshot = { state: 'Stopped' }; },
    async logout() { await this.stop(); } };
  const driverFactory = ({ loadConfig, saveConfig }) => ({ dsh: {
    settings: () => ({ connection: 'api', permissionMode: 'ask', model: '', ...loadConfig().dshChat }),
    saveSettings: patch => { saveConfig({ dshChat: patch }); return patch; },
    ensure() { throw new Error('No model requests allowed in this test'); },
    async shutdown() {},
  } });
  const networkFactory = options => { failure = options.onFailure; return network; };
  const host = createHeadlessHost({ dataDir, networkFactory, driverFactory });
  const hosts = [host];
  context.after(async () => { for (const instance of hosts) await instance.close(); removeTree(dataDir); });
  async function online() {
    assert.equal((await host.command('start')).ok, true);
    network.snapshot = { state: 'Running', address: '100.80.1.2' };
    assert.equal((await host.command('state')).result.running, true);
  }
  function request(endpoint, body, bearer, transport = true) {
    return new Promise((resolve, reject) => {
      const request = http.request(target + endpoint, { method: body ? 'POST' : 'GET', headers: {
        host: '100.80.1.2:43127', ...(transport ? { 'x-camellia-transport': token, 'x-camellia-peer': '100.90.1.2' } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
      } }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      });
      request.on('error', reject);
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }
  return { dataDir, host, hosts, network, online, request, driverFactory, networkFactory, failure: () => failure() };
}

test('private network key persists, invalid keys fail closed, and locks have ownership', context => {
  const root = directory(context);
  const key = networkKey(root);
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.equal(networkKey(root), key);
  const release = acquireLock(root);
  assert.throws(() => acquireLock(root), /locked/);
  release(); release();
  const second = acquireLock(root);
  const lock = path.join(root, 'server.lock');
  fs.writeFileSync(lock, JSON.stringify({ token: 'another-owner' }));
  assert.throws(second, /ownership/);
  fs.writeFileSync(path.join(root, 'network.key'), 'invalid');
  assert.throws(() => networkKey(root), /Invalid network key/);
  const missing = path.join(root, 'missing-key');
  assert.throws(() => networkKey(root, { keyFile: missing }), /ENOENT/);
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => dataDirectory({ XDG_DATA_HOME: 'relative' }), /absolute/);
  assert.equal(dataDirectory({ XDG_DATA_HOME: root }), path.join(root, 'camellia-server'));
});

test('Linux private storage rejects permissive modes, symlinks and hardlinks', { skip: process.platform !== 'linux' }, context => {
  const root = directory(context);
  networkKey(root);
  const key = path.join(root, 'network.key');
  fs.chmodSync(key, 0o644);
  assert.throws(() => networkKey(root), /0700/);
  fs.chmodSync(key, 0o600);
  const hardlink = path.join(root, 'hardlink');
  fs.linkSync(key, hardlink);
  assert.throws(() => readPrivate(key), /not a link/);
  fs.unlinkSync(hardlink);
  const link = path.join(root, 'link');
  fs.symlinkSync(key, link);
  assert.throws(() => readPrivate(link), /not a link/);
  const linkedDir = path.join(root, 'linked-dir');
  fs.symlinkSync(root, linkedDir);
  assert.throws(() => privateDirectory(linkedDir), /symbolic/);
  fs.chmodSync(root, 0o755);
  assert.throws(() => privateDirectory(root), /0700/);
  fs.chmodSync(root, 0o700);
});

test('storage under a symlinked ancestor works while a linked storage directory is rejected', context => {
  const base = directory(context);
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  const link = path.join(base, 'link');
  // macOS resolves /tmp and /var under /private, so parent components of a data
  // directory are routinely symlinks; only the storage directory itself must be real.
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const storage = path.join(link, 'camellia-server');
  assert.equal(privateDirectory(storage), storage);
  const key = networkKey(storage);
  assert.equal(networkKey(storage), key);
  const release = acquireLock(storage);
  release();
  const linkedDir = path.join(base, 'self-link');
  fs.symlinkSync(storage, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => privateDirectory(linkedDir), /symbolic/);
});

test('headless host starts offline and retains workspaces and independent conversations across restart', async context => {
  const { host, hosts, dataDir, driverFactory, networkFactory } = harness(context);
  assert.equal((await host.command('state')).result.enabled, false);
  assert.throws(() => createHeadlessHost({ dataDir, driverFactory, networkFactory }), /locked/);
  const folder = path.join(dataDir, 'project'); fs.mkdirSync(folder);
  const created = await host.command('create-workspace', { name: 'Project', path: folder });
  assert.equal(created.ok, true);
  const workspaceId = created.workspace.id;
  const chat = await host.command('create-conversation', { workspaceId });
  const independent = await host.command('create-conversation');
  assert.equal(chat.result.workspaceId, workspaceId);
  assert.equal(independent.result.workspaceId, null);
  assert.equal((await host.command('create-conversation', { engine: 'codex' })).ok, false);
  assert.equal((await host.command('create-workspace', { name: 'Bad', path: 'relative' })).ok, false);
  await host.close();
  assert.equal(fs.existsSync(path.join(dataDir, 'server.lock')), false);
  assert.equal((await host.command('state')).ok, false);
  const reopened = createHeadlessHost({ dataDir, driverFactory, networkFactory });
  hosts.push(reopened);
  assert.equal((await reopened.command('conversations')).result.length, 2);
  assert.equal((await reopened.command('delete-workspace', { id: workspaceId })).ok, true);
  assert.equal(fs.existsSync(folder), true);
  assert.ok((await reopened.command('conversations')).result.every(item => item.workspaceId === null));
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations', chat.result.id + '.json'), 'utf8'));
  // Workspaces are stored by canonical path, and on macOS the temp directory is
  // reached through /var, which resolves to /private/var.
  assert.equal(saved.cwd, fs.realpathSync(folder));
});

test('headless network pairing requires local approval and revoked clients lose access', async context => {
  const { host, online, request } = harness(context);
  assert.equal((await host.command('invite')).ok, false);
  await online();
  assert.equal((await request('/v1/status', null, null, false)).status, 403);
  assert.equal((await request('/v1/status')).status, 401);
  const invitation = (await host.command('invite')).result;
  const pending = await request('/v1/pair/request', { code: invitation.code, name: 'Desktop GUI' });
  assert.equal(pending.status, 200);
  assert.equal((await request('/v1/pair/claim', pending.body)).body.state, 'pending');
  assert.equal((await host.command('approve', { id: pending.body.id })).ok, true);
  const claim = (await request('/v1/pair/claim', pending.body)).body;
  const status = await request('/v1/status', null, claim.token);
  assert.equal(status.status, 200);
  assert.equal(status.body.includeUnassigned, true);
  assert.ok(status.body.capabilities.includes('api-import'));
  assert.ok(status.body.capabilities.includes('native-settings'));
  const native = (await request('/v1/native-settings/codex', null, claim.token)).body;
  const nativeSave = { engine: 'codex', id: 'settings', revision: native.files[0].revision, text: 'web_search="cached"', confirmed: true };
  assert.equal((await request('/v1/native-settings/codex', nativeSave, claim.token)).body.ok, true);
  assert.match((await host.command('native-settings-get', { engine: 'codex' })).result.files[0].text, /cached/);
  assert.equal((await request('/v1/native-settings/codex', nativeSave, claim.token)).status, 409);
  const preview = await request('/v1/api-import', null, claim.token);
  const importRequest = { requestId: require('node:crypto').randomUUID(), expectedRevision: preview.body.revision,
    providers: [{ id: 'cloud-api', type: 'custom', baseUrl: 'https://api.example/v1', models: [{ id: 'test-model', upstream: 'test-model' }],
      keys: [{ id: 'cloud-key', key: 'synthetic-not-a-real-key' }] }] };
  const imported = await request('/v1/api-import', importRequest, claim.token);
  assert.equal(imported.body.added, 1);
  assert.deepEqual((await request('/v1/api-import', importRequest, claim.token)).body, imported.body);
  assert.equal((await host.command('set-model', { engine: 'dsh', model: 'test-model' })).ok, true);
  assert.equal((await host.command('state')).result.devices[0].name, 'Desktop GUI');
  await host.command('revoke', { id: claim.deviceId });
  assert.equal((await request('/v1/status', null, claim.token)).status, 401);
});

test('headless local socket handles commands without a second data writer', async context => {
  const { host, dataDir } = harness(context);
  const control = await listenControl({ dataDir, command: host.command });
  context.after(() => control.close());
  assert.equal((await requestControl(dataDir, 'state')).result.host, 'cli-preview');
  assert.equal((await requestControl(dataDir, 'create-conversation')).ok, true);
  assert.equal((await requestControl(dataDir, 'conversations')).result.length, 1);
  assert.equal((await requestControl(dataDir, 'not-a-command')).ok, false);
  if (process.platform === 'linux') assert.equal(fs.statSync(socketPath(dataDir)).mode & 0o777, 0o600);
});

test('headless shutdown waits for an in-flight local command before releasing the lock', async context => {
  const { host, dataDir, network } = harness(context);
  let resume;
  network.start = () => new Promise(resolve => { resume = resolve; });
  const starting = host.command('start');
  const stopping = host.close();
  assert.equal(fs.existsSync(path.join(dataDir, 'server.lock')), true);
  assert.equal((await host.command('state')).ok, false);
  resume(); await starting; await stopping;
  assert.equal(fs.existsSync(path.join(dataDir, 'server.lock')), false);
});

test('trusted-device restoration is opt-in and does not start a fresh unpaired server', async context => {
  const { host, network } = harness(context);
  let starts = 0;
  network.start = async () => { starts++; };
  await host.startTrustedDevices();
  assert.equal(starts, 0);
  assert.equal((await host.command('state')).result.enabled, false);
});

test('trusted-device restoration reuses authorization but never invokes interactive login', async context => {
  const { host, dataDir, driverFactory, networkFactory, hosts, network } = harness(context);
  await host.close();
  const file = path.join(dataDir, 'remote', 'devices.json');
  fs.writeFileSync(file, JSON.stringify({ devices: [{ id: 'trusted', name: 'GUI', tokenDigest: 'a'.repeat(64), permission: 'control', allWorkspaces: true, workspaceIds: [], includeUnassigned: true }] }));
  const reopened = createHeadlessHost({ dataDir, driverFactory, networkFactory }); hosts.push(reopened);
  let starts = 0, logins = 0;
  network.start = async () => { starts++; network.snapshot = { state: 'NeedsLogin' }; };
  network.login = async () => { logins++; };
  await reopened.startTrustedDevices();
  assert.equal(starts, 1); assert.equal(logins, 0);
  await reopened.command('stop');
  await reopened.startTrustedDevices();
  assert.equal(starts, 1);
});

test('trusted-device startup failure keeps the local console available for manual retry', async context => {
  const { host, dataDir, driverFactory, networkFactory, hosts, network } = harness(context);
  await host.close();
  fs.writeFileSync(path.join(dataDir, 'remote', 'devices.json'), JSON.stringify({ devices: [{ id: 'trusted', name: 'GUI', tokenDigest: 'a'.repeat(64), permission: 'control', allWorkspaces: true, workspaceIds: [] }] }));
  const reopened = createHeadlessHost({ dataDir, driverFactory, networkFactory }); hosts.push(reopened);
  network.start = async () => { throw new Error('Helper missing'); };
  await assert.rejects(reopened.startTrustedDevices(), /Helper missing/);
  const state = await reopened.command('settings');
  assert.equal(state.ok, true);
  assert.equal(state.result.enabled, false);
  assert.equal(state.result.network.state, 'Error');
  network.start = async () => { network.snapshot = { state: 'NeedsLogin' }; };
  assert.equal((await reopened.command('start')).ok, true);
});

test('live server settings expose counts not API keys and persist explicit local preferences', async context => {
  const { host, dataDir } = harness(context);
  const routeFile = path.join(dataDir, 'api-routes.json');
  const routerConfig = require('../src/api/api-router-config');
  routerConfig.writeConfig(routeFile, routerConfig.normalizeConfig({ enabled: false, providers: [{ id: 'api', type: 'custom', baseUrl: 'https://api.example/v1',
    models: [{ id: 'test-model', upstream: 'test-model' }], keys: [{ id: 'key', key: 'secret-not-for-settings-view' }] }] }));
  const settings = await host.command('settings');
  assert.equal(settings.ok, true);
  assert.equal(settings.result.api.keys, 1);
  assert.equal(settings.result.api.enabled, false);
  assert.deepEqual(settings.result.api.models, ['test-model']);
  assert.equal(JSON.stringify(settings).includes('secret-not-for-settings-view'), false);
  assert.equal((await host.command('set-language', { language: 'xx' })).ok, false);
  assert.equal((await host.command('set-language', { language: 'en' })).ok, true);
  assert.equal((await host.command('settings')).result.language, 'en');
  assert.equal((await host.command('set-api-enabled', { enabled: 'true' })).ok, false);
  assert.equal((await host.command('set-api-enabled', { enabled: true })).ok, true);
  const saved = routerConfig.loadConfig(routeFile);
  assert.equal(saved.enabled, true);
  assert.equal(saved.providers[0].keys[0].key, 'secret-not-for-settings-view');
});

test('server CLI help runs without Electron or a network connection', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/camellia-server.cjs'), '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Camellia/);
  assert.match(result.stdout, /DSH, Claude, Codex and Kimi/);
  assert.ok(!Object.keys(require.cache).some(file => /node_modules[\\/]electron[\\/]index/.test(file)));
});

test('Linux CLI foreground service starts without Electron, serves commands and shuts down cleanly', { skip: process.platform !== 'linux', timeout: 15000 }, async context => {
  const root = directory(context, false);
  const executable = path.resolve(__dirname, '../scripts/camellia-server.cjs');
  const child = spawn(process.execPath, [executable, 'serve', '--data-dir', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    removeTree(root);
  });
  await Promise.race([
    new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('Local control ready')) resolve(); })),
    exited.then(() => { throw new Error('Server exited before readiness: ' + errors); }),
  ]);
  assert.equal((await requestControl(root, 'state')).result.running, false);
  assert.equal((await requestControl(root, 'create-conversation')).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).dshChat.permissionMode, 'ask');
  const duplicate = spawnSync(process.execPath, [executable, 'serve', '--data-dir', root], { encoding: 'utf8', timeout: 5000 });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /locked/);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(fs.existsSync(path.join(root, 'server.lock')), false);
  assert.equal(fs.existsSync(socketPath(root)), false);
  assert.equal(errors, '');
});
