'use strict';

const { createHash } = require('node:crypto');
const { LEVELS } = require('../../engines/permission-levels');
const { fail } = require('./access');

// Engines that can run either a signed-in account or the shared API routes.
// Everything else has a single model source.
const DUAL_CONNECTION_ENGINES = new Set(['codex', 'kimi', 'antigravity']);

function connectionModels(manager, engine, selected, connection) {
  return manager.conversationModels(engine, { ...selected, connection }).map(model => ({ id: model.id, name: model.name || model.id,
    thinking: model.thinking || [], contextWindow: model.contextWindow, connection }));
}

// A conversation can run either its signed-in account or a shared API route,
// so both groups stay selectable in either direction. The active connection's
// list comes first and wins when both expose the same model id.
function selectableModels(manager, engine, selected) {
  const connection = selected.connection || 'api';
  const models = connectionModels(manager, engine, selected, connection);
  if (DUAL_CONNECTION_ENGINES.has(engine)) {
    const other = connection === 'subscription' ? 'api' : 'subscription';
    const known = new Set(models.map(model => model.id));
    for (const model of connectionModels(manager, engine, selected, other)) if (!known.has(model.id)) models.push(model);
  }
  return models;
}

function settingsView(manager, conversation) {
  const engine = conversation.currentEngine;
  const selected = manager.settings(engine, conversation.id);
  const connection = selected.connection || 'api';
  const native = selected.permissionMode || 'default';
  const permissionMode = LEVELS.includes(native) ? native : native === 'default' ? (engine === 'dsh' ? 'auto' : 'ask')
    : ({ acceptEdits: 'auto', 'workspace-write': 'auto', bypassPermissions: 'full', yolo: 'full', 'danger-full-access': 'full' }[native] || 'ask');
  const settings = { engine, connection, model: selected.model || '', thinking: selected.thinkingBudget || '', permissionMode,
    models: selectableModels(manager, engine, selected).map(model => ({ id: model.id, name: model.name, thinking: model.thinking, connection: model.connection })),
    permissionLevels: LEVELS };
  const version = createHash('sha256').update(JSON.stringify([settings, selected.connection, selected.permissionMode, selected.contextWindow])).digest('hex');
  return { ...settings, version, editable: !manager.busy(conversation.id) };
}

function configure(manager, conversation, payload) {
  const current = settingsView(manager, conversation);
  if (!current.editable) fail(409, 'Conversation is busy; stop it before changing settings');
  if (payload.expectedSettings !== current.version) fail(409, 'Settings changed; refresh before choosing again');
  const changes = payload.settings;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length
      || Object.keys(changes).some(key => !['model', 'thinking', 'permissionMode'].includes(key))
      || Object.values(changes).some(value => typeof value !== 'string')) fail(400, 'Invalid settings');
  const patch = { sessionId: conversation.id };
  if (changes.permissionMode !== undefined) {
    if (!LEVELS.includes(changes.permissionMode)) fail(400, 'Invalid permission level');
    patch.permissionMode = changes.permissionMode;
  }
  if (changes.model !== undefined || changes.thinking !== undefined) {
    const selected = manager.settings(conversation.currentEngine, conversation.id);
    const model = selectableModels(manager, conversation.currentEngine, selected).find(model => model.id === (changes.model ?? current.model));
    if (!model) fail(400, 'Model is unavailable; refresh the model list');
    if (changes.thinking && !model.thinking?.includes(changes.thinking)) fail(400, 'Unsupported thinking level');
    if (changes.model !== undefined) {
      patch.model = model.id;
      // Picking a model from the other group switches this conversation's
      // connection, exactly like choosing across groups in the desktop composer.
      if (model.id !== current.model || model.connection !== current.connection) {
        patch.thinkingBudget = ''; patch.contextWindow = model.contextWindow || 0;
      }
      if (model.connection !== current.connection) patch.connection = model.connection;
    }
    if (changes.thinking !== undefined) patch.thinkingBudget = changes.thinking;
  }
  manager.saveSettings(conversation.currentEngine, patch);
  manager.onEvent({ type: 'conversation:settings', session_id: conversation.id, engine: conversation.currentEngine });
  return { ok: true, state: 'accepted', settings: settingsView(manager, conversation) };
}

module.exports = { settingsView, configure };
