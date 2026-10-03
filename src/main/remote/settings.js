'use strict';

const { createHash } = require('node:crypto');
const { LEVELS } = require('../../engines/permission-levels');
const { fail } = require('./access');

// Engines that can run either a signed-in account or the shared API routes.
// Everything else has a single model source.
const DUAL_CONNECTION_ENGINES = new Set(['codex', 'kimi', 'antigravity']);

function connectionModels(manager, engine, selected, connection) {
  return manager.conversationModels(engine, { ...selected, connection }).map(model => ({ id: model.id, name: model.name || model.id,
    thinking: model.thinking || [], contextWindow: model.contextWindow, supportsFast: model.supportsFast === true, connection }));
}

// A conversation can run either its signed-in account or a shared API route,
// so both groups stay selectable in either direction. The active connection's
// list comes first. Connection is part of identity, even for the same model id.
function selectableModels(manager, engine, selected) {
  const connection = selected.connection || 'api';
  const models = connectionModels(manager, engine, selected, connection);
  if (DUAL_CONNECTION_ENGINES.has(engine)) {
    const other = connection === 'subscription' ? 'api' : 'subscription';
    models.push(...connectionModels(manager, engine, selected, other));
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
    fastMode: selected.fastMode === true,
    models: selectableModels(manager, engine, selected).map(model => ({ id: model.id, name: model.name, thinking: model.thinking, connection: model.connection, supportsFast: model.supportsFast })),
    permissionLevels: LEVELS };
  const preferences = manager.loadConfig?.() || {};
  const quickModel = preferences.quickSwitchModels?.[engine];
  settings.quickSwitch = quickModel ? { model: quickModel, thinking: preferences.quickSwitchLevels?.[engine] || '',
    available: settings.models.some(m => m.id === quickModel) } : null;
  settings.supportsFast = engine === 'codex' && connection === 'subscription' && settings.models.some(m => m.connection === connection && m.id === settings.model && m.supportsFast);
  const version = createHash('sha256').update(JSON.stringify([settings, selected.connection, selected.permissionMode, selected.contextWindow])).digest('hex');
  const busy = manager.busy(conversation.id);
  return { ...settings, version, editable: !busy, modelEditable: true, appliesNextTurn: busy };
}

function configure(manager, conversation, payload) {
  const current = settingsView(manager, conversation);
  if (payload.expectedSettings !== current.version) fail(409, 'Settings changed; refresh before choosing again');
  let changes = payload.settings;
  if (changes?.quickSwitch === true && Object.keys(changes).length === 1) {
    if (!current.quickSwitch?.available) fail(409, 'Set an available quick-switch default model on the desktop first');
    const model = current.models.find(m => m.id === current.quickSwitch.model && m.connection === current.connection)
      || current.models.find(m => m.id === current.quickSwitch.model);
    changes = { model: model.id, connection: model.connection, thinking: model.thinking.includes(current.quickSwitch.thinking) ? current.quickSwitch.thinking : '' };
  }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length
      || Object.keys(changes).some(key => !['model', 'connection', 'thinking', 'permissionMode', 'fastMode'].includes(key))
      || Object.entries(changes).some(([key, value]) => typeof value !== (key === 'fastMode' ? 'boolean' : 'string'))
      || changes.connection !== undefined && (!['api', 'subscription'].includes(changes.connection) || changes.model === undefined)) fail(400, 'Invalid settings');
  if (!current.editable && (changes.permissionMode !== undefined || changes.connection !== undefined && changes.connection !== current.connection))
    fail(409, 'Stop the reply before changing connection or permissions');
  const patch = { sessionId: conversation.id };
  if (changes.permissionMode !== undefined) {
    if (!LEVELS.includes(changes.permissionMode)) fail(400, 'Invalid permission level');
    patch.permissionMode = changes.permissionMode;
  }
  if (changes.model !== undefined || changes.thinking !== undefined) {
    const selected = manager.settings(conversation.currentEngine, conversation.id);
    const models = selectableModels(manager, conversation.currentEngine, selected);
    const model = models.find(model => model.id === (changes.model ?? current.model) && model.connection === (changes.connection ?? current.connection))
      || (changes.connection === undefined && models.find(model => model.id === changes.model));
    if (!model) fail(400, 'Model is unavailable; refresh the model list');
    if (!current.editable && model.connection !== current.connection) fail(409, 'Stop the reply before changing connection');
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
  if (changes.fastMode !== undefined) {
    const target = current.models.find(m => m.id === (patch.model ?? current.model) && m.connection === (patch.connection ?? current.connection));
    if (current.engine !== 'codex' || target?.connection !== 'subscription' || !target.supportsFast) fail(400, 'Fast mode is unavailable for this model');
    patch.fastMode = changes.fastMode;
  }
  manager.saveSettings(conversation.currentEngine, patch);
  manager.onEvent({ type: 'conversation:settings', session_id: conversation.id, engine: conversation.currentEngine });
  return { ok: true, state: 'accepted', appliesNextTurn: !current.editable, settings: settingsView(manager, conversation) };
}

module.exports = { settingsView, configure };
