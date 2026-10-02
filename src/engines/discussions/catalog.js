'use strict';

const { conversationModels } = require('../conversation-models');
const { createHash } = require('node:crypto');
const { UNKNOWN_CONTEXT_BUDGET } = require('../../api/context-capacity');
function apiAccountRef(provider, model) {
  const route = createHash('sha256').update(JSON.stringify([provider.baseUrl, provider.anthropicBaseUrl,
    provider.protocol, model.protocol, model.upstream])).digest('hex');
  return JSON.stringify({ providerId: provider.id, route });
}
function apiProviderRef(accountRef) {
  try {
    const { providerId, route } = JSON.parse(accountRef);
    return typeof providerId === 'string' && typeof route === 'string' ? JSON.stringify({ providerId, route }) : null;
  } catch { return null; }
}
const ENGINES = Object.freeze(['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi']);
const SUBSCRIPTIONS = new Set(['codex', 'kimi', 'antigravity']);
async function discussionCatalog({ router, codex, kimi, antigravity, contextWindow = () => 0 }) {
  const rows = [], google = await antigravity?.handlers['account-state']() || { accounts: [] };
  const sources = { router, codex: id => codex?.accountState(id), kimi: id => kimi?.state(id), antigravity: () => google };
  const config = router();
  for (const engine of ENGINES) {
    // Pin the provider and route. Its keys remain a router-managed pool, just
    // like ordinary chat; adding another key must not duplicate model choices.
    for (const provider of config.enabled ? config.providers : []) {
      if (!provider.enabled || !provider.keys.some(key => key.enabled)) continue;
      for (const model of provider.models) {
        rows.push({ label: model.id, providerId: provider.id, providerLabel: provider.name,
          accountLabel: provider.name,
          binding: { engine, connection: 'api', model: model.id, accountRef: apiAccountRef(provider, model),
            thinking: '', contextWindow: model.contextWindow || contextWindow(model.id) || UNKNOWN_CONTEXT_BUDGET } });
      }
    }
    if (!SUBSCRIPTIONS.has(engine)) continue;
    const account = sources[engine]();
    for (const entry of account?.accounts || []) {
      for (const model of conversationModels(engine, { connection: 'subscription', subscriptionId: entry.id }, sources)) {
        rows.push({ label: model.name, accountLabel: entry.label || entry.name || entry.id,
          binding: { engine, connection: 'subscription', model: model.id, accountRef: entry.id, thinking: '',
            // Some native subscription catalogs omit capacity. Use the same
            // conservative working budget as ordinary chat, not a claim about
            // the provider's maximum, so a configured model can still reply.
            contextWindow: model.contextWindow || contextWindow(model.id)
              || (engine === 'codex' ? require('../codex-metadata/models.json').models.find(entry => entry.slug === model.id)?.context_window : 0)
              || UNKNOWN_CONTEXT_BUDGET } });
      }
    }
  }
  return rows;
}
module.exports = { discussionCatalog, apiAccountRef, apiProviderRef, ENGINES, SUBSCRIPTIONS };
