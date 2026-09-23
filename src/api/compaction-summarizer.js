'use strict';

const { hasRoutes, publicState } = require('./api-router-config');

// Portable compaction summarizes through the workbench router so the summary
// never starts an engine process: fragments become independent parallel
// requests, each with a real output cap. The client sits beside the router so
// a smoke test can drive the same code without Electron.
const REQUEST_TIMEOUT_MS = 180000;
// Only structured provider 400/422 context errors establish a smaller budget.
// Timeouts, rate limits and gateway errors do not.
const CONTEXT_OVERFLOW = /context[_ ]?(length|window)|context overflow|maximum context|prompt is too long|too many tokens|context_length_exceeded|request.{0,10}too large/i;

function createCompactionSummarizer({ getConfig, getRoute, isRunning = () => true, fetchImpl = fetch, log = () => {} }) {
  // Routability decides the transport before the first request, so an unusable
  // route never wastes a summary request or fails a compaction that the engine
  // session path could have completed.
  function available(model) {
    const id = String(model || '').trim();
    if (!id) return false;
    try {
      const config = getConfig();
      return hasRoutes(config) && isRunning() && publicState(config).models.includes(id);
    } catch (error) {
      log(`context compaction: cannot use the API router (${error.message})`);
      return false;
    }
  }

  async function run({ model, system, user, maxTokens, signal }) {
    const route = getRoute();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(route.baseUrl + '/v1/chat/completions', {
      method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${route.authToken}`, 'Content-Type': 'application/json', 'x-camellia-aux': 'compaction' },
      body: JSON.stringify({ model, stream: false, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try { detail = JSON.parse(text)?.error?.message || text; } catch { /* keep the raw body */ }
      const message = `HTTP ${response.status}: ${String(detail).slice(0, 200)}`;
      const error = new Error(message);
      // A provider context limit is a budget signal: the pipeline splits that
      // fragment again under the learned cap instead of failing the whole run.
      error.overflow = [400, 422].includes(response.status) && CONTEXT_OVERFLOW.test(message);
      throw error;
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('The summary response was not valid JSON'); }
    const choice = data?.choices?.[0];
    return { text: choice?.message?.content || '', truncated: choice?.finish_reason === 'length', usage: data?.usage };
  }

  return { available, run };
}

module.exports = { createCompactionSummarizer, REQUEST_TIMEOUT_MS };
