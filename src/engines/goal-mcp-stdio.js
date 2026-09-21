'use strict';

const net = require('node:net');
const readline = require('node:readline');
const { tools, instructions } = require('./goal-tools');

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.CAMELLIA_GOAL_ENDPOINT);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy(new Error('Camellia goal tool timed out')));
    socket.on('error', reject);
    socket.on('end', () => {
      try { resolve(JSON.parse(buffer)); } catch { reject(new Error('Invalid Camellia goal response')); }
    });
    socket.on('data', chunk => { buffer += chunk; if (Buffer.byteLength(buffer) > 131072) socket.destroy(new Error('Goal response too large')); });
    socket.on('connect', () => socket.write(JSON.stringify({ token: process.env.CAMELLIA_GOAL_TOKEN, name, arguments: args }) + '\n'));
  });
}

async function dispatch(request) {
  if (request.method === 'initialize') return { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'camellia-goals', version: '1.0.0' }, instructions };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') {
    let result;
    try { result = await callTool(request.params?.name, request.params?.arguments || {}); }
    catch (error) { result = { ok: false, error: error.message }; }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.ok === false };
  }
  throw Object.assign(new Error('Unsupported MCP method'), { code: -32601 });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  void (async () => {
    let request;
    try {
      if (Buffer.byteLength(line) > 65536) throw new Error('Request too large');
      request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = await dispatch(request);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: error.code || -32600, message: error.message } }) + '\n');
    }
  })();
});
