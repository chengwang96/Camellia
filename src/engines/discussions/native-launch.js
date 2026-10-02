'use strict';

const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { validSessionId } = require('../claude-history');
const { valid: validPermission } = require('../permission-levels');

const launches = new WeakMap();
const SETTINGS = ['model', 'connection', 'permissionMode', 'thinkingBudget', 'proxyUrl', 'contextWindow', 'subscriptionId'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An in-process capability, not a serializable permission flag. A reviewed
// discussion policy supplies both the spawn configuration and the process
// factory so the ordinary driver's global config builder is never consulted.
// This establishes launch isolation, not a claim of read-only enforcement.
function createDiscussionLaunch({ engine, identity, cwd, nativeId, settings, launch }) {
  if (!['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(engine) || !UUID.test(identity?.runtimeId)
    || typeof cwd !== 'string' || !path.isAbsolute(cwd)
    || nativeId != null && !validSessionId(nativeId)
    || !settings || Object.keys(settings).some(key => !SETTINGS.includes(key))
    || typeof settings.model !== 'string' || !settings.model.trim()
    || !['api', 'subscription'].includes(settings.connection)
    || !validPermission(engine, settings.permissionMode)
    || typeof settings.thinkingBudget !== 'string' || typeof settings.proxyUrl !== 'string'
    || !Number.isSafeInteger(settings.contextWindow) || settings.contextWindow < 0
    || settings.connection === 'subscription' && (typeof settings.subscriptionId !== 'string' || !settings.subscriptionId.trim())
    || typeof launch?.buildSpec !== 'function' || typeof launch?.spawn !== 'function') {
    throw new Error('Discussion launch requires explicit settings and a scoped process launcher');
  }
  const token = Object.freeze({});
  const scope = Object.freeze({ engine, runtimeId: identity.runtimeId, cwd, nativeId: nativeId || null,
    settings: Object.freeze(structuredClone(settings)), buildSpec: launch.buildSpec.bind(launch), spawn: launch.spawn.bind(launch) });
  launches.set(token, { scope, active: true });
  return token;
}

function getDiscussionLaunch(opts, engine) {
  if (!Object.hasOwn(opts, 'discussionLaunch')) return null;
  const record = launches.get(opts.discussionLaunch), scope = record?.scope;
  if (!record?.active || scope.engine !== engine || scope.runtimeId !== opts.conversationId
    || scope.cwd !== opts.cwd || scope.nativeId !== (opts.sessionId || null)
    || opts.goalBridge || opts.workspaceId || opts.fork
    || !isDeepStrictEqual(opts.settings, scope.settings)) throw new Error('Invalid or expired discussion launch');
  return scope;
}

function buildDiscussionSpec(scope, runtime, settings) {
  const result = scope.buildSpec({ engine: scope.engine, runtime: structuredClone(runtime),
    runtimeId: scope.runtimeId, cwd: scope.cwd, nativeId: scope.nativeId, settings: structuredClone(settings) });
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new Error('Discussion spawn configuration must be synchronous');
  }
  if (!result || typeof result.exe !== 'string' || !path.isAbsolute(result.exe)
    || result.cwd !== scope.cwd || !Array.isArray(result.args) || result.args.some(arg => typeof arg !== 'string')
    || !result.env || typeof result.env !== 'object' || Array.isArray(result.env)
    || Object.values(result.env).some(value => typeof value !== 'string')) throw new Error('Invalid discussion spawn configuration');
  return { ...structuredClone(result), args: [...result.args], env: { ...result.env } };
}

function assertDiscussionPoolAccess(pool, opts, scope) {
  pool.assertAccess(opts);
  const current = pool.get(opts);
  if (scope && current) throw new Error('Discussion runtime is already occupied');
  if (current?.opts?.discussionLaunch && current.opts.discussionLaunch !== opts.discussionLaunch) {
    throw new Error('Native runtime is owned by a discussion');
  }
  if (opts.sessionId && [...pool.sessions.values()].some(session => session.opts?.discussionLaunch
    && (session.sessionId === opts.sessionId || session.opts.sessionId === opts.sessionId))) {
    throw new Error('Native session is owned by a discussion');
  }
}

function revokeDiscussionLaunch(token) {
  const record = token && launches.get(token);
  if (record) record.active = false;
}

module.exports = { createDiscussionLaunch, getDiscussionLaunch, buildDiscussionSpec, assertDiscussionPoolAccess, revokeDiscussionLaunch };
