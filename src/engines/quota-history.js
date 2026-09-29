'use strict';
function recordQuota(history = [], limits, now = Date.now()) {
  const groups = limits.primary || limits.secondary ? { codex: limits } : limits;
  const windows = Object.entries(groups).flatMap(([group, value]) => ['primary', 'secondary'].flatMap(key => {
    const window = value?.[key];
    if (!window || !Number.isFinite(window.usedPercent)) return [];
    return [{ id: `${group}:${key}`, label: `${group} · ${window.windowDurationMins ? window.windowDurationMins / 60 + 'h' : key}`,
      usedPercent: window.usedPercent, resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null }];
  }));
  if (!windows.length) return history;
  const rows = history.filter(row => Date.parse(row.at) >= now - 30 * 86400000);
  const sample = { at: new Date(now).toISOString(), windows };
  if (rows.length && Math.floor(Date.parse(rows.at(-1).at) / 60000) === Math.floor(now / 60000)) rows[rows.length - 1] = sample;
  else rows.push(sample);
  return rows.slice(-3000);
}
module.exports = { recordQuota };
