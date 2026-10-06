'use strict';

// Reasoning-effort ladders for API-routed models, where neither the account
// catalog nor an ACP engine reports the supported levels. The provider's model
// list does not carry this information, so we infer from the model ID. Unknown
// models keep the conservative three-level default.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaModelLevels = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const DEFAULT_LEVELS = ['low', 'medium', 'high'];
  const BASE_LEVELS = ['low', 'medium', 'high', 'xhigh'];
  // Every Codex model exposes its own depth, so the ladder is per model rather
  // than one wide set: only the newest models add max and ultra, and GPT-5.5
  // stops at xhigh. Mirrors supported_reasoning_levels in
  // codex-metadata/models.json; the catalog-sync test keeps the two in step.
  const MODEL_LADDERS = [
    ['gpt-6-astra', [...BASE_LEVELS, 'max', 'ultra']],
    ['gpt-6.1-sol', [...BASE_LEVELS, 'max', 'ultra']],
    ['gpt-6-sol', [...BASE_LEVELS, 'max', 'ultra']],
    ['gpt-5.6-sol', [...BASE_LEVELS, 'max', 'ultra']],
    ['gpt-5.6-terra', [...BASE_LEVELS, 'max', 'ultra']],
    ['gpt-daybreak-blue-latest', [...BASE_LEVELS, 'max', 'ultra']],
    ['gpt-daybreak-red-latest', [...BASE_LEVELS, 'max', 'ultra']],
    ['gpt-6-luna', [...BASE_LEVELS, 'max']],
    ['gpt-5.6-luna', [...BASE_LEVELS, 'max']],
    ['codex-auto-review', [...BASE_LEVELS, 'max']],
    ['gpt-5.5', BASE_LEVELS.slice()],
  ].sort((a, b) => b[0].length - a[0].length);
  // Claude Code owns its effort flag, so its ladder is fixed instead of being
  // inferred from the routed model ID.
  const CLAUDE_LEVELS = ['off', 'low', 'medium', 'high', 'max'];
  function levelsFor(model) {
    const id = String(model || '').toLowerCase();
    const segment = id.split('/').pop();
    const known = MODEL_LADDERS.find(([slug]) => segment === slug || segment.startsWith(slug + '-'));
    return (known ? known[1] : DEFAULT_LEVELS).slice();
  }
  // Engine-aware ladder used by settings surfaces that do not have a composer
  // session to resolve account reasoning efforts from.
  function levelsForEngine(engine, model) {
    return engine === 'claude' ? CLAUDE_LEVELS.slice() : levelsFor(model);
  }
  return { levelsFor, levelsForEngine };
});
