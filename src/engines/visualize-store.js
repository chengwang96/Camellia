'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readJson, writeJson, writeText } = require('../shared/json-store');

const MAX_FRAGMENT_BYTES = 200000;
const MAX_STORED_BYTES = 20 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
// A conversation with hundreds of cards is not a working set any more: the
// history repaint and the phone's card list both degrade. Cap it explicitly
// instead of growing without bound.
const MAX_CARDS_PER_CONVERSATION = 60;
const MAX_NETWORK_ORIGINS = 4;
const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 500;
const STYLES = new Set(['whale', 'editorial', 'paper', 'sketch', 'terminal']);
const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const INDEX_FILE = 'index.json';
// Deleted card ids are remembered so a history row that still references the
// card renders as "deleted" instead of a load error.
const DELETED_FILE = 'deleted.json';
const MAX_TOMBSTONES = 500;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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
  const htmlFile = (id, cardId) => {
    if (!CARD_ID.test(String(cardId || ''))) throw new Error('Invalid visualization card');
    return path.join(conversationDir(id), cardId + '.html');
  };
  const indexPath = id => path.join(conversationDir(id), INDEX_FILE);
  const backupFile = (id, cardId) => {
    if (!CARD_ID.test(String(cardId || ''))) throw new Error('Invalid visualization card');
    return path.join(conversationDir(id), cardId + '.previous.html');
  };
  const revisionDir = (id, cardId) => cardFile(id, cardId).replace(/\.json$/, '.revisions');
  const readRevision = (id, cardId, revision) => {
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    const directory = revisionDir(id, cardId);
    try {
      const saved = readJson(path.join(directory, revision + '.json'), null);
      if (saved?.version !== 1 || saved.conversationId !== id || saved.cardId !== cardId
          || saved.revision !== revision || !CONTENT_HASH.test(saved.contentHash)) return null;
      return fs.existsSync(path.join(directory, saved.contentHash + '.html')) ? saved : null;
    } catch (error) {
      log('visualize: could not read card revision: ' + error.message);
      return null;
    }
  };
  const listRevisions = (id, card) => {
    const directory = revisionDir(id, card.cardId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter(name => /^[1-9]\d*\.json$/.test(name))
      .map(name => Number(name.slice(0, -5)))
      .filter(revision => revision < card.revision)
      .sort((first, second) => second - first)
      .map(revision => readRevision(id, card.cardId, revision))
      .filter(Boolean)
      .map(({ cardId, title, summary, revision, updatedAt }) =>
        ({ cardId, title, summary, revision, updatedAt }));
  };
  const saveRevision = (card, html) => {
    const contentHash = sha256(html);
    // An out-of-band edit is not the document recorded at this revision.
    if (card.contentHash && card.contentHash !== contentHash) return;
    const revision = Number.isSafeInteger(card.revision) ? card.revision : 1;
    const directory = revisionDir(card.conversationId, card.cardId);
    const document = path.join(directory, contentHash + '.html');
    if (!fs.existsSync(document)) writeText(document, html);
    writeJson(path.join(directory, revision + '.json'), { ...card, revision, contentHash });
  };
  const deletedPath = id => path.join(conversationDir(id), DELETED_FILE);
  const readDeleted = conversationId => {
    const saved = readJson(deletedPath(conversationId), null);
    if (!saved || saved.version !== 1 || !Array.isArray(saved.cards)) return [];
    return saved.cards.filter(entry => entry && CARD_ID.test(String(entry.cardId || '')));
  };
  const writeDeleted = (conversationId, entries) => {
    writeJson(deletedPath(conversationId), {
      version: 1,
      cards: entries.slice(-MAX_TOMBSTONES),
    });
  };

  // The index is a derived cache: every entry is rebuilt from the card's own
  // metadata, so a lost or stale index only costs one directory scan.
  const readIndex = conversationId => {
    const saved = readJson(indexPath(conversationId), null);
    if (!saved || saved.version !== 2 || !Array.isArray(saved.cards)) return null;
    return saved.cards.filter(card => card && CARD_ID.test(String(card.cardId || '')));
  };
  const writeIndex = (conversationId, cards) => {
    writeJson(indexPath(conversationId), {
      version: 2,
      updatedAt: Date.now(),
      cards: cards
        .map(({ cardId, title, summary, revision, createdAt, updatedAt, contentHash }) =>
          ({ cardId, title, summary, revision, createdAt, updatedAt, contentHash }))
        .sort((first, second) => (second.updatedAt || 0) - (first.updatedAt || 0)),
    });
  };
  const scanCards = conversationId => {
    const directory = conversationDir(conversationId);
    if (!fs.existsSync(directory)) return [];
    const cards = [];
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json') || name === INDEX_FILE || name === DELETED_FILE
          || name.endsWith('.state.json')) continue;
      const cardId = name.slice(0, -'.json'.length);
      if (!CARD_ID.test(cardId)) continue;
      const metadata = readJson(cardFile(conversationId, cardId), null);
      if (!metadata || metadata.version !== 1 || metadata.conversationId !== conversationId
          || metadata.cardId !== cardId) continue;
      cards.push(metadata);
    }
    return cards.sort((first, second) => (second.updatedAt || 0) - (first.updatedAt || 0));
  };
  const list = conversationId => {
    const indexed = readIndex(conversationId);
    if (indexed) return indexed;
    const cards = scanCards(conversationId);
    if (cards.length) {
      try { writeIndex(conversationId, cards); }
      catch (error) { log('visualize: could not rebuild the card index: ' + error.message); }
    }
    return cards;
  };
  const touchIndex = (conversationId, card) => {
    const cards = scanCards(conversationId);
    writeIndex(conversationId, cards);
    return card;
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
        layoutVersion: 2,
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
      const existing = scanCards(conversationId);
      if (existing.length >= MAX_CARDS_PER_CONVERSATION)
        throw new Error('This conversation already has ' + MAX_CARDS_PER_CONVERSATION
          + ' cards; delete an older card before creating another');
      const html = cleanFragment(fragment, MAX_STORED_BYTES);
      const stored = { ...clean, contentHash: sha256(html) };
      writeText(htmlFile(conversationId, cardId), html);
      writeJson(cardFile(conversationId, cardId), stored);
      touchIndex(conversationId, stored);
      return stored;
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
        contentHash: sha256(next),
      };
      saveRevision(current, previous);
      writeText(backupFile(conversationId, cardId), previous);
      writeText(htmlFile, next);
      writeJson(cardFile(conversationId, cardId), clean);
      touchIndex(conversationId, clean);
      return clean;
    },
    get(conversationId, cardId) {
      const metadata = readJson(cardFile(conversationId, cardId), null);
      if (!metadata || metadata.version !== 1 || metadata.conversationId !== conversationId || metadata.cardId !== cardId)
        throw new Error('Visualization card not found');
      const html = fs.readFileSync(htmlFile(conversationId, cardId), 'utf8');
      // A card edited around the tool (the file written directly instead of
      // through camellia_visualize) has no matching history record, so it
      // silently disappears from the conversation. Report it instead of
      // pretending the revision matches.
      const externalEdit = Boolean(metadata.contentHash) && sha256(html) !== metadata.contentHash;
      return { ...metadata, html, state: readState(conversationId, cardId), externalEdit };
    },
    getRevision(conversationId, cardId, revision) {
      const current = readJson(cardFile(conversationId, cardId), null);
      if (!current || current.version !== 1 || current.conversationId !== conversationId
          || current.cardId !== cardId) throw new Error('Visualization card not found');
      const saved = revision < current.revision && readRevision(conversationId, cardId, revision);
      if (!saved) throw new Error('Card version is unavailable');
      const html = fs.readFileSync(path.join(revisionDir(conversationId, cardId), saved.contentHash + '.html'), 'utf8');
      if (sha256(html) !== saved.contentHash) throw new Error('Card version is unavailable');
      return { ...saved, html, networkApproved: false };
    },
    cards(conversationId, { includeRevisions = false } = {}) {
      conversationDir(conversationId);
      const cards = list(conversationId);
      return includeRevisions ? cards.map(card => ({ ...card, revisions: listRevisions(conversationId, card) })) : cards;
    },
    removeCard(conversationId, cardId) {
      const metadata = readJson(cardFile(conversationId, cardId), null);
      if (!metadata || metadata.version !== 1 || metadata.conversationId !== conversationId
          || metadata.cardId !== cardId) throw new Error('Visualization card not found');
      fs.rmSync(htmlFile(conversationId, cardId), { force: true });
      fs.rmSync(backupFile(conversationId, cardId), { force: true });
      fs.rmSync(revisionDir(conversationId, cardId), { recursive: true, force: true });
      fs.rmSync(cardFile(conversationId, cardId), { force: true });
      fs.rmSync(stateFile(conversationId, cardId), { force: true });
      writeIndex(conversationId, scanCards(conversationId));
      // Keep a tombstone: the conversation row still names this card, and a
      // reload must show "deleted" rather than a load failure.
      writeDeleted(conversationId, [...readDeleted(conversationId).filter(entry => entry.cardId !== cardId),
        { cardId, title: metadata.title, deletedAt: Date.now() }]);
      return { ok: true, cardId };
    },
    deleted(conversationId, cardId) {
      const entry = readDeleted(conversationId).find(card => card.cardId === cardId);
      return entry ? { deleted: true, title: entry.title, deletedAt: entry.deletedAt } : null;
    },
    /**
     * Restore the document this conversation last recorded. Only meaningful
     * when the file was edited outside Camellia; a normal revision has nothing
     * to roll back to beyond the previous revision the user asked for.
     */
    revert(conversationId, cardId, { updatedAt = Date.now() } = {}) {
      const metadata = readJson(cardFile(conversationId, cardId), null);
      if (!metadata || metadata.version !== 1 || metadata.conversationId !== conversationId
          || metadata.cardId !== cardId) throw new Error('Visualization card not found');
      const file = backupFile(conversationId, cardId);
      if (!fs.existsSync(file)) throw new Error('No recorded version is available for this card');
      const recorded = fs.readFileSync(file, 'utf8');
      const current = fs.readFileSync(htmlFile(conversationId, cardId), 'utf8');
      saveRevision(metadata, metadata.contentHash === sha256(recorded) ? recorded : current);
      // Keep the rejected text so the rollback itself can be undone.
      writeText(backupFile(conversationId, cardId), current);
      const clean = {
        ...metadata,
        revision: Number.isSafeInteger(metadata.revision) ? metadata.revision + 1 : 2,
        updatedAt,
        contentHash: sha256(recorded),
      };
      writeText(htmlFile(conversationId, cardId), recorded);
      writeJson(cardFile(conversationId, cardId), clean);
      touchIndex(conversationId, clean);
      return clean;
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

module.exports = { createVisualizeStore, MAX_FRAGMENT_BYTES, MAX_STORED_BYTES, MAX_STATE_BYTES,
  MAX_NETWORK_ORIGINS, MAX_CARDS_PER_CONVERSATION };
