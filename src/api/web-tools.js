'use strict';

const { availableProviders } = require('../shared/web-tools');
const { requestJson } = require('./provider-accounts');
// Budget the serialized size as well: control characters and quotes expand
// in JSON, and all harnesses share a bounded IPC response channel.
function clip(value, bytes) {
  const text = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(JSON.stringify(text)) <= bytes) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, mid))) <= bytes) low = mid; else high = mid - 1;
  }
  return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
}
const MAX_RESULT_BYTES = 90000;
const RESPONSE_HEADERS = ['content-type', 'content-length', 'date', 'server', 'x-request-id', 'request-id', 'x-ds-request-id'];

// Independent of model routing: any model with Camellia tools can use the
// selected official account, including an account without model routes.
function createWebTools({ getConfig, fetchImpl = fetch, timeoutMs = 55000 }) {
  return {
    enabled: () => getConfig().webTools?.provider === 'deepseek',
    async call(name, args, { signal } = {}) {
      if (signal?.aborted) throw new Error('Web tool call cancelled');
      const config = getConfig();
      if (config.webTools?.provider !== 'deepseek') throw new Error('DeepSeek web tools are disabled in Model Settings');
      const provider = availableProviders(config).find(provider => provider.id === config.webTools.providerId);
      const key = provider?.keys.find(key => key.enabled !== false && key.key?.trim());
      if (!key) throw new Error('Add or enable the selected DeepSeek official API key in API Keys');
      let endpoint, body;
      if (name === 'camellia_web_search') {
        if (typeof args.query !== 'string' || !args.query.trim() || [...args.query].length > 128
          || args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1 || args.count > 50)
          || args.need_content !== undefined && typeof args.need_content !== 'boolean') throw new Error('Invalid web search arguments');
        endpoint = 'search'; body = { query: args.query, count: args.count ?? 5, need_content: args.need_content ?? false };
      } else if (name === 'camellia_web_fetch') {
        let url;
        try { url = new URL(args.url); } catch { throw new Error('Enter a complete HTTP or HTTPS page URL'); }
        if (typeof args.url !== 'string' || args.url.length > 8192 || url.href.length > 8192 || !['http:', 'https:'].includes(url.protocol)
          || !url.hostname || url.username || url.password) throw new Error('Enter a complete HTTP or HTTPS page URL without credentials');
        endpoint = 'fetch'; body = { url: url.href };
      } else throw new Error('Unknown web tool');
      // Always send the key to the fixed official host, never to a page URL or
      // a configured relay. No automatic retry of a potentially billed call.
      const apiUrl = 'https://api.deepseek.com/v1/tools/' + endpoint;
      let data, responseHeaders = {};
      try {
        data = await requestJson(apiUrl, key.key, {
          fetchImpl: async (url, options) => {
            const response = await fetchImpl(url, options);
            // Keep response diagnostics useful without exposing cookies,
            // authorization or arbitrary provider headers to model history.
            responseHeaders = Object.fromEntries(RESPONSE_HEADERS.flatMap(name => {
              const value = response.headers?.get?.(name);
              return value ? [[name, clip(value.replaceAll(key.key, '[redacted]'), 512)]] : [];
            }));
            return response;
          }, method: 'POST', body, timeoutMs, signal, maxResponseBytes: 4 * 1024 * 1024,
        });
      } catch (error) {
        // Fetch uses 404 for an unreadable target page, unlike account/model
        // APIs where the shared HTTP helper interprets it as a missing API.
        const attachment = endpoint === 'fetch' && error.status === 404 && /\.docx$/i.test(new URL(body.url).pathname.replace(/%2e/ig, '.'));
        const failure = attachment ? { code: 'web_attachment_requires_download', reason: 'This URL points to a Word (DOCX) attachment. DeepSeek Fetch did not return webpage content for it. Download the attachment from its original URL and read it as a local DOCX file.' } : endpoint === 'fetch' && {
          403: { code: 'web_fetch_blocked', reason: 'DeepSeek refused to fetch this page under its security policy. Try a different page URL.' },
          404: { code: 'web_page_unavailable', reason: 'DeepSeek could not retrieve readable content from this page. The page may be unavailable, block fetching, use an unsupported content type, or have no extractable text. Try a different page URL.' },
        }[error.status];
        const failureError = failure ? Object.assign(new Error(`HTTP ${error.status} · ${failure.reason}`), {
          status: error.status, code: failure.code, retryable: false,
          ...(attachment ? { download_url: body.url } : {}),
        }) : error;
        throw Object.assign(failureError, { provider: 'deepseek', operation: endpoint, url: body.url, api_url: apiUrl,
          response_headers: responseHeaders });
      }
      if (signal?.aborted) throw new Error('Web tool call cancelled');
      if (endpoint === 'fetch') {
        if (typeof data?.content !== 'string' || typeof data.title !== 'string') throw new Error('DeepSeek returned an invalid page response');
        const content = clip(data.content, 72000);
        return { ok: true, provider: 'deepseek', url: body.url, title: clip(data.title, 2048), content, truncated: content !== data.content };
      }
      if (!Array.isArray(data?.results)) throw new Error('DeepSeek returned an invalid search response');
      const results = [];
      let truncated = false, remaining = MAX_RESULT_BYTES - 1024;
      for (const row of data.results.slice(0, body.count)) {
        if (!row || typeof row.url !== 'string' || typeof row.title !== 'string') throw new Error('DeepSeek returned an invalid search response');
        const result = { title: clip(row.title, 2048), url: clip(row.url, 8192), summary: clip(row.summary || row.snippet, 4000),
          ...(body.need_content ? { content: clip(row.content, Math.max(0, Math.min(12000, remaining - 16000))) } : {}),
          date: typeof row.date === 'string' ? clip(row.date, 80) : null };
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes > remaining) { truncated = true; break; }
        remaining -= bytes;
        truncated ||= result.title !== row.title || result.url !== row.url || result.summary !== (row.summary || row.snippet || '')
          || body.need_content && result.content !== (row.content || '');
        results.push(result);
      }
      return { ok: true, provider: 'deepseek', results, truncated: Boolean(truncated || results.length < data.results.length) };
    },
  };
}

module.exports = { createWebTools };
