'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loginURL, storageKey, EmbeddedNetwork, promoteHelper, embeddedNetworkEnvironment, EMBEDDED_NETWORK_ENV } = require('../src/main/remote/embedded-network');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { removeTree } = require('./test-fs.cjs');

test('a staged network helper replaces the previous binary and consumes its staging file', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnet-update-'));
  context.after(() => removeTree(directory));
  const executable = path.join(directory, 'camellia-tailnet.exe');
  fs.writeFileSync(executable, 'previous helper');
  fs.writeFileSync(executable + '.pending', 'updated helper');
  assert.equal(promoteHelper(executable), executable);
  assert.equal(fs.readFileSync(executable, 'utf8'), 'updated helper');
  assert.equal(fs.existsSync(executable + '.pending'), false);
  assert.equal(promoteHelper(executable), executable);
  assert.equal(fs.readFileSync(executable, 'utf8'), 'updated helper');
});

test('embedded network only opens official HTTPS login links', () => {
  assert.equal(loginURL('https://login.tailscale.com/a/example'), 'https://login.tailscale.com/a/example');
  for (const url of ['http://login.tailscale.com/a', 'https://login.tailscale.com.evil.test/a', 'https://evil.test', 'file:///C:/Windows', 'javascript:alert(1)', 'https://user@login.tailscale.com/a', 'https://login.tailscale.com:444/a', null]) {
    assert.equal(loginURL(url), null, url);
  }
});

test('embedded key persistence requires secure OS storage and survives restart', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnet-key-'));
  context.after(() => removeTree(directory));
  let encrypted;
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
    encryptString: value => { encrypted = value; return Buffer.from('OS-encrypted-key'); },
    decryptString: value => { assert.equal(value.toString(), 'OS-encrypted-key'); return encrypted; } };
  const key = storageKey(directory, storage);
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.equal(storageKey(directory, storage), key);
  assert.ok(!fs.readFileSync(path.join(directory, 'key.enc'), 'utf8').includes(key));
  assert.throws(() => storageKey(directory, { ...storage, isEncryptionAvailable: () => false }), /Secure system storage/);
  assert.throws(() => storageKey(directory, { ...storage, getSelectedStorageBackend: () => 'basic_text' }), /Secure system storage/);
  assert.throws(() => storageKey(directory, { ...storage, decryptString: () => 'bad-key' }), /Invalid embedded/);
});

test('embedded networking accepts a headless key provider without an Electron app', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-network-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  context.after(() => removeTree(directory));
  const requests = [];
  const key = Buffer.alloc(32, 7).toString('base64');
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const request = JSON.parse(chunk.toString()); requests.push(request);
    child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'); callback();
  } });
  child.stdin.on('finish', () => child.emit('exit', 0));
  const network = new EmbeddedNetwork({ directory, executable: process.execPath,
    keyProvider: target => { assert.equal(target, directory); return key; },
    hostname: () => 'work-pc',
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, process.execPath);
      assert.equal(options.env.TS_NO_LOGS_NO_SUPPORT, 'true');
      assert.equal(options.env.TS_DISABLE_FEATURE, 'useproxy');
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) {
        assert.equal(options.env[key], '', key);
      }
      for (const key of ['NO_PROXY', 'no_proxy', 'npm_config_noproxy']) assert.equal(options.env[key], '*', key);
      return child;
    } });
  await network.start();
  assert.deepEqual(requests[0], { directory, key, hostname: 'work-pc', id: 1, action: 'init' });
  await network.stop();
  assert.equal(network.child, null);
  assert.equal(fs.existsSync(path.join(directory, 'key.enc')), false);
  const invalid = new EmbeddedNetwork({ directory, executable: process.execPath, keyProvider: () => 'invalid',
    spawnProcess: () => assert.fail('Invalid key must not spawn a helper') });
  await assert.rejects(invalid.start(), /Invalid embedded network storage key/);
});

