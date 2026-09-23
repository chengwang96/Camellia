'use strict';

const routerConfig = require('../api/api-router-config');
const { levelsFor } = require('../shared/model-levels');

function conversationModels(engine, settings, { router, codex, kimi, antigravity }) {
  if (settings.connection === 'subscription') {
    // A conversation bound to one account lists that account's models.
    const account = engine === 'codex' ? codex(settings.subscriptionId) : engine === 'kimi' ? kimi(settings.subscriptionId)
      : engine === 'antigravity' ? antigravity?.(settings.subscriptionId) : null;
    if (!account || engine !== 'antigravity' && !account.account) return [];
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
