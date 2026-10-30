'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonLines } = require('../shared/json-lines');
const { validSessionId } = require('./claude-history');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verified runtime versions, not inferred feature introduction dates. Older
// or unknown custom runtimes keep the shared-history editing fallback.
function nativeEditingSupported(engine, version) {
  const floor = { claude: [2, 1, 312], grok: [1, 0, 70], kimi: [2, 4, 0] }[engine];
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/);
  if (!floor || !match) return false;
  for (let i = 0; i < floor.length; i++) {
    const actual = Number(match[i + 1]);
    if (actual !== floor[i]) return actual > floor[i];
  }
  return true;
}

// Only a native turn containing the observed request can supply its boundary.
// Cutting a user message that also injected a history bridge would lose that
// bridge, so those legacy turns keep the shared-history recovery path.
function matchesPrompt(text, prompt) {
  return typeof text === 'string' && Boolean(prompt)
    && !text.includes('Conversation context from earlier turns follows as JSON data.')
    && (text === prompt || text.endsWith('\n\n' + prompt));
}

function nativeEditOptions(engine, boundary) {
  if (engine === 'claude' && uuid.test(boundary?.resumeSessionAt) && uuid.test(boundary?.resumeDropsTurn))
    return { resumeSessionAt: boundary.resumeSessionAt, resumeDropsTurn: boundary.resumeDropsTurn };
  if (engine === 'grok' && Number.isSafeInteger(boundary?.targetPromptIndex) && boundary.targetPromptIndex >= 0)
    return { targetPromptIndex: boundary.targetPromptIndex };
  if (engine === 'kimi' && boundary?.undoCount === 1 && /^[a-f0-9]{64}$/.test(boundary.undoDigest || ''))
    return { undoCount: 1, undoDigest: boundary.undoDigest };
  if (engine === 'dsh' && Number.isSafeInteger(boundary?.atSeq) && boundary.atSeq >= 0)
    return { atSeq: boundary.atSeq };
  return null;
}

async function readBoundary(file, visit) {
  if (!file) return null;
  try {
    for await (const line of jsonLines(fs.createReadStream(file))) {
      if (line.trim()) visit(JSON.parse(line));
    }
    return true;
  } catch (error) {
    // A missing or incomplete native transcript cannot establish a safe cut.
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function claudeEditBoundary(file, prompt, userMessageId) {
  let lastUser;
  const read = await readBoundary(file, row => {
    if (row.type !== 'user' || row.isSidechain || row.isMeta) return;
    const content = row.message?.content;
    if (Array.isArray(content) && content.some(block => block.type === 'tool_result')) return;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
    if (text) lastUser = { text, resumeSessionAt: row.parentUuid, resumeDropsTurn: row.uuid };
  });
  return read && (!userMessageId || lastUser?.resumeDropsTurn === userMessageId) && matchesPrompt(lastUser?.text, prompt)
    ? nativeEditOptions('claude', lastUser) : null;
}

function grokUpdatesFile(home, sessionId) {
  if (!home || !validSessionId(sessionId)) return null;
  const root = path.join(home, 'sessions');
  try {
    for (const group of fs.readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const file = path.join(root, group.name, sessionId, 'updates.jsonl');
      if (fs.existsSync(file)) return file;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return null;
}

async function grokEditBoundary(file, prompt) {
  let lastUser;
  const read = await readBoundary(file, row => {
    const update = row.method === 'session/update' && row.params?.update;
    const index = update?._meta?.promptIndex;
    if (update?.sessionUpdate !== 'user_message_chunk' || update.content?.type !== 'text'
        || !Number.isSafeInteger(index) || index < 0) return;
    if (lastUser?.index === index) lastUser.text += update.content.text;
    else lastUser = { index, text: update.content.text };
  });
  // The native index is inclusive. To discard the last prompt, retain its
  // predecessor; the first prompt has no retained native prefix to fork.
  return read && matchesPrompt(lastUser?.text, prompt)
    ? nativeEditOptions('grok', { targetPromptIndex: lastUser.index - 1 }) : null;
}

module.exports = { nativeEditingSupported, nativeEditOptions, matchesPrompt, claudeEditBoundary, grokEditBoundary, grokUpdatesFile };
