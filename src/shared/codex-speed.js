'use strict';

// Both the composer and the engine use the account's catalog. Ultrafast is a
// separate tier and must never be selected by the Fast mode toggle.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaCodexSpeed = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  function fastTier(model) {
    if (!Array.isArray(model?.serviceTiers)) return null;
    return model.serviceTiers.find(tier => tier?.id === 'fast')
      || model.serviceTiers.find(tier => tier?.id === 'priority') || null;
  }
  return { fastTier };
});
