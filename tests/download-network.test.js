'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { downloadSettings, createDownloadConnection } = require('../src/main/download-network');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { createHarness } = require('./claude-harness.cjs');
const { BAD_PORTS } = require('./bad-ports.cjs');

async function networkFixture(t) {
  let requests = 0, tunnels = 0, forwarded = 0;
  const body = Buffer.from('fixture installer archive');
  const origin = http.createServer((_req, res) => { requests++; res.end(body); });
  // The origin port ends up in fetch() request URLs, so it must not be one of
  // the ports the fetch spec blocks.
  for (;;) {
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    if (!BAD_PORTS.has(origin.address().port)) break;
    await new Promise(resolve => origin.close(resolve));
  }
  // undici 8 proxies plain-HTTP targets as absolute-form requests instead of
  // CONNECT tunnels; HTTPS targets still tunnel. Answer both.
  const proxy = http.createServer((req, res) => {
    forwarded++;
    const upstream = http.request({ host: '127.0.0.1', port: origin.address().port, path: new URL(req.url).pathname }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  const sockets = new Set();
  proxy.on('connect', (_req, socket, head) => {
    tunnels++;
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    for (const stream of [socket, upstream]) {
      sockets.add(stream);
      stream.on('error', () => { socket.destroy(); upstream.destroy(); });
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    origin.closeAllConnections();
    await Promise.all([new Promise(resolve => origin.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  });
  return { body, url: `http://127.0.0.1:${origin.address().port}`, proxy: `http://127.0.0.1:${proxy.address().port}/`,
    requests: () => requests, tunnels: () => tunnels, forwarded: () => forwarded };
}

test('download preferences start empty, persist per profile, and reject invalid proxies', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  assert.deepEqual({ ...await h.call('download-settings') }, { ok: true, mode: 'direct', url: '' });
  assert.throws(() => downloadSettings({ mode: 'proxy', url: '' }), /Enter a proxy/);
  for (const url of ['local-proxy:7890', 'socks5://localhost:1080', 'https://example.com/settings', 'http://localhost:7890?token=x']) {
    assert.throws(() => downloadSettings({ mode: 'proxy', url }), /proxy address/);
  }
  const settings = { mode: 'proxy', url: 'http://proxy.example:8080/' };
  assert.equal((await h.call('download-save-settings', settings)).ok, true);
  assert.deepEqual({ ...await h.call('download-settings') }, { ok: true, ...settings });
  assert.equal((await h.call('download-save-settings', { mode: 'proxy', url: 'invalid' })).ok, false);
  assert.deepEqual({ ...await h.call('download-settings') }, { ok: true, ...settings }, 'Invalid edits must not replace saved preferences');
  const restored = createHarness(h.root);
  assert.deepEqual({ ...await restored.call('download-settings') }, { ok: true, ...settings });
});

test('explicit proxy and direct downloads use isolated connections and do not inherit conflicting proxies', async t => {
  const f = await networkFixture(t);
  const base = { HTTP_PROXY: 'http://unreachable.invalid:1', https_proxy: 'http://unreachable.invalid:2',
    ALL_PROXY: 'socks5://unreachable.invalid:3', no_proxy: '*', npm_config_proxy: 'http://unreachable.invalid:4',
    npm_config_https_proxy: 'http://unreachable.invalid:5', npm_config_noproxy: '*', PATH: 'fixture-path' };
  const before = { ...base };
  const proxy = createDownloadConnection({ mode: 'proxy', url: f.proxy }, base);
  const direct = createDownloadConnection({ mode: 'direct' }, base);
  t.after(async () => { await proxy.close(); await direct.close(); });
  assert.equal(await (await proxy.fetch('http://registry.invalid/archive', { signal: AbortSignal.timeout(3000) })).text(), f.body.toString());
  assert.equal(f.tunnels() + f.forwarded(), 1);
  assert.equal(await (await direct.fetch(f.url)).text(), f.body.toString());
  assert.equal(f.tunnels() + f.forwarded(), 1, 'Direct downloads must not reach the proxy');
  assert.equal(f.requests(), 2);
  assert.equal(proxy.env.HTTPS_PROXY, f.proxy);
  assert.equal(proxy.env.npm_config_https_proxy, f.proxy);
  assert.equal(proxy.env.npm_config_noproxy, 'localhost,127.0.0.1,::1');
  assert.equal(direct.env.HTTPS_PROXY, '');
  assert.equal(direct.env.npm_config_noproxy, '*');
  assert.equal(proxy.env.https_proxy, undefined);
  assert.equal(direct.env.ALL_PROXY, '');
  assert.deepEqual(base, before, 'The application environment stays unchanged');
});

test('CLI downloads respect proxy environment variables', async t => {
  const f = await networkFixture(t);
  const connection = createDownloadConnection(undefined, { HTTP_PROXY: f.proxy, NO_PROXY: '' });
  t.after(() => connection.close());
  assert.equal(await (await connection.fetch('http://registry.invalid/archive')).text(), f.body.toString());
  assert.equal(f.forwarded(), 1);
});

test('a broken selected proxy reports failure without falling back to a direct download', async t => {
  const f = await networkFixture(t);
  const broken = http.createServer();
  broken.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  await new Promise(resolve => broken.listen(0, '127.0.0.1', resolve));
  const connection = createDownloadConnection({ mode: 'proxy', url: `http://127.0.0.1:${broken.address().port}` });
  t.after(async () => { await connection.close(); await new Promise(resolve => broken.close(resolve)); });
  await assert.rejects(connection.fetch(f.url, { signal: AbortSignal.timeout(3000) }));
  assert.equal(f.requests(), 0);
});

test('Antigravity bootstrap and both uv download commands use the chosen connection', async t => {
  const f = await networkFixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-download-test-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'runtimes/antigravity'), target = path.join(root, 'installed');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'runtime.json'), JSON.stringify({ sdk: 'fixture', python: '3.13', platforms: {
    [process.platform + '-' + process.arch]: { uv: 'uv', python: 'python', archive: 'uv.whl',
      url: 'http://registry.invalid/uv.whl', sha256: createHash('sha256').update(f.body).digest('hex') },
  } }));
  fs.writeFileSync(path.join(source, 'requirements.lock'), 'fixture');
  const commands = [];
  const manager = createRuntimeManager({ root, installRoot: target, downloadOptions: () => ({ mode: 'proxy', url: f.proxy }),
    runCommand: async (exe, args, options) => {
      commands.push({ exe, args, options });
      const dir = path.join(target, 'runtimes/antigravity');
      if (exe === 'tar') fs.writeFileSync(path.join(dir, 'installer/uv'), '');
      else if (args[0] === 'python') { fs.mkdirSync(path.join(dir, 'python')); fs.writeFileSync(path.join(dir, 'python/python'), ''); }
      else if (args[0] === 'pip') { fs.mkdirSync(path.join(dir, 'packages/google/antigravity'), { recursive: true }); fs.writeFileSync(path.join(dir, 'packages/google/antigravity/__init__.py'), ''); }
    } });
  assert.equal((await manager.ensure('antigravity')).version, 'fixture');
  assert.equal(f.tunnels() + f.forwarded(), 1, 'The Python installer download goes through the proxy');
  const uvCommands = commands.filter(command => ['python', 'pip'].includes(command.args[0]));
  assert.equal(uvCommands.length, 2);
  for (const command of uvCommands) assert.equal(command.options.env.HTTPS_PROXY, f.proxy);
  assert.ok(manager.state().filter(row => row.id !== 'antigravity').every(row => row.status === 'missing'));
});

test('canceling download confirmation creates no runtime files or failed status', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-download-test-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const manager = createRuntimeManager({ root, installRoot: root,
    downloadOptions: () => { throw Object.assign(new Error('Download cancelled'), { code: 'DOWNLOAD_CANCELLED' }); } });
  await assert.rejects(manager.ensure('kimi'), { code: 'DOWNLOAD_CANCELLED' });
  assert.deepEqual(fs.readdirSync(root), []);
  assert.ok(manager.state().every(row => row.status === 'missing'));
});
