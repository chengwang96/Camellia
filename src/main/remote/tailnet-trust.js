'use strict';

const { readJson, writeJson } = require('../../shared/json-store');

const MAX_USERS = 64;
const MAX_TAGS = 64;

function cleanText(value, limit = 320) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, limit);
}

function cleanIdentity(identity) {
  const source = identity && typeof identity === 'object' ? identity : {};
  const tags = Array.isArray(source.tags)
    ? [...new Set(source.tags.map(value => cleanText(value, 80)).filter(value => /^tag:[a-z0-9][a-z0-9-]{0,63}$/.test(value)))].slice(0, 32)
    : [];
  return {
    nodeId: cleanText(source.nodeId, 128),
    userId: cleanText(source.userId, 64),
    login: cleanText(source.login, 320),
    name: cleanText(source.name, 320),
    tags,
  };
}

function cleanList(value, predicate) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(entry => cleanText(entry, 320)).filter(predicate))].slice(0, 64);
}

class TailnetTrust {
  constructor({ file }) {
    this.file = file;
    const stored = readJson(file, {});
    this.state = {
      enabled: stored.enabled === true,
      autoApprove: stored.autoApprove === true,
      allowedUsers: cleanList(stored.allowedUsers, value => value.length > 0),
      allowedTags: cleanList(stored.allowedTags, value => /^tag:[a-z0-9][a-z0-9-]{0,63}$/.test(value)),
      ownerUserId: cleanText(stored.ownerUserId, 64),
      ownerLogin: cleanText(stored.ownerLogin, 320),
      ownerDisplayName: cleanText(stored.ownerDisplayName, 320),
      tailnetName: cleanText(stored.tailnetName, 320),
    };
  }

  save() {
    writeJson(this.file, this.state);
  }

  view() {
    return {
      ...this.state,
      ready: Boolean(this.state.ownerUserId || this.state.ownerLogin),
    };
  }

  setIdentity(identity = {}) {
    const userId = cleanText(identity.userId, 64);
    const login = cleanText(identity.login, 320);
    const displayName = cleanText(identity.displayName, 320);
    const tailnet = cleanText(identity.tailnet, 320);
    const next = { ...this.state,
      ownerUserId: userId || this.state.ownerUserId,
      ownerLogin: login || this.state.ownerLogin,
      ownerDisplayName: displayName || this.state.ownerDisplayName,
      tailnetName: tailnet || this.state.tailnetName,
    };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return this.view();
    this.state = next;
    this.save();
    return this.view();
  }

  update(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid Tailnet trust settings');
    const next = { ...this.state };
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new Error('Invalid Tailnet trust switch');
      next.enabled = patch.enabled;
    }
    if (patch.autoApprove !== undefined) {
      if (typeof patch.autoApprove !== 'boolean') throw new Error('Invalid automatic approval switch');
      next.autoApprove = patch.autoApprove;
    }
    if (patch.allowedUsers !== undefined) {
      if (!Array.isArray(patch.allowedUsers) || patch.allowedUsers.length > MAX_USERS
          || patch.allowedUsers.some(value => typeof value !== 'string' || !value.trim() || value.length > 320)) {
        throw new Error('Invalid Tailnet users');
      }
      next.allowedUsers = cleanList(patch.allowedUsers, value => value.length > 0);
    }
    if (patch.allowedTags !== undefined) {
      if (!Array.isArray(patch.allowedTags) || patch.allowedTags.length > MAX_TAGS
          || patch.allowedTags.some(value => typeof value !== 'string'
            || !/^tag:[a-z0-9][a-z0-9-]{0,63}$/.test(value.trim()))) {
        throw new Error('Invalid Tailnet tags');
      }
      next.allowedTags = cleanList(patch.allowedTags, value => /^tag:[a-z0-9][a-z0-9-]{0,63}$/.test(value));
    }
    if (!next.enabled) next.autoApprove = false;
    this.state = next;
    this.save();
    return this.view();
  }

  evaluate(rawIdentity) {
    if (!this.state.enabled) return { allowed: false, autoApprove: false, reason: 'disabled' };
    const identity = cleanIdentity(rawIdentity);
    if (!identity.nodeId || !identity.userId) return { allowed: false, autoApprove: false, reason: 'identity_unavailable' };
    const login = identity.login.toLowerCase();
    const ownerMatch = Boolean(this.state.ownerUserId && identity.userId === this.state.ownerUserId)
      || Boolean(this.state.ownerLogin && login === this.state.ownerLogin.toLowerCase());
    const userMatch = this.state.allowedUsers.some(value => {
      const entry = value.toLowerCase();
      return entry === identity.userId || Boolean(login && entry === login);
    });
    const tagMatch = identity.tags.some(tag => this.state.allowedTags.includes(tag));
    if (!ownerMatch && !userMatch && !tagMatch) {
      return { allowed: false, autoApprove: false, reason: this.state.ownerUserId || this.state.ownerLogin
        ? 'not_allowed' : 'identity_unavailable' };
    }
    return { allowed: true, autoApprove: this.state.autoApprove,
      reason: ownerMatch ? 'owner' : userMatch ? 'user' : 'tag' };
  }
}

module.exports = { TailnetTrust, cleanIdentity };
