'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson, writeText } = require('../shared/json-store');

const MAX_FRAGMENT_BYTES = 200000;
const MAX_STORED_BYTES = 20 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_NETWORK_ORIGINS = 4;
const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 500;
const STYLES = new Set(['whale', 'editorial', 'paper', 'sketch', 'terminal']);
const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function cleanTitle(value) {
  const title = String(value || '').trim();
  if (!title) throw new Error('Visualization title is required');
  if ([...title].length > MAX_TITLE_CHARS) throw new Error('Visualization title is too long');
  return title;
}

function cleanSummary(value) {
  const summary = String(value || '').trim();
  if ([...summary].length > MAX_SUMMARY_CHARS) throw new Error('Visualization summary is too long');
  return summary;
}

function cleanFragment(value, maxBytes = MAX_FRAGMENT_BYTES) {
  const fragment = String(value || '').trim();
  if (!fragment) throw new Error('Visualization fragment is required');
  if (Buffer.byteLength(fragment, 'utf8') > maxBytes)
    throw new Error('Visualization fragment exceeds ' + maxBytes + ' bytes');
  if (/<\!doctype\b|<\/?(?:html|head|body)\b/i.test(fragment))
    throw new Error('Visualization fragment must not contain html, head, body or doctype tags');
  return fragment;
}

function cleanState(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Visualization state must be a JSON object');
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('Visualization state must be JSON serializable');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES)
    throw new Error('Visualization state exceeds ' + MAX_STATE_BYTES + ' bytes');
  return JSON.parse(encoded);
}

