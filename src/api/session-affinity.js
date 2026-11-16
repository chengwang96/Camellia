'use strict';

const PREFIX = '/session/';
const SAFE_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function normalizeSessionKey(value) {
  const key = String(value || '').trim();
  return SAFE_KEY.test(key) ? key : '';
}

function sessionAffinityPath(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  return key ? PREFIX + encodeURIComponent(key) : '';
}

function withSessionAffinity(route, sessionKey) {
  const path = sessionAffinityPath(sessionKey);
  if (!path) return route;
  const baseUrl = typeof route === 'string' ? route : route?.baseUrl;
  if (!baseUrl || baseUrl.includes(PREFIX)) return route;
  let url;
  try { url = new URL(baseUrl); } catch { return route; }
  // Scoped and thinking routes already own URL prefixes. Insert affinity
  // between them so either layer can still unwrap independently.
  const scope = /^\/scopes\/[^/]+/.exec(url.pathname)?.[0] || '';
  url.pathname = scope + path + url.pathname.slice(scope.length);
  const next = url.href.replace(/\/$/, '');
  return typeof route === 'string' ? next : { ...route, baseUrl: next };
}

function parseSessionAffinityPath(pathname) {
  if (!pathname.startsWith(PREFIX)) return { pathname };
  const rest = pathname.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  let key;
  try { key = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash)); }
  catch { return { pathname }; }
  key = normalizeSessionKey(key);
  if (!key) return { pathname };
  return { sessionKey: key, pathname: slash === -1 ? '/' : rest.slice(slash) || '/' };
}

function headerKey(headers, names) {
  for (const name of names) {
    const key = normalizeSessionKey(headers[name]);
    if (key) return key;
  }
  return '';
}

function jsonHeader(headers, name) {
  try { return JSON.parse(headers[name] || '{}'); } catch { return null; }
}

// Native clients identify a conversation in different ways. Camellia's route
// path is authoritative and is inherited by native subagents, because they
// continue the parent's context and should reuse its prompt cache. Without a
// path, a subagent gets a stable key of its own.
function requestSessionKey(req, body, pathKey = '') {
  const headers = req?.headers || {};
  const parent = headerKey(headers, ['x-camellia-session-key', 'x-claude-code-session-id',
    'x-session-affinity', 'x-session-id', 'session_id']);
  const metadata = jsonHeader(headers, 'x-codex-turn-metadata');
  const subagent = headers['x-claude-code-agent-id'] || headers['x-codex-parent-thread-id']
    || headers['x-openai-subagent'] || metadata?.subagent_kind || metadata?.thread_source === 'subagent';
  const child = subagent ? headerKey(headers, ['x-claude-code-agent-id', 'x-codex-parent-thread-id'])
    || normalizeSessionKey(metadata?.threadId)
    || normalizeSessionKey(metadata?.thread_id) || normalizeSessionKey(body?.prompt_cache_key) : '';
  if (pathKey) return pathKey;
  if (child) return 'subagent:' + child;
  if (parent) return parent;
  for (const value of [body?.prompt_cache_key, body?.session_id, body?.metadata?.session_id,
    body?.metadata?.conversation_id]) {
    const key = normalizeSessionKey(value);
    if (key) return key;
  }
  return '';
}

module.exports = { normalizeSessionKey, sessionAffinityPath, withSessionAffinity,
  parseSessionAffinityPath, requestSessionKey };
