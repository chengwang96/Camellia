'use strict';

const routerConfig = require('../api/api-router-config');
const { levelsFor } = require('../shared/model-levels');

function conversationModels(engine, settings, { router, codex, kimi }) {
  if (settings.connection === 'subscription') {
    const account = engine === 'codex' ? codex() : engine === 'kimi' ? kimi() : null;
    if (!account?.account) return [];
    return (account.models || []).map(model => ({ id: model.id, name: model.displayName || model.name || model.id,
      thinking: (model.supportedReasoningEfforts || []).map(level => level.reasoningEffort).filter(level => typeof level === 'string'),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}) }));
  }
  const config = router();
  if (!routerConfig.hasRoutes(config)) return [];
  return routerConfig.publicState(config).models.map(id => ({ id, name: id, thinking: levelsFor(id),
    contextWindow: routerConfig.modelContextWindow(config, id) || 0 }));
}

module.exports = { conversationModels };
