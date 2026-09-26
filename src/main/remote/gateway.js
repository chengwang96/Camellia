'use strict';

const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { fail } = require('./access');
const { isTailscaleIPv4 } = require('./tailscale');
const { listArtifacts, openArtifact } = require('./artifacts');
const { pipeline } = require('node:stream/promises');

function number(value, fallback) {
  if (value === null) return fallback;
  if (!/^\d{1,12}$/.test(value) || !Number.isSafeInteger(Number(value))) fail(400, 'Invalid pagination cursor');
  return Number(value);
}
async function body(request, limit = 4096) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) fail(415, 'JSON body required');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
}

class RemoteGateway {
  constructor({ access, reader, commands, apiRoutes = null, apiImport = null, nativeSettings = null, validateHost = isTailscaleIPv4 }) {
    Object.assign(this, { access, reader, commands, apiRoutes, apiImport, nativeSettings, validateHost });
    this.streams = new Set();
    this.downloads = new Set();
    this.sequence = 0;
    this.rate = new Map();
    this.server = null;
  }
  async start(host, port = 43127, transport = null) {
    if (this.server) throw new Error('Remote access is already running');
    if (transport) {
      if (host !== '127.0.0.1' || port !== 0 || !isTailscaleIPv4(transport.address) || !/^[a-f0-9]{64}$/.test(transport.token)) throw new Error('Invalid embedded transport');
    } else if (!this.validateHost(host)) throw new Error('Remote access must bind to the local Tailscale IPv4 address');
    this.transport = transport;
    this.instanceId = randomUUID();
    this.sequence = 0;
    const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => {
      void this.handle(request, response).catch(error => {
        if (response.headersSent || response.destroyed) { response.destroy(); return; }
        this.json(response, error.status || 500, { error: error.status ? error.message : 'Remote request failed' });
      });
    });
    server.maxConnections = 64;
    server.on('connection', socket => socket.setTimeout(30_000, () => socket.destroy()));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port, exclusive: true }, resolve);
    });
    this.server = server;
    this.authority = transport ? `${transport.address}:43127` : `${host}:${server.address().port}`;
    this.url = `http://${this.authority}`;
    this.heartbeat = setInterval(() => {
      for (const stream of this.streams) {
        try {
          if (stream.id) this.reader.conversation(stream.device, stream.id);
          if (!stream.blocked) stream.blocked = !stream.response.write(': heartbeat\n\n');
        } catch { stream.response.end(); }
      }
    }, 10_000);
    this.heartbeat.unref();
    return this.url;
  }
  json(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  }
  stamp() { return { instanceId: this.instanceId, cursor: this.sequence }; }
  throttle(request, pairing) {
    const now = Date.now();
    for (const [key, entry] of this.rate) if (entry.until <= now) this.rate.delete(key);
    const key = `${this.transport ? request.headers['x-camellia-peer'] : request.socket.remoteAddress}:${pairing ? 'pair' : 'read'}`;
    const entry = this.rate.get(key) || { until: now + 60_000, count: 0 };
    if (!this.rate.has(key) && this.rate.size >= 1024) fail(429, 'Too many clients');
    this.rate.set(key, entry);
    if (++entry.count > (pairing ? 30 : 300)) fail(429, 'Too many requests; retry in one minute');
  }
  async handle(request, response) {
    if (this.transport) {
      const token = Buffer.from(request.headers['x-camellia-transport'] || '');
      const expected = Buffer.from(this.transport.token);
      if (request.socket.remoteAddress !== '127.0.0.1' || token.length !== expected.length || !timingSafeEqual(token, expected)) fail(403, 'Embedded transport required');
    }
    if (request.headers.host !== this.authority || request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Only direct app connections are allowed');
    const url = new URL(request.url, this.url);
    if (url.origin !== this.url) fail(400, 'Invalid request target');
    const pairing = url.pathname === '/v1/pair/request' || url.pathname === '/v1/pair/claim';
    this.throttle(request, pairing);
    if (pairing) {
      if (request.method !== 'POST' || url.search) fail(405, 'POST required');
      const payload = await body(request);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'JSON object required');
      const result = url.pathname.endsWith('/request') ? this.access.request(payload) : this.access.claim(payload.id, payload.claim);
      this.json(response, 200, result);
      return;
    }
    const authorization = request.headers.authorization || '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail(401, 'Device authentication required');
    const device = this.access.authenticate(authorization.slice(7));
    const native = /^\/v1\/native-settings\/(claude|codex|kimi|dsh|antigravity)$/.exec(url.pathname);
    if (native && this.nativeSettings) {
      if (device.permission !== 'control' || device.allWorkspaces !== true) fail(403, 'Full-device control permission required');
      if (url.search || !['GET', 'POST'].includes(request.method)) fail(400, 'Invalid native settings request');
      if (request.method === 'GET') this.json(response, 200, this.nativeSettings.get(native[1]));
      else {
        const payload = await body(request, 1024 * 1024);
        const current = this.access.authenticate(authorization.slice(7));
        if (current.permission !== 'control' || current.allWorkspaces !== true) fail(403, 'Full-device control permission required');
        if (payload?.engine !== native[1]) fail(400, 'Native settings engine mismatch');
        this.json(response, 200, this.nativeSettings.save(payload));
      }
      return;
    }
    if (url.pathname === '/v1/api-import' && this.apiImport) {
      if (device.permission !== 'control' || device.allWorkspaces !== true) fail(403, 'Full-device control permission required');
      if (url.search || !['GET', 'POST'].includes(request.method)) fail(400, 'Invalid import request');
      if (request.method === 'GET') this.json(response, 200, this.apiImport.state());
      else {
        const payload = await body(request, 1024 * 1024);
        const current = this.access.authenticate(authorization.slice(7));
        if (current.permission !== 'control' || current.allWorkspaces !== true) fail(403, 'Full-device control permission required');
        this.json(response, 200, this.apiImport.apply(current.id, payload));
      }
      return;
    }
    const read = /^\/v1\/conversations\/([a-f0-9-]{36})\/read$/.exec(url.pathname);
    if (read && request.method === 'POST' && !url.search) {
      this.reader.conversation(device, read[1]);
      const payload = await body(request);
      if (!Number.isSafeInteger(payload?.lastReplyAt) || payload.lastReplyAt < 0) fail(400, 'Invalid reply timestamp');
      this.reader.conversation(device, read[1]);
      this.json(response, 200, this.reader.manager.markReplyRead(read[1], payload.lastReplyAt));
      return;
    }
    if (url.pathname === '/v1/commands' && request.method === 'POST' && !url.search && this.commands) {
      if (device.permission !== 'control') fail(403, 'Control permission required');
      this.json(response, 200, await this.commands.execute(device, null, await body(request, 32 * 1024), this.instanceId));
      return;
    }
    const command = /^\/v1\/conversations\/([a-f0-9-]{36})\/commands$/.exec(url.pathname);
    if (command && request.method === 'POST' && !url.search && this.commands) {
      if (device.permission !== 'control') fail(403, 'Control permission required');
      const payload = await body(request, 13_000_000);
      this.json(response, 200, await this.commands.execute(device, command[1], payload, this.instanceId));
      return;
    }
    // Reading the desktop API route configuration hands the device every raw
    // provider key, so it stays behind full-device control rather than the
    // per-workspace scope that is enough to read conversations.
    if (this.apiRoutes && url.pathname === '/v1/api-keys') {
      if (request.method !== 'GET') fail(405, 'GET required');
      if (url.search) fail(400, 'Unsupported query parameter');
      if (device.permission !== 'control' || device.allWorkspaces !== true) fail(403, 'Full-device control permission required');
      this.json(response, 200, { ...this.apiRoutes(), ...this.stamp() });
      return;
    }
    if (request.method !== 'GET') fail(405, 'Remote access is read-only');
    const artifact = /^\/v1\/conversations\/([a-f0-9-]{36})\/artifacts(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
    if (artifact) {
      for (const key of url.searchParams.keys()) if (key !== 'offset' || artifact[2]) fail(400, 'Unsupported query parameter');
      if (!artifact[2]) this.json(response, 200, listArtifacts(this.reader, device, artifact[1], number(url.searchParams.get('offset'), 0)));
      else await this.download(response, device, artifact[1], artifact[2]);
      return;
    }
    for (const key of url.searchParams.keys()) if (!['before', 'offset'].includes(key)) fail(400, 'Unsupported query parameter');
    if (url.pathname === '/v1/status') {
      this.json(response, 200, { ...this.connectionInfo(device), ...this.stamp() });
    } else if (url.pathname === '/v1/archived') {
      this.json(response, 200, { ...this.reader.archived(device, number(url.searchParams.get('offset'), 0)), ...this.stamp() });
    } else if (url.pathname === '/v1/conversations') {
      this.json(response, 200, { ...this.connectionInfo(device), ...this.reader.list(device, number(url.searchParams.get('offset'), 0)), ...this.stamp() });
    } else if (url.pathname === '/v1/conversations/events') {
      this.subscribe(response, device, null);
    } else {
      const match = /^\/v1\/conversations\/([a-f0-9-]{36})(\/events)?$/.exec(url.pathname);
      if (!match) fail(404, 'Endpoint not found');
      if (match[2]) this.subscribe(response, device, match[1]);
      else this.json(response, 200, { ...this.reader.snapshot(device, match[1], number(url.searchParams.get('before'), undefined)), ...this.stamp() });
    }
  }
  connectionInfo(device) {
    const fullControl = device.permission === 'control' && device.allWorkspaces === true;
    const capabilities = this.commands ? ['artifacts', 'attachments', 'send', 'stop', 'approve', 'create', 'image', 'multi-image', 'configure', 'move', 'archive', 'restore', 'conversation-actions',
      ...(fullControl ? ['create-workspace', 'delete-workspace', 'rename-workspace'] : [])] : ['artifacts'];
    if (this.apiRoutes && fullControl) capabilities.push('api-keys');
    if (this.apiImport && fullControl) capabilities.push('api-import');
    if (this.nativeSettings && fullControl) capabilities.push('native-settings');
    return { protocol: 1, permission: device.permission, capabilities,
      engines: (this.reader.manager.remoteEngines || ['claude', 'codex', 'dsh', 'kimi', 'antigravity']).filter(engine => ['claude', 'codex', 'dsh', 'kimi', 'antigravity'].includes(engine)),
      workspaces: this.reader.workspaces().filter(item => device.allWorkspaces || device.workspaceIds.includes(item.id)),
      includeUnassigned: Boolean(device.allWorkspaces || device.includeUnassigned) };
  }
  async download(response, device, conversationId, id) {
    if (this.downloads.size >= 8 || [...this.downloads].filter(entry => entry.device.id === device.id).length >= 2) fail(429, 'Too many downloads');
    const entry = { response, device };
    this.downloads.add(entry);
    let file;
    try {
      file = await openArtifact(this.reader, device, conversationId, id);
      if (response.destroyed) return;
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size,
        'Content-Disposition': `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16))}`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (!file.size) response.end();
      else await pipeline(file.handle.createReadStream({ autoClose: false, start: 0, end: file.size - 1 }), response);
    } finally {
      await file?.handle.close();
      this.downloads.delete(entry);
    }
  }
  subscribe(response, device, id) {
    if (this.streams.size >= 16 || [...this.streams].filter(stream => stream.device.id === device.id).length >= 4) fail(429, 'Too many event streams');
    const snapshot = id ? this.reader.snapshot(device, id) : this.reader.listSnapshot(device);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const stream = { response, device, id, dirty: false, blocked: false };
    this.streams.add(stream);
    response.on('close', () => this.streams.delete(stream));
    response.on('drain', () => {
      stream.blocked = false;
      if (stream.dirty) this.scheduleFlush();
    });
    this.writeSnapshot(stream, snapshot);
  }
  writeSnapshot(stream, snapshot) {
    if (!stream.id && stream.listVersion === snapshot.listVersion) return;
    stream.listVersion = snapshot.listVersion;
    const payload = { ...snapshot, ...this.stamp() };
    stream.blocked = !stream.response.write(`id: ${this.instanceId}:${this.sequence}\nevent: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  publish() {
    this.sequence++;
    for (const stream of this.streams) stream.dirty = true;
    this.scheduleFlush();
  }
  scheduleFlush() {
    if (this.flushTimer || !this.streams.size) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      for (const stream of this.streams) {
        if (!stream.dirty || stream.blocked) continue;
        stream.dirty = false;
        try { this.writeSnapshot(stream, stream.id ? this.reader.snapshot(stream.device, stream.id) : this.reader.listSnapshot(stream.device)); }
        catch { stream.response.end(); }
      }
    }, 250);
    this.flushTimer.unref();
  }
  revoke(id) {
    this.commands?.cancelPending(id);
    for (const stream of this.streams) if (stream.device.id === id) stream.response.end();
    for (const entry of this.downloads) if (entry.device.id === id) entry.response.destroy();
  }
  async stop() {
    clearInterval(this.heartbeat);
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.access.clearPairing();
    this.commands?.cancelPending();
    for (const entry of this.downloads) entry.response.destroy();
    for (const stream of this.streams) stream.response.destroy();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    this.url = null;
    this.transport = null;
    this.rate.clear();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

module.exports = { RemoteGateway };
