'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

// A shared loopback transport lets native engines and Node use the same policy.
// Retry only connection establishment, before application requests are sent.
async function createFallbackProxy(proxyUrl, { timeout = 8000, connect = net.connect, allowDirect = true } = {}) {
  const upstream = proxyUrl ? new URL(proxyUrl) : null;
  function direct(host, port) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Direct connection timed out'), { code: 'ETIMEDOUT' })), timeout);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    });
  }
  function viaProxy(host, port) {
    return new Promise((resolve, reject) => {
      const request = (upstream.protocol === 'https:' ? https : http).request(upstream, {
        method: 'CONNECT', path: `${host.includes(':') ? `[${host}]` : host}:${port}`, agent: false,
      });
      const timer = setTimeout(() => request.destroy(new Error('System proxy connection timed out')), timeout);
      request.once('error', error => { clearTimeout(timer); reject(error); });
      request.once('connect', (response, socket, head) => {
        clearTimeout(timer);
        if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`System proxy returned ${response.statusCode}`)); return; }
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      request.end();
    });
  }
  async function route(host, port) {
    if (!allowDirect) {
      if (!upstream) throw new Error('System proxy unavailable');
      return viaProxy(host, port);
    }
    try { return await direct(host, port); }
    catch (error) { if (!upstream) throw error; return viaProxy(host, port); }
  }
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    request.pause();
    try {
      const target = new URL(request.url);
      if (target.protocol !== 'http:') throw new Error('Expected HTTP URL');
      const socket = await route(target.hostname, Number(target.port) || 80);
      const agent = new http.Agent();
      agent.createConnection = () => socket;
      const headers = { ...request.headers };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const outgoing = http.request(target, { method: request.method, headers, agent }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
      });
      outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.on('close', () => { outgoing.destroy(); agent.destroy(); });
      request.pipe(outgoing); request.resume();
    } catch { response.writeHead(502); response.end('Connection failed'); }
  });
  server.on('connect', async (request, client, head) => {
    client.on('error', () => {});
    try {
      const target = new URL(`http://${request.url}`);
      const socket = await route(target.hostname.replace(/^\[|\]$/g, ''), Number(target.port) || 443);
      if (client.destroyed) { socket.destroy(); return; }
      socket.on('error', () => client.destroy());
      client.on('close', () => socket.destroy());
      socket.on('close', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      client.pipe(socket); socket.pipe(client);
    } catch { client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}
module.exports = { createFallbackProxy };
