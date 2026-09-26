'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { privateDirectory } = require('./private-storage');

const LIMIT = 1024 * 1024;
function socketPath(dataDir) {
  if (process.platform === 'win32') return '\\\\.\\pipe\\camellia-server-' + crypto.createHash('sha256').update(dataDir).digest('hex').slice(0, 24);
  const file = path.join(dataDir, 'control.sock');
  if (Buffer.byteLength(file) > 100) throw new Error('Server data path is too long for a Unix socket');
  return file;
}

async function listenControl({ dataDir, command }) {
  privateDirectory(dataDir);
  const address = socketPath(dataDir);
  if (process.platform !== 'win32' && fs.existsSync(address)) {
    const stat = fs.lstatSync(address);
    if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Unsafe existing control socket');
    fs.unlinkSync(address);
  }
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = Buffer.alloc(0), received = false;
    socket.on('data', chunk => {
      if (received) return;
      if (buffer.length + chunk.length > LIMIT) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      received = true;
      void (async () => {
        try {
          const request = JSON.parse(buffer.subarray(0, end).toString('utf8'));
          if (!request || typeof request.action !== 'string' || Object.keys(request).some(key => !['action', 'payload'].includes(key))) throw new Error('Invalid command');
          const result = await command(request.action, request.payload);
          if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n');
        } catch { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: 'Invalid local request' }) + '\n'); }
      })();
    });
  });
  server.maxConnections = 16;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
  } catch (error) { server.close(); throw error; }
  return { async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

function requestControl(dataDir, action, payload = {}) {
  const encoded = Buffer.from(JSON.stringify({ action, payload }) + '\n');
  if (encoded.length > LIMIT) return Promise.reject(new Error('Local request is too large'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(dataDir));
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(30_000, () => finish(new Error('Local server request timed out')));
    socket.on('error', () => finish(new Error('Cannot connect to Camellia server; start serve first')));
    socket.on('connect', () => socket.write(encoded));
    socket.on('data', chunk => {
      if (buffer.length + chunk.length > 8 * 1024 * 1024) { finish(new Error('Local response is too large')); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try { finish(null, JSON.parse(buffer.subarray(0, end).toString('utf8'))); }
      catch { finish(new Error('Invalid local server response')); }
    });
    socket.on('end', () => { if (!settled) finish(new Error('Local server closed before acknowledging the command; verify state before retrying')); });
  });
}

module.exports = { socketPath, listenControl, requestControl };
