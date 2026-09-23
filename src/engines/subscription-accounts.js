'use strict';

// Subscription accounts are the signed-in provider logins that the official
// CLIs own: Kimi, ChatGPT and Google. Each engine keeps one entry per account.
// Kimi and Codex isolate credentials by home directory, so several accounts can
// stay signed in at once. Antigravity's official CLI keeps a single global
// Google credential, so it exposes one account (the default one).
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_ACCOUNT_ID = 'default';
const MAX_ACCOUNTS = 12;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function normalizeLabel(value) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60); }

// The default account always stays first: it keeps using the single home that
// earlier versions created, so an existing sign-in survives the upgrade.
function normalizeAccounts(value) {
  const stored = Array.isArray(value) ? value : [];
  const legacy = stored.find(item => String(item?.id ?? '').trim().toLowerCase() === DEFAULT_ACCOUNT_ID);
  const seen = new Set([DEFAULT_ACCOUNT_ID]);
  const accounts = [{ id: DEFAULT_ACCOUNT_ID, label: normalizeLabel(legacy?.label) }];
  for (const item of stored) {
    const id = String(item?.id ?? '').trim().toLowerCase();
    if (id === DEFAULT_ACCOUNT_ID || seen.has(id) || !ID_PATTERN.test(id)) continue;
    seen.add(id);
    accounts.push({ id, label: normalizeLabel(item?.label) });
    if (accounts.length >= MAX_ACCOUNTS) break;
  }
  return accounts;
}

function accountsFor(config, engine) {
  return normalizeAccounts(config?.subscriptionAccounts?.[engine]);
}

function activeAccountId(config, engine) {
  const requested = String(config?.subscriptionActive?.[engine] ?? '').trim().toLowerCase();
  const accounts = accountsFor(config, engine);
  return accounts.some(account => account.id === requested) ? requested : DEFAULT_ACCOUNT_ID;
}

function nextAccountId(accounts) {
  for (let index = 1; index <= MAX_ACCOUNTS + 1; index++) {
    const id = `account-${index}`;
    if (!accounts.some(account => account.id === id)) return id;
  }
  throw new Error('Too many accounts for this provider');
}

// `root` is the engine's original single-account subscription home. Only the
// default account uses it; every other account gets its own directory.
function accountHome({ userData, engine, id, root }) {
  return id === DEFAULT_ACCOUNT_ID ? root : path.join(userData, 'subscription-accounts', engine, id);
}

function windowsExhausted(windows) {
  return (windows || []).some(window => Number(window?.usedPercent) >= 100);
}

// Codex reports either one window group or a map of named groups, each with a
// primary and secondary window.
function rateLimitWindows(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return [];
  const groups = rateLimits.primary || rateLimits.secondary ? { default: rateLimits } : rateLimits;
  const windows = [];
  for (const group of Object.values(groups)) {
    if (!group || typeof group !== 'object') continue;
    for (const window of [group.primary, group.secondary]) if (window && typeof window === 'object') windows.push(window);
  }
  return windows;
}

// A provider-reported quota verdict, not a failure: an account whose window is
// fully used leaves rotation until the window resets.
function accountExhausted(engine, state) {
  if (!state) return false;
  if (engine === 'kimi') return windowsExhausted(state.usage?.windows);
  if (engine === 'codex') return windowsExhausted(rateLimitWindows(state.rateLimits));
  return false;
}

function accountSignedIn(engine, state) {
  if (!state) return false;
  if (engine === 'antigravity') return Boolean(state.models?.length || state.verifiedAt);
  return Boolean(state.account);
}

// The account already bound to a conversation wins, then the account selected
// in settings, then the remaining accounts in list order.
function orderAccountIds({ accounts, activeId, preferId }) {
  const ids = accounts.map(account => account.id);
  const order = [];
  for (const id of [preferId, activeId, ...ids]) if (id && ids.includes(id) && !order.includes(id)) order.push(id);
  return order;
}

function usableAccountId({ engine, accounts, states, activeId, preferId }) {
  const order = orderAccountIds({ accounts, activeId, preferId });
  const signedIn = order.filter(id => accountSignedIn(engine, states[id]));
  // Fall back to a signed-in account so an exhausted quota stays visible
  // instead of looking like a signed-out account; otherwise keep the choice.
  return signedIn.find(id => !accountExhausted(engine, states[id])) || signedIn[0] || order[0];
}

// A conversation that already ran on an account keeps it: native threads live
// inside that account's home, so only a new conversation may fail over to an
// account that still has quota.
function boundAccountId({ engine, accounts, states, activeId, preferId }) {
  if (preferId && accounts.some(account => account.id === preferId)) return preferId;
  return usableAccountId({ engine, accounts, states, activeId });
}

function accountSummary(engine, account, state = {}) {
  const detail = engine === 'codex' ? { email: state.account?.email || '', plan: state.account?.planType || '' }
    : engine === 'kimi' ? { email: state.account?.name || '', region: state.account?.region || '' } : {};
  return { id: account.id, label: account.label, active: false, signedIn: accountSignedIn(engine, state),
    exhausted: accountExhausted(engine, state), installed: state.installed !== false,
    loginPending: Boolean(state.loginPending), error: state.error || '', models: (state.models || []).length, ...detail };
}

