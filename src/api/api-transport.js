'use strict';

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

const directHttp = new http.Agent();
const directHttps = new https.Agent();
const proxyAgents = new Map();

function bypassProxy(url, env) {
  const value = String(env.no_proxy || env.NO_PROXY || '');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return value.split(',').some(item => {
    let entry = item.trim().toLowerCase();
    if (!entry) return false;
    if (entry === '*') return true;
    let entryPort = '';
    const bracketed = /^\[([^\]]+)](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      entry = bracketed[1];
      entryPort = bracketed[2] || '';
    } else if ((entry.match(/:/g) || []).length === 1 && /:\d+$/.test(entry)) {
      const colon = entry.lastIndexOf(':');
      entryPort = entry.slice(colon + 1);
      entry = entry.slice(0, colon);
    }
    entry = entry.replace(/^\./, '').replace(/\.$/, '');
    return Boolean(entry) && (!entryPort || entryPort === port)
      && (hostname === entry || hostname.endsWith('.' + entry));
  });
}

function proxyFor(url, env = process.env) {
  if (url.protocol !== 'https:' || bypassProxy(url, env)) return '';
  return String(env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || '').trim();
}

function authority(host, port) {
  return `${String(host).includes(':') ? `[${host}]` : host}:${port}`;
}

function proxyHeaders(proxy, host) {
  const headers = { host };
  if (proxy.username || proxy.password) {
    const username = decodeURIComponent(proxy.username);
    const password = decodeURIComponent(proxy.password);
    headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }
  return headers;
}

function proxyTunnel(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(proxy.protocol)) {
      reject(new Error('API proxies must use HTTP or HTTPS'));
      return;
    }
    const target = authority(host, port);
    const request = (proxy.protocol === 'https:' ? https : http).request(proxy, {
      method: 'CONNECT', path: target, headers: proxyHeaders(proxy, target), agent: false,
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('Proxy connection timed out'), { code: 'ETIMEDOUT' })), 10000);
    timer.unref?.();
    request.once('error', error => { clearTimeout(timer); reject(error); });
    request.once('connect', (response, socket, head) => {
      clearTimeout(timer);
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT returned ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

class ConnectAgent extends https.Agent {
  constructor(proxyUrl) {
    super();
    this.proxyUrl = proxyUrl;
  }

  createConnection(options, callback) {
    const host = options.servername || options.host;
    proxyTunnel(this.proxyUrl, host, Number(options.port) || 443).then(socket => {
      try { callback(null, tls.connect({ ...options, socket, servername: options.servername || host })); }
      catch (error) { socket.destroy(); callback(error); }
    }, error => callback(error));
  }
}

function request(url, options, callback) {
  if (url.protocol !== 'https:') return http.request(url, { ...options, agent: directHttp }, callback);
  const proxyUrl = proxyFor(url);
  let agent = directHttps;
  if (proxyUrl) {
    if (!proxyAgents.has(proxyUrl)) proxyAgents.set(proxyUrl, new ConnectAgent(proxyUrl));
    agent = proxyAgents.get(proxyUrl);
  }
  return https.request(url, { ...options, agent }, callback);
}

module.exports = { request, proxyFor };
