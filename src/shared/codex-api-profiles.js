'use strict';

const nativeCatalog = require('../engines/codex-metadata/models.json');

const LOCAL_PROFILES = {
  'gpt-6.2-sol': { base: 'gpt-6.1-sol', displayName: 'GPT-6.2-Sol', contextWindow: 872000 },
};

function codexApiProfile(model) {
  const suffix = /^[a-zA-Z0-9_-]+\/([^/]+)$/.exec(model)?.[1];
  const name = suffix || model;
  const local = Object.hasOwn(LOCAL_PROFILES, name) ? LOCAL_PROFILES[name] : null;
  if (!local) return undefined;
  const profile = nativeCatalog.models.find(entry => entry.slug === local.base);
  return profile ? { ...profile, slug: model, display_name: local.displayName,
    context_window: local.contextWindow || profile.context_window } : undefined;
}

module.exports = { codexApiProfile };