function cleanNetworkOrigins(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Visualization network origins must be an array');
  const origins = [];
  for (const entry of value) {
    let url;
    try { url = new URL(String(entry || '')); }
    catch { throw new Error('Invalid visualization network origin'); }
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Visualization network origins must use HTTPS without credentials');
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  if (origins.length > MAX_NETWORK_ORIGINS)
    throw new Error('Visualization uses more than ' + MAX_NETWORK_ORIGINS + ' network origins');
  return origins;
}

function cleanMode(value) {
  return value === 'wide' ? 'wide' : 'card';
}

function cleanStyle(value) {
  return STYLES.has(value) ? value : 'whale';
}

function createVisualizeStore({ dir, log = () => {} }) {
  const root = path.resolve(dir);
  const conversationDir = id => {
    if (!CONVERSATION_ID.test(String(id || ''))) throw new Error('Invalid visualization conversation');
    return path.join(root, id);
  };
  const cardFile = (id, cardId) => {
    if (!CARD_ID.test(String(cardId || ''))) throw new Error('Invalid visualization card');
    return path.join(conversationDir(id), cardId + '.json');
  };
  const stateFile = (id, cardId) => {
    if (!CARD_ID.test(String(cardId || ''))) throw new Error('Invalid visualization card');
    return path.join(conversationDir(id), cardId + '.state.json');
  };
  const readState = (conversationId, cardId) => {
    try {
      const saved = readJson(stateFile(conversationId, cardId), null);
      if (!saved || saved.version !== 1 || saved.conversationId !== conversationId
          || saved.cardId !== cardId || !saved.state || typeof saved.state !== 'object'
          || Array.isArray(saved.state)) return null;
      return cleanState(saved.state);
    } catch (error) {
      log('visualize: could not read card state: ' + error.message);
      return null;
    }
  };
  return {
    create(conversationId, { title, mode, summary, style, fragment, networkOrigins, createdAt = Date.now() } = {}) {
      const cardId = randomUUID();
      const now = Date.now();
      const clean = {
        version: 1,
        cardId,
        conversationId,
        title: cleanTitle(title),
        mode: cleanMode(mode),
        style: cleanStyle(style),
        summary: cleanSummary(summary),
        networkOrigins: cleanNetworkOrigins(networkOrigins),
        networkApproved: false,
        revision: 1,
        createdAt,
        updatedAt: now,
      };
      const directory = conversationDir(conversationId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeText(path.join(directory, cardId + '.html'), cleanFragment(fragment, MAX_STORED_BYTES));
      writeJson(cardFile(conversationId, cardId), clean);
      return clean;
    },
    update(conversationId, cardId, { title, mode, summary, style, fragment, oldStr, newStr, networkOrigins, updatedAt = Date.now() } = {}) {
      const current = readJson(cardFile(conversationId, cardId), null);
      if (!current || current.version !== 1 || current.conversationId !== conversationId || current.cardId !== cardId)
        throw new Error('Visualization card not found');
      const htmlFile = path.join(conversationDir(conversationId), cardId + '.html');
      const previous = fs.readFileSync(htmlFile, 'utf8');
      let next = previous;
      if (fragment !== undefined) next = cleanFragment(fragment, MAX_STORED_BYTES);
      else if (oldStr !== undefined || newStr !== undefined) {
        const find = String(oldStr ?? ''), replace = String(newStr ?? '');
        if (!find) throw new Error('Visualization update requires old_str');
        const occurrences = previous.split(find).length - 1;
        if (occurrences !== 1) throw new Error('Visualization update old_str must match exactly once');
        next = previous.replace(find, () => replace);
      } else if (title === undefined && mode === undefined && summary === undefined && style === undefined
          && networkOrigins === undefined) {
        throw new Error('Visualization update requires fragment, old_str/new_str or metadata');
      }
      next = cleanFragment(next, MAX_STORED_BYTES);
      const nextOrigins = networkOrigins === undefined ? (current.networkOrigins || []) : cleanNetworkOrigins(networkOrigins);
      const originsChanged = JSON.stringify(nextOrigins) !== JSON.stringify(current.networkOrigins || []);
      const clean = {
        ...current,
        title: title === undefined ? current.title : cleanTitle(title),
        mode: mode === undefined ? current.mode : cleanMode(mode),
        style: style === undefined ? (current.style || 'whale') : cleanStyle(style),
        summary: summary === undefined ? current.summary : cleanSummary(summary),
        networkOrigins: nextOrigins,
        networkApproved: originsChanged ? false : current.networkApproved === true,
        networkApprovedAt: originsChanged ? null : current.networkApprovedAt || null,
        revision: Number.isSafeInteger(current.revision) ? current.revision + 1 : 2,
        updatedAt,
      };
      writeText(htmlFile, next);
      writeJson(cardFile(conversationId, cardId), clean);
      return clean;
    },
    get(conversationId, cardId) {
      const metadata = readJson(cardFile(conversationId, cardId), null);
      if (!metadata || metadata.version !== 1 || metadata.conversationId !== conversationId || metadata.cardId !== cardId)
        throw new Error('Visualization card not found');
      const html = fs.readFileSync(path.join(conversationDir(conversationId), cardId + '.html'), 'utf8');
      return { ...metadata, html, state: readState(conversationId, cardId) };
    },
    network(conversationId, cardId) {
      const metadata = readJson(cardFile(conversationId, cardId), null);
      if (!metadata || metadata.version !== 1 || metadata.conversationId !== conversationId
          || metadata.cardId !== cardId) throw new Error('Visualization card not found');
      return {
        cardId,
        networkOrigins: cleanNetworkOrigins(metadata.networkOrigins || []),
        networkApproved: metadata.networkApproved === true,
      };
    },
    setState(conversationId, cardId, value, { clear = false, updatedAt = Date.now() } = {}) {
      const metadata = readJson(cardFile(conversationId, cardId), null);
      if (!metadata || metadata.version !== 1 || metadata.conversationId !== conversationId
          || metadata.cardId !== cardId) throw new Error('Visualization card not found');
      const file = stateFile(conversationId, cardId);
      const state = clear || value === null || value === undefined ? null : cleanState(value);
      if (!state) {
        fs.rmSync(file, { force: true });
        return { state: null, updatedAt };
      }
      writeJson(file, { version: 1, cardId, conversationId, updatedAt, state });
      return { state, updatedAt };
    },
    setNetworkApproval(conversationId, cardId, approved, { updatedAt = Date.now() } = {}) {
      const metadata = readJson(cardFile(conversationId, cardId), null);
      if (!metadata || metadata.version !== 1 || metadata.conversationId !== conversationId
          || metadata.cardId !== cardId) throw new Error('Visualization card not found');
      const origins = cleanNetworkOrigins(metadata.networkOrigins || []);
      if (!origins.length) throw new Error('This visualization does not request network access');
      const clean = {
        ...metadata,
        networkOrigins: origins,
        networkApproved: approved === true,
        networkApprovedAt: approved === true ? updatedAt : null,
        updatedAt,
      };
      writeJson(cardFile(conversationId, cardId), clean);
      return clean;
    },
    async remove(conversationId) {
      const directory = conversationDir(conversationId);
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(error => {
        log('visualize: could not remove conversation cards: ' + error.message);
      });
    },
  };
}

module.exports = { createVisualizeStore, MAX_FRAGMENT_BYTES, MAX_STORED_BYTES, MAX_STATE_BYTES, MAX_NETWORK_ORIGINS };
