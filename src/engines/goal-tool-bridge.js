'use strict';

const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
const { tools, instructions, validateTool } = require('./goal-tools');

async function createGoalToolBridge({ node, call }) {
  const token = randomBytes(32).toString('hex');
  const name = 'camellia-goal-' + randomUUID();
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(os.tmpdir(), name + '.sock');
  const sockets = new Set();
  let closed = false;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(10000, () => socket.destroy());
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65536) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      socket.removeAllListeners('data');
      void (async () => {
        try {
          const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          if (request.token !== token) throw new Error('Unauthorized goal tool request');
          validateTool(request.name, request.arguments);
          const result = await call(request.name, request.arguments);
          socket.end(JSON.stringify(result) + '\n');
        } catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
      })();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  server.unref();
  const script = path.join(__dirname, 'goal-mcp-stdio.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const config = { command: node, args: [script], env: { CAMELLIA_GOAL_ENDPOINT: endpoint, CAMELLIA_GOAL_TOKEN: token } };
  return { config, tools, instructions, close() { if (closed) return; closed = true; for (const socket of sockets) socket.destroy(); server.close(); } };
}

module.exports = { createGoalToolBridge };