function accountSummaries({ engine, accounts, states, activeId }) {
  return accounts.map(account => ({ ...accountSummary(engine, account, states[account.id]), active: account.id === activeId }));
}

// Keeps one account service per profile and delegates the active one, so
// callers that used a single account keep working unchanged.
function createAccountPool({ engine, userData, root, bindingsKey, loadConfig, saveConfig, createService, onState = () => {} }) {
  const services = new Map();
  const list = () => accountsFor(loadConfig(), engine);
  const activeId = () => activeAccountId(loadConfig(), engine);
  const bindings = () => bindingsKey ? loadConfig()[bindingsKey] || {} : {};
  function persist({ accounts, activeId: next }) {
    const config = loadConfig();
    saveConfig({ subscriptionAccounts: { ...config.subscriptionAccounts, [engine]: accounts || list() },
      subscriptionActive: { ...config.subscriptionActive, [engine]: next || activeId() } });
  }
  function service(id = activeId()) {
    const current = String(id);
    let value = services.get(current);
    if (!value) {
      const profile = list().find(account => account.id === current) || { id: current, label: '' };
      value = createService({ ...profile, home: accountHome({ userData, engine, id: current, root }) }, () => onState(state()));
      services.set(current, value);
    }
    return value;
  }
  // One unreadable account file must not take the whole account list down; the
  // row reports the problem instead.
  function safeState(id) {
    try { return service(id).state() || {}; }
    catch (error) { return { account: null, models: [], error: String(error.message || error).slice(0, 200) }; }
  }
  function states() { return Object.fromEntries(list().map(account => [account.id, safeState(account.id)])); }
  function state(id = activeId()) {
    const current = activeId();
    return { ...safeState(id), activeId: current,
      accounts: accountSummaries({ engine, accounts: list(), states: states(), activeId: current }) };
  }
  function select(id) {
    const next = String(id || '');
    if (!list().some(account => account.id === next)) throw new Error('Unknown account');
    persist({ activeId: next }); onState(state()); return state();
  }
  function add(label = '') {
    const accounts = list();
    if (accounts.length >= MAX_ACCOUNTS) throw new Error('Too many accounts for this provider');
    const id = nextAccountId(accounts);
    persist({ accounts: [...accounts, { id, label: normalizeLabel(label) }], activeId: id });
    service(id); onState(state()); return id;
  }
  function rename(id, label) {
    const accounts = list();
    if (!accounts.some(account => account.id === id)) throw new Error('Unknown account');
    persist({ accounts: accounts.map(account => account.id === id ? { ...account, label: normalizeLabel(label) } : account) });
    onState(state()); return state();
  }
  // The default account keeps its home directory so the legacy sign-in slot
  // survives; every other account owns a directory Camellia may delete.
  async function remove(id) {
    const current = String(id || '');
    if (!list().some(account => account.id === current)) throw new Error('Unknown account');
    const target = service(current);
    await target.signOut?.();
    if (current !== DEFAULT_ACCOUNT_ID) {
      services.delete(current);
      const dir = accountHome({ userData, engine, id: current, root });
      if (path.resolve(dir).startsWith(path.resolve(path.join(userData, 'subscription-accounts')) + path.sep)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      persist({ accounts: list().filter(account => account.id !== current), activeId: activeId() === current ? DEFAULT_ACCOUNT_ID : activeId() });
    }
    onState(state());
    return state();
  }
  // A conversation that already ran on an account keeps it; a new conversation
  // picks whichever signed-in account still has quota.
  function bind(sessionId) {
    const result = boundAccountId({ engine, accounts: list(), states: states(), activeId: activeId(),
      preferId: sessionId ? bindings()[sessionId] || null : null });
    if (sessionId && result && bindings()[sessionId] !== result) saveConfig({ [bindingsKey]: { ...bindings(), [sessionId]: result } });
    return result;
  }
  return { engine, list, activeId, states, state, select, add, rename, remove, bind, service,
    home: (id) => accountHome({ userData, engine, id: id || activeId(), root }),
    refresh: (id) => service(id).refresh(),
    refreshUsage: (options = {}, id) => service(id).refreshUsage(options),
    signIn: (id) => service(id).signIn(),
    signOut: (id) => service(id).signOut(),
    cancelLogin: (id) => service(id).cancelLogin(),
    openLogin: (id) => service(id).openLogin(),
    get active() { return [...services.values()].some(value => value.active); },
    async shutdown() { await Promise.allSettled([...services.values()].map(value => value.shutdown?.())); },
  };
}

module.exports = { DEFAULT_ACCOUNT_ID, MAX_ACCOUNTS, normalizeAccounts, accountsFor, activeAccountId, nextAccountId,
  accountHome, accountExhausted, accountSignedIn, rateLimitWindows, orderAccountIds, usableAccountId, boundAccountId,
  accountSummaries, accountSummary, createAccountPool };
