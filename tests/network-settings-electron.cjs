'use strict';

// Exercise Chromium's actual proxy-rule parser, without user data or internet.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  if (!process.versions.electron) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-proxy-rules-'));
    const env = { ...process.env, CAMELLIA_PROXY_TEST_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'pipe', windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      console.log(output.trim());
    } finally {
      clearTimeout(timer);
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('camellia-proxy-rules-'));
      removeTree(root);
    }
    return;
  }
  const { app, session } = require('electron');
  app.setPath('userData', process.env.CAMELLIA_PROXY_TEST_ROOT);
  app.disableHardwareAcceleration();
  await app.whenReady();
  const requests = [];
  const proxy = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Connection', 'close');
    res.end('through proxy');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = '127.0.0.1:' + proxy.address().port;
  const { createNetworkSettings } = require('../src/main/network-settings');
  const config = {};
  const service = createNetworkSettings({
    loadConfig: () => config, saveConfig: value => Object.assign(config, value),
    sessions: () => ({ defaultSession: session.defaultSession,
      fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'PROXY ' + address }),
    }),
    applyEnvironment: () => {},
    providerTargetsImpl: () => [{ host: 'api.example.invalid', port: 443 }],
    probeImpl: async targets => targets.map(target => ({ ...target, direct: false, proxy: true })),
    createFallback: async () => ({ url: 'http://' + address + '/', close() {} }),
  });
  try {
    for (const mode of ['system', 'auto', 'prefer-direct']) {
      await service.save({ mode });
      const target = 'http://camellia-proxy-test.invalid/' + mode;
      const response = await session.defaultSession.fetch(target, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'through proxy');
      assert.equal(requests.at(-1), target);
      console.log('PASS: Chromium routes ' + mode + ' through the local proxy');
    }
    assert.equal(requests.length, 3);
  } finally {
    service.close();
    await session.defaultSession.closeAllConnections();
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
    app.quit();
  }
}

main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
