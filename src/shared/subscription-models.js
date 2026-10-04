'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaSubscriptionModels = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const ENGINES = Object.freeze(['codex', 'kimi', 'antigravity']);

  function isVisible(hiddenModels, engine, modelId) {
    const hidden = hiddenModels?.[engine];
    return !Array.isArray(hidden) || !hidden.includes(modelId);
  }

  function visibleModels(models, hiddenModels, engine) {
    return (models || []).filter(model => isVisible(hiddenModels, engine, model.id));
  }

  return { ENGINES, isVisible, visibleModels };
});
