'use strict';

function accessible(manager, parentId, id = parentId) {
  const conversation = manager.get(id);
  if (id !== parentId && conversation.controlParentId !== parentId) throw new Error('Conversation is not owned by this caller');
  if (manager.workspaces.sessionMeta().archived[id]) throw new Error('Conversation is archived; ask the user to restore it');
  return conversation;
}

function view(manager, conversation) {
  const settings = manager.settings(conversation.currentEngine, conversation.id);
  return { id: conversation.id, title: conversation.title, engine: conversation.currentEngine,
    model: settings.model, thinking: settings.thinkingBudget || '', connection: settings.connection || 'api',
    activity: manager.activity(conversation.id), parent_id: conversation.controlParentId || null };
}

// A conversation anywhere on this device is described without touching its
// engine settings: the read tools must never change a model, connection or
// native session just because a transcript was inspected. Stored values are
// reported as they are, and `title` already reflects any rename.
function deviceView(manager, meta, conversation, archived = false) {
  const selected = conversation.engineSettings?.[conversation.currentEngine] || {};
  const connection = selected.connection || 'api';
  const model = connection === 'subscription' ? selected.subscriptionModel ?? selected.model ?? ''
    : conversation.apiModel ?? selected.model ?? '';
  const workspace = meta.workspaces.find(entry => entry.id === (meta.sessionWorkspace[conversation.id] || conversation.workspaceId));
  return { id: conversation.id, title: meta.titles[conversation.id] || conversation.title || '(New session)',
    engine: conversation.currentEngine, model,
    connection, workspace: workspace ? workspace.name : '',
    cwd: conversation.cwd || '', updated_at: conversation.updatedAt || 0,
    activity: manager.activity(conversation.id), archived, parent_id: conversation.controlParentId || null };
}

function deviceConversations(manager, { archived = false } = {}) {
  const meta = manager.workspaces.sessionMeta();
  return [...manager.items.values()]
    .filter(conversation => archived || !meta.archived[conversation.id])
    .map(conversation => deviceView(manager, meta, conversation, Boolean(meta.archived[conversation.id])))
    .sort((first, second) => second.updated_at - first.updated_at || first.id.localeCompare(second.id));
}

function searchTerms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
}

// Every term must occur in the same message, so a match is a real turn rather
// than two unrelated words somewhere in one long conversation. The newest
// matches come first and each row is quoted with the words around the hit.
// Search all stored visible messages; the result count is bounded, not the
// history being searched. An early turn must remain discoverable in a long chat.

function searchTranscripts(manager, query, limit) {
  const terms = searchTerms(query);
  if (!terms.length) throw new Error('Enter at least one search word');
  const meta = manager.workspaces.sessionMeta();
  const results = [];
  const candidates = [...manager.items.values()]
    .filter(conversation => !meta.archived[conversation.id])
    .sort((first, second) => second.updatedAt - first.updatedAt || first.id.localeCompare(second.id));
  for (const conversation of candidates) {
    const all = manager.messages(conversation);
    let hit = null;
    for (let index = all.length - 1; index >= 0; index--) {
      const row = all[index];
      const text = String(row.text || '');
      const lowered = text.toLowerCase();
      if (!terms.every(term => lowered.includes(term))) continue;
      const at = Math.max(...terms.map(term => lowered.indexOf(term)));
      hit = { seq: row.seq, role: row.role, at: Number(row.at) || 0, text: text.slice(Math.max(0, at - 160), at + 240) };
      break;
    }
    if (hit) results.push({ conversation: deviceView(manager, meta, conversation), messages: all.length, match: hit });
  }
  results.sort((first, second) => second.match.at - first.match.at || second.conversation.updated_at - first.conversation.updated_at);
  return results.slice(0, limit);
}

