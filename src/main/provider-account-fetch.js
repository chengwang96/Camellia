'use strict';

const { createDownloadConnection } = require('./download-network');

const CONNECTION_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

// An automatic connection can resolve to the system proxy because another
// host needs it. A failed account GET may still succeed directly. Keep the
// explicit system-proxy choice and the original request deadline intact.
function createProviderAccountConnection({ getMode = () => 'direct', fetchImpl = fetch,
  getProxyUrl = () => process.env.CAMELLIA_NETWORK_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
  createDirect = () => createDownloadConnection({ mode: 'direct' }) } = {}) {
  let direct;
  return {
    async fetch(url, options = {}) {
      try { return await fetchImpl(url, options); }
      catch (error) {
        const automatic = ['auto', 'prefer-direct'].includes(getMode());
        const connectionError = CONNECTION_ERRORS.has(error.code) || CONNECTION_ERRORS.has(error.cause?.code);
        if (!automatic || !getProxyUrl() || (options.method || 'GET').toUpperCase() !== 'GET'
          || options.signal?.aborted || !connectionError) throw error;
        direct ||= createDirect();
        return direct.fetch(url, options);
      }
    },
    close() { return direct?.close(); },
  };
}

module.exports = { createProviderAccountConnection };
