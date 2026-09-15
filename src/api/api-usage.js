'use strict';

const FIELDS = ['requests', 'failures', 'cancelled', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unreported'];
function counters(raw = {}) {
  return Object.fromEntries(FIELDS.map(key => [key, Number.isFinite(Number(raw[key])) ? Math.max(0, Number(raw[key])) : 0]));
}
function dayId(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function normalizeBreakdown(raw) {
  return Object.fromEntries(Object.entries(raw || {}).filter(([key, value]) => !['__proto__', 'constructor', 'prototype'].includes(key) && value && typeof value === 'object').map(([key, value]) => [key, counters(value)]));
}
function recordUsage(usage, model, tokens, outcome, date = new Date()) {
  const delta = counters({
    [outcome]: 1, inputTokens: tokens.input, outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite,
    unreported: !tokens.reported && outcome === 'requests' ? 1 : 0,
  });
  usage.byModel ||= {};
  usage.daily ||= {};
  const day = dayId(date);
  usage.byModel[model] ||= counters();
  usage.daily[day] ||= {};
  usage.daily[day][model] ||= counters();
  for (const bucket of [usage, usage.byModel[model], usage.daily[day][model]]) {
    for (const key of FIELDS) bucket[key] = (bucket[key] || 0) + delta[key];
  }
  usage.lastUsedAt = date.toISOString();
  // Daily charts retain 90 days; lifetime model counters remain available.
  const oldest = new Date(date); oldest.setDate(oldest.getDate() - 90);
  for (const key of Object.keys(usage.daily)) if (key < dayId(oldest)) delete usage.daily[key];
}
module.exports = { FIELDS, counters, dayId, normalizeBreakdown, recordUsage };
