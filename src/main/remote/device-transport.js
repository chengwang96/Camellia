'use strict';

const http = require('node:http');
const { isTailscaleIPv4 } = require('./tailscale');

function deviceAddress(value) {
  if (typeof value !== 'string') throw new Error('Invalid device address');
  const match = /^http:\/\/([0-9.]+):43127$/.exec(value);
  if (!match || !isTailscaleIPv4(match[1]) || match[1].split('.').some(part => String(Number(part)) !== part)) throw new Error('Use a Tailscale IPv4 address on port 43127');
  return value;
}

function endpointPath(value, method) {
  if (typeof value !== 'string' || !value.startsWith('/v1/') || /[%#\\\s]/.test(value)) throw new Error('Invalid device endpoint');
  const url = new URL(value, 'http://device');
  const conversation = /^\/v1\/conversations\/[a-f0-9-]{36}(?:\/(events|commands|read|artifacts)(\/[a-f0-9]{64})?)?$/.exec(url.pathname);
  if (conversation?.[2] && conversation[1] !== 'artifacts') throw new Error('Unsupported device endpoint');
  const pairing = ['/v1/pair/request', '/v1/pair/claim'].includes(url.pathname);
  const native = /^\/v1\/native-settings\/(claude|codex|kimi|dsh|antigravity)$/.test(url.pathname);
  if (method === 'POST') {
    if (value.includes('?') || !(pairing || native || url.pathname === '/v1/api-import' || url.pathname === '/v1/commands' || conversation && ['commands', 'read'].includes(conversation[1]))) throw new Error('Unsupported device endpoint');
  } else if (method !== 'GET' || !(['/v1/status', '/v1/archived', '/v1/conversations', '/v1/conversations/events', '/v1/api-keys', '/v1/api-import'].includes(url.pathname)
      || native || conversation && !['commands', 'read'].includes(conversation[1]))) throw new Error('Unsupported device endpoint');
  for (const [key, entry] of url.searchParams) {
    if (!/^\d{1,12}$/.test(entry) || url.searchParams.getAll(key).length !== 1
      || !(key === 'offset' && (['/v1/conversations', '/v1/archived'].includes(url.pathname) || url.pathname.endsWith('/artifacts'))
        || key === 'before' && conversation && !conversation[1])) throw new Error('Invalid device cursor');
  }
  return value;
}

class DeviceTransport {
  constructor({ url, token, disconnect }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password
      || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local device transport');
    Object.assign(this, { url: parsed.origin, token, disconnect });
    this.requests = new Set();
    this.closed = false;
  }
  async open(endpoint, { method = 'GET', body, bearer, signal } = {}) {
    if (this.closed) throw new Error('Device connection is closed');
    endpointPath(endpoint, method);
    if (bearer !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(bearer)) throw new Error('Invalid device credential');
    if (body !== undefined && method !== 'POST') throw new Error('GET requests cannot contain a body');
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    if (bytes?.length > 13_000_000) throw new Error('Device request is too large');
    return new Promise((resolve, reject) => {
      const request = http.request(this.url + endpoint, { method, signal, agent: false, headers: {
        'x-camellia-outbound': this.token, ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
      } });
      this.requests.add(request);
      const timer = setTimeout(() => request.destroy(new Error('Device response timed out')), 20_000);
      request.setTimeout(30_000, () => request.destroy(new Error('Device connection idle timeout')));
      request.once('close', () => { clearTimeout(timer); this.requests.delete(request); });
      request.on('error', () => reject(new Error(signal?.aborted ? 'Device request cancelled' : 'Device request failed; verify state before retrying writes')));
      request.once('response', response => { clearTimeout(timer); resolve(response); });
      request.end(bytes);
    });
  }
  async json(endpoint, options = {}) {
    const response = await this.open(endpoint, options);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      throw Object.assign(new Error(`Device returned HTTP ${response.statusCode}; verify state before retrying writes`), { status: response.statusCode });
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] || '')) {
      response.destroy(); throw new Error('Device did not return JSON');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { response.destroy(); throw new Error('Device response is too large'); }
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Invalid device JSON response'); }
  }
  async *events(endpoint, options = {}) {
    if (!/^\/v1\/conversations(?:\/[a-f0-9-]{36})?\/events$/.test(endpoint)) throw new Error('Invalid device event endpoint');
    const response = await this.open(endpoint, options);
    if (response.statusCode !== 200 || !/^text\/event-stream(?:;|$)/i.test(response.headers['content-type'] || '')) {
      response.destroy(); throw new Error('Device event stream is unavailable');
    }
    response.setEncoding('utf8');
    let buffered = '';
    try {
      for await (const chunk of response) {
        buffered += chunk;
        if (Buffer.byteLength(buffered) > 8 * 1024 * 1024) throw new Error('Device event frame is too large');
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffered))) {
          const frame = buffered.slice(0, match.index);
          buffered = buffered.slice(match.index + match[0].length);
          const data = [], event = { type: 'message', id: '' };
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            if (line.startsWith('event:')) event.type = line.slice(6).trim();
            if (line.startsWith('id:')) event.id = line.slice(3).trim();
          }
          if (data.length) {
            try { event.data = JSON.parse(data.join('\n')); }
            catch { throw new Error('Invalid device event JSON'); }
            yield event;
          }
        }
      }
      if (buffered.trim() && !buffered.trim().startsWith(':')) throw new Error('Device stream ended with an incomplete event');
    } finally { response.destroy(); }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.requests) request.destroy();
    this.requests.clear();
    await this.disconnect?.();
  }
}

module.exports = { DeviceTransport, deviceAddress, endpointPath };
