'use strict';
const { removeTree } = require('./test-fs.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { downloadSettings, createDownloadConnection, chooseDownloadConnection } = require('../src/main/download-network');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { createHarness } = require('./main-process-harness.cjs');
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

async function speedFixture(t) {
  const body = Buffer.alloc(1024 * 1024, 7);
  let originRequests = 0, proxyRequests = 0;
  const origin = http.createServer((_req, res) => {
    originRequests++;
    res.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  for (;;) {
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    if (!BAD_PORTS.has(origin.address().port)) break;
    await new Promise(resolve => origin.close(resolve));
  }
  // HTTP proxy requests use absolute-form URLs. This fixture answers slowly so
  // the direct route wins without needing a real external network.
  const proxy = http.createServer((req, res) => {
    proxyRequests++;
    if (req.url.includes('/fail')) { res.statusCode = 502; res.end('proxy failed'); return; }
    const length = 512 * 1024;
    res.writeHead(200, { 'content-length': length, 'content-type': 'application/octet-stream' });
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= length) { clearInterval(timer); res.end(); return; }
      res.write(body.subarray(offset, Math.min(length, offset + 16 * 1024)));
      offset += 16 * 1024;
    }, 5);
    req.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    origin.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => origin.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  });
  return { body, url: `http://127.0.0.1:${origin.address().port}/archive`,
    proxy: `http://127.0.0.1:${proxy.address().port}/`,
    originRequests: () => originRequests, proxyRequests: () => proxyRequests };
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

test('harness downloads compare direct and proxy routes and use the clearly faster one', async t => {
  const f = await speedFixture(t);
  const choice = await chooseDownloadConnection({ mode: 'proxy', url: f.proxy }, { probeUrl: f.url });
  t.after(() => choice.connection.close());
  assert.equal(choice.route, 'direct');
  assert.deepEqual(choice.results.map(result => [result.route, result.ok]).sort(), [['direct', true], ['proxy', true]]);
  assert.equal(choice.connection.env.HTTPS_PROXY, '');
  assert.equal(f.originRequests(), 1);
  assert.equal(f.proxyRequests(), 1);
  assert.equal((await (await choice.connection.fetch(f.url)).arrayBuffer()).byteLength, f.body.length);
});

test('a direct speed-test failure keeps the configured proxy for the download', async t => {
  const f = await speedFixture(t);
  const choice = await chooseDownloadConnection({ mode: 'proxy', url: f.proxy }, { probeUrl: 'http://registry.invalid/archive' });
  t.after(() => choice.connection.close());
  assert.equal(choice.route, 'proxy');
  assert.equal(choice.connection.env.HTTPS_PROXY, f.proxy);
  const routes = Object.fromEntries(choice.results.map(result => [result.route, result.ok]));
  assert.deepEqual(routes, { direct: false, proxy: true });
});

test('a failed speed test falls back to the saved connection instead of silently changing it', async t => {
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const probeUrl = `http://127.0.0.1:${closed.address().port}/archive`;
  await new Promise(resolve => closed.close(resolve));
  const broken = http.createServer((_req, res) => { res.statusCode = 502; res.end('proxy failed'); });
  for (;;) {
    await new Promise(resolve => broken.listen(0, '127.0.0.1', resolve));
    if (!BAD_PORTS.has(broken.address().port)) break;
    await new Promise(resolve => broken.close(resolve));
  }
  t.after(async () => { broken.closeAllConnections(); await new Promise(resolve => broken.close(resolve)); });
  const proxy = `http://127.0.0.1:${broken.address().port}/`;
  const choice = await chooseDownloadConnection({ mode: 'proxy', url: proxy }, { probeUrl });
  t.after(() => choice.connection.close());
  assert.equal(choice.route, 'proxy');
  assert.equal(choice.connection.env.HTTPS_PROXY, proxy);
  assert.ok(choice.results.every(result => !result.ok));
});

test('direct downloads skip the speed test entirely', async t => {
  const f = await speedFixture(t);
  const choice = await chooseDownloadConnection({ mode: 'direct', url: '' }, { probeUrl: f.url });
  t.after(() => choice.connection.close());
  assert.equal(choice.route, 'direct');
  assert.deepEqual(choice.results, []);
  assert.equal(f.originRequests() + f.proxyRequests(), 0);
});

test('speed selection keeps the saved proxy unless direct is clearly faster', async () => {
  const connections = [];
  const create = settings => {
    const connection = { settings, env: {}, closed: false, close() { connection.closed = true; } };
    connections.push(connection);
    return connection;
  };
  let directSpeed = 110, proxySpeed = 100;
  const probe = async connection => ({
    bytes: 256 * 1024,
    ms: 1000,
    bytesPerSecond: connection.settings.mode === 'direct' ? directSpeed : proxySpeed,
  });
  const settings = { mode: 'proxy', url: 'http://proxy.example/' };
  const inspect = (choice, route) => {
    const direct = connections.findLast(connection => connection.settings.mode === 'direct');
    const proxy = connections.findLast(connection => connection.settings.mode === 'proxy');
    assert.equal(choice.connection.closed, false);
    assert.equal((route === 'proxy' ? direct : proxy).closed, true, 'The unused route is closed');
    choice.connection.close();
  };
  const marginal = await chooseDownloadConnection(settings, { probeUrl: 'http://artifact.invalid/file', create, probe });
  assert.equal(marginal.route, 'proxy');
  inspect(marginal, 'proxy');
  directSpeed = 140;
  const clear = await chooseDownloadConnection(settings, { probeUrl: 'http://artifact.invalid/file', create, probe });
  assert.equal(clear.route, 'direct');
  inspect(clear, 'direct');
});

test('Antigravity bootstrap and both uv download commands use the chosen connection', async t => {
  const f = await networkFixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-download-test-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); removeTree(root); });
  const source = path.join(root, 'runtimes/antigravity'), target = path.join(root, 'installed');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'runtime.json'), JSON.stringify({ sdk: 'fixture', python: '3.13', platforms: {
    [process.platform + '-' + process.arch]: { uv: 'uv', python: 'python', archive: 'uv.whl',
      url: 'http://registry.invalid/uv.whl', sha256: createHash('sha256').update(f.body).digest('hex') },
  } }));
  fs.writeFileSync(path.join(source, 'requirements.lock'), 'fixture');
  const commands = [];
  const manager = createRuntimeManager({ root, installRoot: target, discoverLocal: false, downloadOptions: () => ({ mode: 'proxy', url: f.proxy }),
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
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); removeTree(root); });
  const manager = createRuntimeManager({ root, installRoot: root, discoverLocal: false,
    downloadOptions: () => { throw Object.assign(new Error('Download cancelled'), { code: 'DOWNLOAD_CANCELLED' }); } });
  await assert.rejects(manager.ensure('kimi'), { code: 'DOWNLOAD_CANCELLED' });
  assert.deepEqual(fs.readdirSync(root), []);
  assert.ok(manager.state().every(row => row.status === 'missing'));
});
