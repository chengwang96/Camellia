'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loginURL, storageKey, EmbeddedNetwork } = require('../src/main/remote/embedded-network');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { removeTree } = require('./test-fs.cjs');

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
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, process.execPath);
      assert.equal(options.env.TS_NO_LOGS_NO_SUPPORT, 'true');
      return child;
    } });
  await network.start();
  assert.deepEqual(requests[0], { directory, key, id: 1, action: 'init' });
  await network.stop();
  assert.equal(network.child, null);
  assert.equal(fs.existsSync(path.join(directory, 'key.enc')), false);
  const invalid = new EmbeddedNetwork({ directory, executable: process.execPath, keyProvider: () => 'invalid',
    spawnProcess: () => assert.fail('Invalid key must not spawn a helper') });
  await assert.rejects(invalid.start(), /Invalid embedded network storage key/);
});

test('embedded outgoing connections are disposed on disconnect and helper shutdown', async () => {
  const network = new EmbeddedNetwork({});
  const calls = [];
  const child = new EventEmitter();
  child.stdin = { end: () => child.emit('exit', 0) };
  child.kill = () => {};
  network.child = child;
  network.request = async (action, payload) => {
    calls.push({ action, payload });
    return action === 'connect' ? { url: 'http://127.0.0.1:12345' } : null;
  };
  const first = await network.connect('http://100.80.1.2:43127');
  assert.match(calls[0].payload.token, /^[a-f0-9]{64}$/);
  await first.close();
  assert.equal(calls[1].action, 'disconnect');
  assert.equal(network.connections.size, 0);
  const second = await network.connect('http://100.80.1.3:43127');
  await network.stop();
  assert.equal(second.closed, true);
  assert.equal(network.connections.size, 0);
  assert.equal(calls.length, 3);
  await assert.rejects(network.connect('http://127.0.0.1:43127'), /Tailscale/);
  await assert.rejects(network.connect('http://100.80.1.2:43127'), /Start and sign/);
});

test('headless hostname is validated before any helper process starts', () => {
  for (const hostname of ['-bad', 'bad-', 'bad.name', 'UPPER', 'bad\nname', 'a'.repeat(64), 123]) {
    assert.throws(() => new EmbeddedNetwork({ hostname }), /hostname/);
  }
  assert.equal(new EmbeddedNetwork({ hostname: 'gpu-lab-01' }).hostname, 'gpu-lab-01');
});
