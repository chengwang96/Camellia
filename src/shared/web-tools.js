'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaWebTools = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  function officialDeepSeek(provider) {
    return [provider.baseUrl, provider.anthropicBaseUrl].some(value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && !url.port
          && !url.username && !url.password && !url.search && !url.hash
          && /^(?:\/v1|\/anthropic(?:\/v1)?)?\/?$/.test(url.pathname);
      } catch { return false; }
    });
  }
  function availableProviders(config) {
    return (config?.providers || []).filter(provider => provider.enabled !== false && officialDeepSeek(provider)
      && provider.keys?.some(key => key.enabled !== false && (key.key?.trim() || key.maskedKey)));
  }
  function normalizeSettings(value = { provider: 'native' }) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['provider', 'providerId'].includes(key))
      || !['native', 'deepseek'].includes(value.provider)) throw new Error('Invalid web tool settings');
    if (value.provider === 'native') return { provider: 'native' };
    if (typeof value.providerId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.providerId)
      || ['__proto__', 'constructor', 'prototype'].includes(value.providerId)) throw new Error('Choose a DeepSeek API provider');
    return { provider: 'deepseek', providerId: value.providerId };
  }
  return { officialDeepSeek, availableProviders, normalizeSettings };
});