test('the embedded network never inherits a model or system proxy', () => {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'npm_config_proxy', 'npm_config_https_proxy', 'NO_PROXY', 'no_proxy', 'npm_config_noproxy'];
  const env = embeddedNetworkEnvironment({ PATH: 'keep-me', TS_AUTHKEY: 'remove-me', TSNET_FORCE_LOGIN: '1',
    HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897',
      ALL_PROXY: 'socks5://127.0.0.1:7898', http_proxy: 'http://127.0.0.1:7897',
      https_proxy: 'http://127.0.0.1:7897', all_proxy: 'socks5://127.0.0.1:7898',
      npm_config_proxy: 'http://127.0.0.1:7897', npm_config_https_proxy: 'http://127.0.0.1:7897',
      NO_PROXY: 'localhost', no_proxy: 'localhost', npm_config_noproxy: 'localhost' });
  for (const name of names) assert.equal(env[name], EMBEDDED_NETWORK_ENV[name], name);
  assert.equal(env.PATH, 'keep-me');
  assert.equal(env.TS_AUTHKEY, undefined);
  assert.equal(env.TSNET_FORCE_LOGIN, undefined);
});

test('headless hostname is validated before any helper process starts', () => {
  for (const hostname of ['-bad', 'bad-', 'bad.name', 'UPPER', 'bad\nname', 'a'.repeat(64), 123]) {
    assert.throws(() => new EmbeddedNetwork({ hostname }), /hostname/);
  }
  assert.equal(new EmbeddedNetwork({ hostname: 'gpu-lab-01' }).hostname, 'gpu-lab-01');
  const changing = new EmbeddedNetwork({ hostname: () => 'first-node' });
  assert.equal(typeof changing.hostname, 'function');
});

test('the helper receives a DNS label and can be given a lazily read name', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-hostname-'));
  context.after(() => removeTree(directory));
  const requests = [];
  const key = Buffer.alloc(32, 7).toString('base64');
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', 0);
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const request = JSON.parse(chunk.toString()); requests.push(request);
      child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'); callback();
    } });
    child.stdin.on('finish', () => child.emit('exit', 0));
    return child;
  };
  let name = 'initial-name';
  const network = new EmbeddedNetwork({ directory, executable: process.execPath,
    keyProvider: () => key, hostname: () => name,
    spawnProcess });
  await network.start();
  assert.equal(requests[0].hostname, 'initial-name');
  name = 'second-name';
  await network.stop();
  await network.start();
  assert.equal(requests[1].hostname, 'second-name');
  await network.stop();
});

test('embedded status preserves control-plane health diagnostics', async () => {
  const network = new EmbeddedNetwork({});
  network.child = {};
  network.request = async action => {
    assert.equal(action, 'status');
    return { state: 'Running', address: '100.80.1.2', deviceId: 'node', hostName: 'work-pc',
      online: true, health: ['Control plane is reconnecting'], selfUserId: '42',
      selfLoginName: 'me@example.com', selfDisplayName: 'Me', tailnet: 'example.ts.net' };
  };
  assert.deepEqual(await network.status(), { state: 'Running', loginUrl: null, address: '100.80.1.2',
    deviceId: 'node', hostName: 'work-pc', online: true, health: ['Control plane is reconnecting'],
    selfUserId: '42', selfLoginName: 'me@example.com', selfDisplayName: 'Me', tailnet: 'example.ts.net' });
});

test('embedded hostname changes use the helper and refresh the cached identity', async () => {
  const network = new EmbeddedNetwork({});
  const requests = [];
  network.child = {};
  network.snapshot = { state: 'Running', address: '100.80.1.2', deviceId: 'node', hostName: 'old-name' };
  network.request = async (action, payload) => { requests.push({ action, payload }); return { hostName: payload.hostname }; };
  assert.deepEqual(await network.setHostname('new-name'), { hostName: 'new-name' });
  assert.deepEqual(requests, [{ action: 'set-hostname', payload: { hostname: 'new-name' } }]);
  assert.equal(network.identity().hostName, 'new-name');
  network.child = null;
  assert.deepEqual(await network.setHostname('ignored'), { hostName: '' });
});
