'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
const { tools, instructions, validateTool } = require('./goal-tools');

async function createGoalToolBridge({ node, call, webTools = false }) {
  const token = randomBytes(32).toString('hex');
  const name = 'camellia-goal-' + randomUUID();
  let directory;
  if (process.platform !== 'win32') {
    // macOS limits Unix socket paths to 103 bytes. Keep the user's temporary
    // directory when it fits, with a private short directory as the fallback.
    const temporary = os.tmpdir();
    const base = Buffer.byteLength(path.join(temporary, 'cmg-XXXXXX', 'ipc.sock')) <= 103 ? temporary : '/tmp';
    directory = fs.mkdtempSync(path.join(base, 'cmg-'));
    fs.chmodSync(directory, 0o700);
  }
  const endpoint = directory ? path.join(directory, 'ipc.sock') : '\\\\.\\pipe\\' + name;
  const sockets = new Set();
  let closed = false, closing;
  const server = net.createServer(socket => {
    const abort = new AbortController();
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); abort.abort(); });
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
          if (request.name.startsWith('camellia_web_')) {
            if (!webTools) throw new Error('DeepSeek web tools are disabled in Model Settings');
            socket.setTimeout(65000);
          }
          const result = await call(request.name, request.arguments, { signal: abort.signal });
          socket.end(JSON.stringify(result) + '\n');
        } catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
      })();
    });
  });
  const close = () => {
    if (closed) return closing;
    closed = true;
    for (const socket of sockets) socket.destroy();
    return closing = new Promise(resolve => server.close(() => {
      if (directory) { try { fs.rmdirSync(directory); } catch {} }
      resolve();
    }));
  };
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); }); }
  catch (error) { await close(); throw error; }
  server.unref();
  const script = path.join(__dirname, 'goal-mcp-stdio.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const config = { command: node, args: [script], env: { CAMELLIA_GOAL_ENDPOINT: endpoint, CAMELLIA_GOAL_TOKEN: token,
    CAMELLIA_WEB_TOOLS: webTools ? 'deepseek' : '' } };
  return { config, tools: [...tools, ...(webTools ? require('./web-tools').tools : [])],
    instructions: instructions + (webTools ? '\n' + require('./web-tools').instructions : ''), webTools, close };
}

module.exports = { createGoalToolBridge };