function configured(manager, conversation, args) {
  const selected = { ...manager.settings(conversation.currentEngine, conversation.id) };
  if (args.model === undefined && args.thinking === undefined) return selected;
  const models = manager.conversationModels(conversation.currentEngine, selected);
  const model = models.find(entry => entry.id === (args.model ?? selected.model));
  if (!model) throw new Error('Model is unavailable; list configured models first');
  if (args.thinking && !model.thinking.includes(args.thinking)) throw new Error('Unsupported thinking level; use a listed level or the empty default');
  if (args.model !== undefined && args.model !== selected.model) {
    selected.thinkingBudget = '';
    selected.contextWindow = model.contextWindow || 0;
  }
  if (args.model !== undefined) selected.model = args.model;
  if (args.thinking !== undefined) selected.thinkingBudget = args.thinking;
  return selected;
}

function saveSettings(manager, conversation, selected) {
  conversation.engineSettings[conversation.currentEngine] = {
    ...conversation.engineSettings[conversation.currentEngine],
    ...Object.fromEntries(['connection', 'permissionMode', 'thinkingBudget', 'contextWindow'].filter(key => selected[key] !== undefined).map(key => [key, selected[key]])),
    ...(selected.connection === 'subscription' ? { subscriptionModel: selected.model } : {}),
  };
  if (selected.connection !== 'subscription') conversation.apiModel = selected.model;
  manager.save(conversation);
  manager.publishActivity(conversation.id);
}

