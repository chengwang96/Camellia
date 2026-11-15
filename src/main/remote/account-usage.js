'use strict';

const { dayId, FIELDS } = require('../../api/api-usage');

const STATS = [...FIELDS, 'estimatedCostUsd', 'pricedTokens', 'unpricedTokens', 'approximateTokens'];
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const stats = value => Object.fromEntries(STATS.map(key => [key, count(value?.[key])]));
const label = value => typeof value === 'string' ? value.slice(0, 256) : '';
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function add(target, source) {
  for (const key of STATS) target[key] += count(source?.[key]);
  return target;
}

// This is an explicit projection. Router configuration, upstream errors, quota
// raw payloads and account histories can contain credentials and never cross it.
function quota(info = {}, capability = {}, fallback = {}) {
  const latest = info.latest || fallback;
  return {
    supported: capability.supported === true || Boolean(info.latest || fallback.checkedAt),
    updatedAt: timestamp(latest.at || latest.checkedAt),
    failed: Boolean(info.error || fallback.error), stale: Boolean(fallback.stale),
    windows: (latest.windows || []).map(window => ({ id: label(window.id), label: label(window.label || window.id),
      usedPercent: typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null,
      remainingValue: typeof window.remainingValue === 'number' && Number.isFinite(window.remainingValue) ? window.remainingValue : null,
      unit: label(window.unit), resetsAt: timestamp(window.resetsAt) })),
    balances: (latest.balances || []).map(balance => ({ currency: label(balance.currency || balance.id),
      value: typeof balance.value === 'number' && Number.isFinite(balance.value) ? balance.value : null })),
  };
}

function accountUsageSnapshot({ router = {}, insights = {} } = {}, now = new Date()) {
  if (router.ok === false) throw new Error('Account usage is unavailable');
  const accounts = [], records = [], ranges = Object.fromEntries(['1', '7', '30', 'all'].map(range => [range, []]));
  function append(account, usage) { accounts.push(account); records.push({ account, usage: usage || {} }); }
  for (const provider of router.providers || []) for (const [index, key] of (provider.keys || []).entries()) {
    append({ id: 'api:' + key.id, source: 'api', provider: label(provider.name),
      label: label(key.name || key.maskedKey || `Key ${index + 1}`), enabled: provider.enabled !== false && key.enabled !== false,
      ...quota(insights.keys?.[key.id], insights.providers?.[provider.id], router.quota?.[key.id]) }, router.usage?.[key.id]);
  }
  for (const archived of router.usageArchive || []) {
    append({ id: 'archive:' + archived.id, source: 'api', provider: label(archived.providerName),
      label: label(archived.keyName || archived.maskedKey || 'Key'), enabled: false, archived: true, ...quota() }, archived.usage);
  }
  const subscriptions = new Map((insights.subscriptions || []).map(account => [account.id, account]));
  const recorded = new Map((router.subscriptionUsage?.accounts || []).filter(account => account.usage)
    .map(account => [account.id, account]));
  for (const id of new Set([...subscriptions.keys(), ...recorded.keys()])) {
    const current = subscriptions.get(id), history = recorded.get(id);
    append({ id: 'subscription:' + id, source: 'subscription', provider: label(current?.name || history?.provider || history?.engine),
      label: label(current?.label || history?.label || history?.accountId), enabled: Boolean(current),
      ...quota(current?.info, current?.capability) }, history?.usage);
  }
  const today = dayId(now);
  for (const range of Object.keys(ranges)) {
    const earliest = new Date(now); if (range !== 'all') earliest.setDate(earliest.getDate() - (Number(range) - 1));
    const min = range === 'all' ? '' : dayId(earliest);
    for (const { account, usage } of records) {
      const totals = new Map();
      if (range === 'all') {
        for (const [model, value] of Object.entries(usage.byModel || {})) totals.set(model, stats(value));
        const assigned = [...totals.values()].reduce(add, stats());
        const old = Object.fromEntries(STATS.map(key => [key, Math.max(0, count(usage[key]) - assigned[key])]));
        if (Object.values(old).some(Boolean)) totals.set('', old);
      } else {
        for (const [day, models] of Object.entries(usage.daily || {})) {
          if (day < min || day > today) continue;
          for (const [model, value] of Object.entries(models)) {
            if (!totals.has(model)) totals.set(model, stats());
            add(totals.get(model), value);
          }
        }
      }
      for (const [model, value] of totals) if (Object.values(value).some(Boolean)) {
        ranges[range].push({ accountId: account.id, model: label(model), ...value });
      }
    }
  }
  return { version: 1, updatedAt: now.toISOString(), accounts, ranges,
    usageFailed: Boolean(router.subscriptionUsage?.error) };
}

function createAccountUsage({ read, refresh, now = () => new Date() }) {
  let pending = null, failed = false, lastRefresh = -Infinity;
  const state = () => ({ ...accountUsageSnapshot(read(), now()), refreshing: Boolean(pending),
    refreshAvailable: typeof refresh === 'function', refreshFailed: failed });
  return {
    state,
    refresh() {
      if (refresh && !pending && now().getTime() - lastRefresh >= 60_000) {
        lastRefresh = now().getTime(); failed = false;
        pending = Promise.resolve().then(refresh).catch(() => { failed = true; }).finally(() => { pending = null; });
      }
      return state();
    },
  };
}

module.exports = { accountUsageSnapshot, createAccountUsage };
