'use strict';
// Pinned CLI protocol check in an empty account home. No real credentials,
// browser login, external model calls, or desktop interaction.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKimiAccount } = require('../src/engines/kimi-account');

async function main() {
  const runtime = path.resolve(__dirname, '../runtimes/kimi/node_modules/@moonshot-ai/kimi-code/dist/main.mjs');
  assert.ok(fs.existsSync(runtime), 'Install the pinned Kimi runtime first');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-subscription-smoke-'));
  const home = path.join(root, 'kimi'); fs.mkdirSync(home);
  const account = createKimiAccount({ home, runtime: () => ({ file: runtime }), ensureRuntime: async () => {}, node: () => process.execPath,
    environment: () => ({ ...process.env, HOME: root, USERPROFILE: root }),
  });
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), require('smol-toml').stringify({ telemetry: false, default_model: 'kimi-code/fixture',
      providers: { 'managed:kimi-code': { type: 'kimi', base_url: 'https://api.kimi.com/coding', api_key: '', oauth: { storage: 'file', key: 'oauth/kimi-code' } } },
      models: { 'kimi-code/fixture': { provider: 'managed:kimi-code', model: 'fixture', max_context_size: 131072 } },
    }));
    const missing = await account.refresh();
    assert.equal(missing.account, null); assert.deepEqual(missing.models, []); assert.ok(missing.error);
    const logout = await account.signOut();
    assert.equal(logout.account, null); assert.equal(logout.error, null);
    const config = require('smol-toml').parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
    assert.equal(config.providers?.['managed:kimi-code'], undefined);
    console.log('PASS pinned Kimi 0.43.1: ACP rejects an unsigned account and native logout removes its managed profile; no login or model calls');
  } finally {
    await account.shutdown();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kimi-subscription-smoke-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