function callConversationTool(manager, parentId, name, args, active) {
  const parent = accessible(manager, parentId);
  const operation = name.slice('camellia_conversation_'.length);
  if (operation === 'list') return { ok: true, conversations: [...manager.items.values()]
    .filter(conversation => (conversation.id === parentId || conversation.controlParentId === parentId) && !manager.workspaces.sessionMeta().archived[conversation.id])
    .map(conversation => view(manager, conversation)) };
  // Device-wide reads. They are bounded and side-effect free, so unlike the
  // child-control operations below they stay available to children and
  // scheduled checks, which may need to recall earlier work.
  if (operation === 'sessions') return { ok: true, conversations: deviceConversations(manager, { archived: args.archived === true }) };
  if (operation === 'search') return { ok: true, query: String(args.query).trim(),
    results: searchTranscripts(manager, args.query, Number.isSafeInteger(args.limit) ? args.limit : 20) };
  // Reading a stored transcript is side-effect free, so any conversation on
  // the device may be inspected, not only an owned child. This branch does not
  // use the child view, which would consult and lazily write engine settings.
  if (operation === 'history') {
    const conversation = manager.get(args.conversation_id);
    const meta = manager.workspaces.sessionMeta(), messages = manager.messages(conversation);
    const older = Number.isSafeInteger(args.older_than) && args.older_than > 0 ? args.older_than : Infinity;
    const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 20;
    const eligible = messages.filter(row => row.seq < older);
    const page = eligible.slice(-limit);
    const oldest = page[0];
    return { ok: true, conversation: deviceView(manager, meta, conversation, Boolean(meta.archived[conversation.id])),
      count: messages.length, truncated: page.length < eligible.length,
      oldest_seq: oldest ? oldest.seq : null, archived: Boolean(meta.archived[conversation.id]),
      messages: page.map(row => ({ seq: row.seq, role: row.role, text: String(row.text || '').slice(0, 4000) })) };
  }
  if (operation === 'models') {
    const target = accessible(manager, parentId, args.conversation_id);
    return { ok: true, models: manager.conversationModels(target.currentEngine, manager.settings(target.currentEngine, target.id)) };
  }
  if (active.scheduledTaskId || parent.controlParentId) throw new Error('Automatic checks and tool-created children cannot control other conversations');
  if (operation === 'create' || operation === 'fork') {
    const fingerprint = JSON.stringify([operation, args.title, args.model ?? null, args.thinking ?? null]);
    const children = [...manager.items.values()].filter(conversation => conversation.controlParentId === parentId);
    const existing = children.find(conversation => conversation.controlRequestId === args.request_id);
    if (existing) {
      if (existing.controlFingerprint !== fingerprint) throw new Error('request_id was already used with different arguments');
      accessible(manager, parentId, existing.id);
      return { ok: true, conversation: view(manager, existing), replayed: true };
    }
    if (children.length >= 8) throw new Error('Child conversation limit reached (8); ask the user to remove unused children');
    const selected = configured(manager, parent, args);
    const child = operation === 'fork' ? manager.fork(parent.currentEngine, { sessionId: parent.id, title: args.title.trim() })
      : manager.create(parent.currentEngine, parent.workspaceId, args.title.trim(), parent.cwd);
    Object.assign(child, { controlParentId: parentId, controlRequestId: args.request_id, controlFingerprint: fingerprint,
      controlUserSeq: active.userSeq, controlHistoryBoundary: child.seq });
    saveSettings(manager, child, selected);
    return { ok: true, conversation: view(manager, child), shared_workspace: true };
  }
  const child = accessible(manager, parentId, args.conversation_id);
  if (child.id === parentId) throw new Error('This operation requires an owned child conversation');
  if (operation === 'read') {
    const all = manager.messages(child), recent = all.slice(-8);
    return { ok: true, conversation: view(manager, child), interrupted: Boolean(child.interrupted),
      requests: (child.controlSends || []).slice(-8).map(entry => ({ request_id: entry.requestId, state: entry.state, run_id: entry.runId, error: entry.error })),
      truncated: all.length > recent.length || recent.some(row => String(row.text || '').length > 4000),
      messages: recent.map(row => ({ role: row.role, text: String(row.text || '').slice(-4000), seq: row.seq })) };
  }
  if (operation === 'cancel') return manager.cancel({ sessionId: child.id }).catch(error => ({ ok: false, error: error.message }));
  if (operation === 'configure') {
    if (manager.busy(child.id)) throw new Error('Stop the child response before changing its settings');
    if (args.model === undefined && args.thinking === undefined) throw new Error('Provide model or thinking');
    saveSettings(manager, child, configured(manager, child, args));
    return { ok: true, conversation: view(manager, child) };
  }
  if (operation === 'send') {
    const fingerprint = args.prompt;
    const previous = (child.controlSends || []).find(entry => entry.requestId === args.request_id);
    if (previous) {
      if (previous.prompt !== fingerprint) throw new Error('request_id was already used with a different prompt');
      return { ok: true, conversation_id: child.id, state: previous.state, run_id: previous.runId, error: previous.error, replayed: true };
    }
    if (manager.busy(child.id)) throw new Error('Child is busy; read its state or cancel it first');
    if ((active.controlSendCount || 0) >= 32) throw new Error('Child send limit reached for this turn (32)');
    if ((child.controlSends || []).length >= 256) throw new Error('Child send history limit reached (256); create a new conversation');
    active.controlSendCount = (active.controlSendCount || 0) + 1;
    const entry = { requestId: args.request_id, prompt: fingerprint, state: 'starting' };
    const reservation = { cancelled: false };
    (child.controlSends ||= []).push(entry);
    manager.save(child);
    manager.controlStarts.set(child.id, reservation);
    const persist = () => {
      if (manager.items.get(child.id) !== child) return;
      try { manager.save(child); } catch (error) { manager.log('Child request persistence failed: ' + error.message); }
    };
    void manager.send(child.currentEngine, { sessionId: child.id, prompt: args.prompt }, { controlStart: reservation }).then(run => {
      if (!run.ok || !run.done) throw new Error(run.error || 'Child could not start');
      entry.runId = run.runId; entry.state = 'running'; persist();
      return run.done.then(result => {
        entry.state = result.subtype === 'stopped' ? 'stopped' : result.is_error ? 'error' : 'finished';
        if (result.is_error) entry.error = String(result.result || 'Child turn failed').slice(0, 2000);
        persist();
      });
    }).catch(error => {
      entry.state = reservation.cancelled ? 'stopped' : 'error'; entry.error = String(error.message || error).slice(0, 2000);
      persist();
    }).finally(() => {
      if (manager.controlStarts.get(child.id) === reservation) manager.controlStarts.delete(child.id);
      if (manager.items.get(child.id) === child) manager.publishActivity(child.id);
    }).catch(error => {
      manager.log('Child request cleanup failed: ' + error.message);
    });
    return { ok: true, conversation_id: child.id, state: entry.state, run_id: manager.active.get(child.id)?.facade.gen };
  }
  throw new Error('Unknown conversation operation');
}

module.exports = { callConversationTool };
