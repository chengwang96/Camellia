'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loginURL, storageKey } = require('../src/main/remote/embedded-network');
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
