'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaModelLevels = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const DEFAULT_LEVELS = ['low', 'medium', 'high'];
  const LABELS = { off: 'Off', none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
  const canonical = model => String(model || '').replace(/:cloud$/, '');
  function normalizeThinking(thinking) {
    if (!thinking || !Array.isArray(thinking.values) || thinking.values.length > 32) return undefined;
    if (!thinking.values.every(value => typeof value === 'boolean' || typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(value))) return undefined;
    const values = [...new Set(thinking.values)];
    return { values, ...(values.includes(thinking.default) ? { default: thinking.default } : {}) };
  }
  function thinkingFor(model, catalog) {
    if (!catalog) return undefined;
    if (catalog.thinking) return normalizeThinking(catalog.thinking);
    if (catalog.enabled === false) return undefined;
    const id = canonical(model);
    const reported = normalizeThinking(catalog.modelThinking?.[id]);
    if (reported) return reported;
    const metadata = (catalog.providers || []).filter(provider => provider.enabled !== false && provider.keys?.some(key => key.enabled !== false))
      .flatMap(provider => provider.models || []).filter(entry => canonical(entry.id) === id)
      .map(entry => normalizeThinking(entry.thinking)).filter(Boolean);
    if (!metadata.length) return undefined;
    const values = metadata[0].values.filter(value => metadata.every(thinking => thinking.values.includes(value)));
    const defaultValue = metadata[0].default;
    return { values, ...(values.includes(defaultValue) && metadata.every(thinking => thinking.default === defaultValue) ? { default: defaultValue } : {}) };
  }
  function levelsFor(model, catalog) {
    const thinking = thinkingFor(model, catalog);
    if (!thinking) return DEFAULT_LEVELS.slice();
    return [...new Set(thinking.values.map(value => value === false ? 'none' : value === true ? 'high' : value))];
  }
  function labelFor(level, model, catalog) {
    const values = thinkingFor(model, catalog)?.values || [];
    if (level === 'none' && values.includes(false)) return 'Off';
    if (level === 'high' && values.includes(true) && !values.includes('high')) return 'On';
    return LABELS[level] || (level ? level[0].toUpperCase() + level.slice(1) : 'Default');
  }
  return { normalizeThinking, thinkingFor, levelsFor, labelFor };
});
