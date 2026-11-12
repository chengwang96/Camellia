'use strict';

const { rateLimitGroups } = require('./subscription-accounts');

const WEEKLY_MINUTES = 10080;
const PROBE_RETRY_MS = 30 * 60 * 1000;

// A running Codex weekly window reports its next reset time. Once that time has
// passed and no new cycle has started, the next reset time stays unknown until
// the account sends its first message again. Only the long window needs this
// check; 5-hour windows roll over constantly.
function weeklyWindows(rateLimits) {
  const windows = [];
  for (const [group, limits] of Object.entries(rateLimitGroups(rateLimits))) {
    if (!limits || typeof limits !== 'object') continue;
    for (const key of ['primary', 'secondary']) {
      const window = limits[key];
      if (!window || typeof window !== 'object') continue;
      const duration = Number(window.windowDurationMins);
      if (!Number.isFinite(duration) || duration < WEEKLY_MINUTES) continue;
      windows.push({ id: `${group}:${key}`,
        resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null });
    }
  }
  return windows;
}

// Keep the future reset time while it is known, so a later sparse reading
// without `resetsAt` can still tell that this cycle has elapsed.
function observeWeekly(rateLimits, records = {}, now = Date.now()) {
  const next = { ...records };
  for (const window of weeklyWindows(rateLimits)) {
    if (!window.resetsAt || window.resetsAt * 1000 <= now) continue;
    if (next[window.id]?.lastResetAt === window.resetsAt) continue;
    next[window.id] = { ...next[window.id], lastResetAt: window.resetsAt };
  }
  return next;
}

// A probe is due when a known weekly reset has passed and this cycle has not
// been probed successfully. Failed or interrupted attempts retry after a
// cooldown instead of waiting for the next weekly window.
function dueWeeklyProbe({ rateLimits, records = {}, now = Date.now(), retryMs = PROBE_RETRY_MS }) {
  const due = [];
  for (const window of weeklyWindows(rateLimits)) {
    const record = records[window.id] || {};
    const resetAt = window.resetsAt ?? record.lastResetAt ?? null;
    if (!Number.isFinite(resetAt) || resetAt * 1000 > now) continue;
    if (record.probe?.resetAt === resetAt) continue;
    if (Number.isFinite(record.lastAttemptAt) && now - record.lastAttemptAt < retryMs) continue;
    due.push({ id: window.id, resetAt });
  }
  return due;
}

// The earliest known future weekly reset, in seconds, for a targeted check.
function nextWeeklyReset(rateLimits, now = Date.now()) {
  let next = null;
  for (const window of weeklyWindows(rateLimits)) {
    if (!window.resetsAt || window.resetsAt * 1000 <= now) continue;
    if (next === null || window.resetsAt < next) next = window.resetsAt;
  }
  return next;
}

function markWeeklyAttempt(records, due, now = Date.now()) {
  const next = { ...records };
  for (const item of due) next[item.id] = { ...next[item.id], lastAttemptAt: now };
  return next;
}

function markWeeklyProbe(records, due, { at = new Date(), warning = '' } = {}) {
  const next = { ...records };
  for (const item of due) next[item.id] = { ...next[item.id],
    probe: { resetAt: item.resetAt, sentAt: at.toISOString(), ...(warning ? { warning } : {}) } };
  return next;
}

function markWeeklyFailure(records, due, { at = new Date(), error = '' } = {}) {
  const next = { ...records };
  for (const item of due) next[item.id] = { ...next[item.id], lastAttemptAt: at.getTime(),
    failedAt: at.toISOString(), error: String(error).slice(0, 200) };
  return next;
}

module.exports = { WEEKLY_MINUTES, PROBE_RETRY_MS, weeklyWindows, observeWeekly, dueWeeklyProbe,
  nextWeeklyReset, markWeeklyAttempt, markWeeklyProbe, markWeeklyFailure };
