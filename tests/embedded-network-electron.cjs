'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EmbeddedNetwork, loginURL } = require('../src/main/remote/embedded-network');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  if (process.versions.electron) {
    const { app, safeStorage } = require('electron');
    const root = process.env.TAILNET_TEST_ROOT;
    app.setPath('userData', root);
    app.disableHardwareAcceleration();
    await app.whenReady();
    const failures = [];
    const network = new EmbeddedNetwork({ app, safeStorage, openExternal: async () => { throw new Error('Test must not open browser'); }, onFailure: () => failures.push('unexpected exit') });
    try {
      assert.equal(safeStorage.isEncryptionAvailable(), true);
      await network.start();
      const status = await network.status();
      assert.ok(['NeedsLogin', 'Starting', 'NoState', 'Stopped'].includes(status.state), status.state);
      if (process.env.TAILNET_TEST_LOGIN === '1') {
        await network.login();
        const deadline = Date.now() + 45000;
        let login;
        while (Date.now() < deadline) {
          login = await network.status();
          if (login.loginUrl) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.ok(loginURL(login.loginUrl), 'Official login URL returned without authorizing account');
        console.log('PASS: official browser login URL obtained (not opened, no account authorized)');
      }
      const child = network.child;
      await network.stop();
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'Helper exits on stdin EOF');
      const directory = path.join(root, 'remote', 'tailnet');
      const encryptedKey = fs.readFileSync(path.join(directory, 'key.enc'));
      const secret = safeStorage.decryptString(encryptedKey);
      assert.equal(Buffer.from(secret, 'base64').length, 32);
      assert.ok(!encryptedKey.includes(Buffer.from(secret)));
      assert.ok(fs.readdirSync(directory).some(name => name.endsWith('.state')), 'Node state is persisted');
      await network.start();
      await network.status();
      assert.ok(fs.readFileSync(path.join(directory, 'key.enc')).equals(encryptedKey), 'Restart retains identity encryption key');
      assert.deepEqual(failures, []);
      const terminated = network.child;
      const exited = new Promise(resolve => terminated.once('exit', resolve));
      terminated.kill();
      await exited;
      assert.equal(network.snapshot.state, 'Error');
      assert.deepEqual(failures, ['unexpected exit']);
      console.log('PASS: real Electron secure storage, native helper startup/status/restart, EOF shutdown and crash handling');
    } finally { await network.stop(); }
    app.quit();
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tailnet-test-'));
  const env = { ...process.env, TAILNET_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => child.kill(), 100000);
  try { assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0); }
  finally {
    clearTimeout(timer);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-tailnet-test-'));
    removeTree(root);
  }
}

main().catch(error => { console.error(error); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
