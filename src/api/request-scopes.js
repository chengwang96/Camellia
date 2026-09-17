'use strict';

const { randomUUID } = require('node:crypto');
const { collectToolResults } = require('./tool-results');

// In-memory routes for one benchmark trial. They reuse the normal router's
// accounting, but pin the provider/model and keep concurrent chat usage apart.
class RequestScopes {
  constructor() { this.scopes = new Map(); }
  create({ model, providerId, upstream, routeFingerprint, maxRequests = 40, maxTokens = 1000000, onUsage = () => {}, onLimit = () => {}, onRequest = () => {}, onToolResult = () => {} }) {
    const id = randomUUID();
    const seenTools = new Set();
    const limit = () => { if (!scope.limited) { scope.limited = true; try { onLimit(); } catch { /* observer */ } } };
    const scope = { model, providerId, upstream, routeFingerprint, maxRequests, maxTokens, requests: 0, tokens: 0,
      closed: false, limited: false, responses: new Set(), pending: new Set(),
      observeTools: (body, protocol) => {
        if (scope.closed) return;
        try {
          for (const tool of collectToolResults(body, protocol)) {
            if (seenTools.has(tool.id)) continue;
            seenTools.add(tool.id);
            try { onToolResult(tool); } catch { /* Observers cannot change tool execution. */ }
          }
        } catch { /* Malformed requests are handled by the protocol adapter. */ }
      },
      begin: (metadata = {}) => {
        if (scope.closed) return 'This benchmark trial has ended';
        if (scope.limited || scope.requests >= maxRequests || scope.tokens >= maxTokens) {
          limit();
          return 'Benchmark trial API limit reached';
        }
        scope.requests++;
        try { onRequest({ ...metadata, sequence: scope.requests }); } catch { /* observer */ }
        return null;
      },
      record: record => {
        scope.tokens += (record.tokens?.input || 0) + (record.tokens?.output || 0);
        try { onUsage(record); } catch { /* observers must not affect routing */ }
        if (scope.tokens >= maxTokens) limit();
      },
    };
    this.scopes.set(id, scope);
    return { scope, path: '/bench/' + id, close: async () => {
      scope.closed = true;
      for (const res of scope.responses) res.destroy();
      await Promise.allSettled([...scope.pending]);
      this.scopes.delete(id);
    } };
  }
  resolve(pathname) {
    const match = /^\/bench\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match) return { pathname };
    return { scoped: true, scope: this.scopes.get(match[1]), pathname: match[2] || '/' };
  }
  closeAll() {
    for (const scope of this.scopes.values()) {
      scope.closed = true;
      for (const res of scope.responses) res.destroy();
    }
    this.scopes.clear();
  }
}

module.exports = { RequestScopes };
