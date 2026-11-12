'use strict';

// Presentation-only facts, never the current composer's model or context usage.
function mobileTurnDetails(row) {
  if (row.role !== 'assistant') return null;
  const metrics = row.turnMetrics || row.runResult;
  const source = row.usage || row.runResult?.usage;
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (Number.isSafeInteger(source?.[key]) && source[key] >= 0) usage[key] = source[key];
  }
  if (!metrics && !Object.keys(usage).length) return null;
  const terminal = row.runResult;
  const result = { state: terminal?.subtype === 'stopped' ? 'stopped'
    : terminal?.is_error || terminal?.subtype === 'error_max_turns' ? 'error' : 'complete' };
  if (Number.isFinite(metrics?.duration_ms) && metrics.duration_ms >= 0) result.duration_ms = Math.round(metrics.duration_ms);
  if (typeof metrics?.model === 'string' && metrics.model.trim()) result.model = metrics.model.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
  if (Number.isFinite(metrics?.total_cost_usd) && metrics.total_cost_usd >= 0) result.total_cost_usd = metrics.total_cost_usd;
  if (Object.keys(usage).length) result.usage = usage;
  // The initiating reply can also carry the total for background follow-ups
  // and native child agents that belong to the same user request.
  const request = row.requestUsage;
  if (request) {
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const bucket = value => ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
      .reduce((sum, key) => sum + (Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : 0), 0);
    const combined = key => (Number.isSafeInteger(request.main?.[key]) ? request.main[key] : 0)
      + (Number.isSafeInteger(request.background?.[key]) ? request.background[key] : 0);
    result.requestUsage = { total: count(request.total), main: bucket(request.main), background: bucket(request.background),
      backgroundTurns: count(request.background?.turns), children: count(request.children?.tokens),
      childTasks: count(request.children?.tasks), input: combined('input_tokens'), output: combined('output_tokens'),
      cacheRead: combined('cache_read_input_tokens'), cacheWrite: combined('cache_creation_input_tokens') };
  }
  return result;
}

module.exports = { mobileTurnDetails };
