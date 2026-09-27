'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { resolveArtifacts } = require('../turn-artifacts');
const { collector } = require('../../shared/turn-artifacts');
const { fail } = require('./access');

function identity(conversation, canonical, stat) {
  return createHash('sha256').update(JSON.stringify([conversation.id, canonical, stat.size, stat.mtimeMs, stat.dev, stat.ino])).digest('hex');
}

function files(reader, device, conversationId) {
  const conversation = reader.conversation(device, conversationId);
  const rows = reader.manager.rows ? reader.manager.rows(conversation) : reader.manager.messages(conversation);
  const result = new Map();
  const turns = [];
  // A turn's tool events live in their own rows, so replay them to recover the
  // directories its commands ran in; the desktop resolves the same way. A turn
  // starts at its user row and its roots belong to every reply it produced.
  let turn = null;
  for (const row of rows) {
    if (row.role === 'user') { turn = collector(); continue; }
    if (row.role === 'tool') {
      if (turn && !row.internal) { try { turn.capture(JSON.parse(row.text)); } catch {} }
      continue;
    }
    if (row.internal || row.role !== 'assistant') continue;
    turns.push({ row, roots: turn ? [...turn.roots] : [] });
  }
  for (const { row, roots } of turns.reverse()) {
    const paths = Array.isArray(row.artifacts) ? row.artifacts.map(file => file?.path).filter(file => typeof file === 'string') : [];
    const text = Array.isArray(row.outputBlocks) ? row.outputBlocks.filter(block => block.phase === 'final_answer').map(block => block.text || '').join('\n') : row.text;
    for (const file of resolveArtifacts({ paths, text, cwd: conversation.cwd, roots })) {
      try {
        const canonical = fs.realpathSync.native(file.path);
        const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
        if (result.has(key)) continue;
        const stat = fs.statSync(canonical);
        if (!stat.isFile()) continue;
        result.set(key, { id: identity(conversation, canonical, stat), name: file.name, kind: file.kind,
          extension: file.extension, size: stat.size, modifiedAt: stat.mtimeMs, seq: row.seq, canonical });
      } catch {}
    }
  }
  return [...result.values()];
}

function listArtifacts(reader, device, conversationId, offset = 0) {
  const entries = files(reader, device, conversationId);
  return { artifacts: entries.slice(offset, offset + 100).map(({ canonical, ...file }) => file),
    nextOffset: entries.length > offset + 100 ? offset + 100 : null };
}

async function openArtifact(reader, device, conversationId, id) {
  const file = files(reader, device, conversationId).find(entry => entry.id === id);
  if (!file) fail(404, 'Artifact not found; refresh the list');
  let handle;
  try {
    handle = await fs.promises.open(file.canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    const canonical = await fs.promises.realpath(file.canonical);
    const conversation = reader.conversation(device, conversationId);
    if (!stat.isFile() || identity(conversation, canonical, stat) !== id) fail(404, 'Artifact changed; refresh the list');
    return { ...file, handle };
  } catch (error) {
    await handle?.close();
    if (error.status) throw error;
    fail(404, 'Artifact unavailable; refresh the list');
  }
}

module.exports = { listArtifacts, openArtifact };
