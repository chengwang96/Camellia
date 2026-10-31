'use strict';

const { randomUUID } = require('node:crypto');
const { collectToolResults } = require('./tool-results');

// In-memory provider/model bindings for discussions. Scoped limits and usage
// are independent of concurrent chat traffic on the same router.
class RequestScopes {
  constructor() { this.scopes = new Map(); }
  create({ model, providerId, keyId, upstream, routeFingerprint, maxRequests = 40, maxTokens = 1000000, toolPolicy = 'preserve', onUsage = () => {}, onToolResult = () => {} }) {
    const id = randomUUID();
    const seenTools = new Set();
    const scope = { model, providerId, keyId, upstream, routeFingerprint, maxRequests, maxTokens, toolPolicy, requests: 0, tokens: 0,
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
      begin: () => {
        if (scope.closed) return 'This API scope has ended';
        if (scope.limited || scope.requests >= maxRequests || scope.tokens >= maxTokens) {
          scope.limited = true;
          return 'Scoped API limit reached';
        }
        scope.requests++;
        return null;
      },
      record: record => {
        scope.tokens += (record.tokens?.input || 0) + (record.tokens?.output || 0);
        try { onUsage(record); } catch { /* observers must not affect routing */ }
        if (scope.tokens >= maxTokens) scope.limited = true;
      },
    };
    this.scopes.set(id, scope);
    return { scope, path: '/scopes/' + id, close: async () => {
      scope.closed = true;
      for (const res of scope.responses) res.destroy();
      await Promise.allSettled([...scope.pending]);
      this.scopes.delete(id);
    } };
  }
  resolve(pathname) {
    const match = /^\/scopes\/([^/]+)(\/.*)?$/.exec(pathname);
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
