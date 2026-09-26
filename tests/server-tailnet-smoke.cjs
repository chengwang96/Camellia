'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EmbeddedNetwork, loginURL } = require('../src/main/remote/embedded-network');
const { networkKey } = require('../src/cli/private-storage');

async function main() {
  if (process.platform !== 'linux') throw new Error('Run on Linux');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tailnet-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  const failures = [];
  const network = new EmbeddedNetwork({ directory, executable: path.resolve(process.argv[2]), hostname: 'camellia-server-test',
    keyProvider: directory => networkKey(directory), onFailure: () => failures.push('failure') });
  try {
    await network.start(); await network.status();
    const key = fs.readFileSync(path.join(directory, 'network.key'));
    await network.login();
    const deadline = Date.now() + 45000;
    let state;
    do {
      state = await network.status();
      if (state.loginUrl) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    assert.ok(loginURL(state.loginUrl), 'Official login URL must be returned; no account is authorized by this test');
    await network.stop(); await network.start(); await network.status();
    assert.deepEqual(fs.readFileSync(path.join(directory, 'network.key')), key);
    assert.deepEqual(failures, []);
    assert.ok(fs.readdirSync(directory).some(file => file.endsWith('.state')));
    console.log('PASS: Linux embedded Tailscale login URL, encrypted identity persistence and restart; no account authorized');
  } finally { await network.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
