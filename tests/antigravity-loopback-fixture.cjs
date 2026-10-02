'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');

async function main() {
  const host = process.argv[2];
  assert.ok(['127.0.0.1', '::1'].includes(host));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-loopback-'));
  const requests = [], conversationId = randomUUID();
  const server = require('node:http').createServer(async (req, res) => {
    for await (const _ of req) { /* Drain the request before closing the fixture. */ }
    const method = req.url.split('/').at(-1);
    requests.push({ method, csrf: req.headers['x-codeium-csrf-token'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(method === 'GetCascadeModelConfigData'
      ? { clientModelConfigs: [{ modelId: 'fixture', modelOrAlias: { model: 'FIXTURE' } }] }
      : { cascadeId: conversationId }));
  });
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host, port: 0, ipv6Only: host === '::1' }, resolve); });
    const file = require.resolve('../src/engines/antigravity/cli-interactive.cjs');
    const nativeRequire = require('node:module').createRequire(file), loaded = { exports: {} };
    const load = name => name === 'node:child_process' ? { spawn(exe) {
      assert.equal(exe, process.platform === 'win32' ? 'fixture-cli' : process.platform === 'darwin' ? '/bin/sh' : '/usr/bin/script');
      fs.writeFileSync(bridge.logFile, `Language server listening on random port at ${server.address().port} for HTTP\n`);
      return child;
    } } : nativeRequire(name);
    require('node:vm').compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports'], { filename: file })(load, loaded, loaded.exports);
    const bridge = new loaded.exports.InteractiveCli({ exe: 'fixture-cli', home: root, model: 'fixture' }, () => {});
    bridge.session = { id: 'agy-' + randomUUID(), cwd: root };
    bridge.file = path.join(root, 'session.json');
    const result = await bridge.start();
    assert.equal(result.conversationId, conversationId);
    assert.deepEqual(requests.map(row => row.method), ['GetCascadeModelConfigData', 'StartCascade']);
    assert.ok(requests.every(row => row.csrf === bridge.csrf));
    assert.equal(JSON.parse(fs.readFileSync(bridge.file, 'utf8')).conversationId, conversationId);
  } finally {
    child.stdout.destroy(); child.stderr.destroy(); child.emit('close', 0);
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    require('./test-fs.cjs').removeTree(root);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
