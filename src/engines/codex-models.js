'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CODEX_API_TOOL_PROFILE = 'native-apply-patch-v3';
const nativeCatalog = require('./codex-metadata/models.json');
const fallbackPrompt = fs.readFileSync(path.join(__dirname, 'codex-metadata/fallback-prompt.md'), 'utf8');
const toolAwareFallbackPrompt = fallbackPrompt.replace(/^## (?:Planning|`update_plan`)\r?\n[\s\S]*?(?=^#{1,2} |$(?![\s\S]))/gm, '');

function nativeModel(model) {
  const suffix = /^[a-zA-Z0-9_-]+\/([^/]+)$/.exec(model)?.[1];
  return nativeCatalog.models.find(entry => model.startsWith(entry.slug) || suffix?.startsWith(entry.slug));
}

function needsApiToolProfile(model) {
  return Boolean(model) && nativeModel(model)?.tool_mode === 'code_mode_only';
}

function apiContextWindow(model, budget) {
  // An accepted prompt establishes a lower bound, not the model's maximum.
  // Passing that provisional budget to Codex as model_context_window makes
  // Codex repeatedly compact a healthy thread at the largest input observed
  // so far. Only explicit route limits may narrow the native model window.
  const explicit = (budget?.routes || []).filter(route =>
    ['configured', 'catalog', 'confirmed-upper-bound'].includes(route.source)
    && Number.isSafeInteger(route.cap) && route.cap > 0);
  return explicit.length ? Math.min(...explicit.map(route => route.cap))
    : nativeModel(model)?.context_window || 272000;
}

function writeModelCatalog(file, catalog) {
  // Native CLI versions still require base_instructions when model_messages
  // is present. Use the same prompt in both fields, including text discussions.
  const models = catalog.models.map(entry => ({ ...entry,
    base_instructions: entry.model_messages.instructions_template }));
  fs.writeFileSync(file, JSON.stringify({ ...catalog, models }));
}

function configureApiModel(config, home, model, contextWindow) {
  const target = path.join(home, 'camellia-api-models.json');
  const managed = config.model_catalog_json && path.resolve(config.model_catalog_json) === path.resolve(target);
  // An explicit user catalog owns its tool choices and model instructions.
  if (config.model_catalog_json && !managed) return;
  if (!model || nativeModel(model)) {
    if (managed) delete config.model_catalog_json;
    return;
  }
  // Match 0.160.1's unknown-model defaults, adding only its native patch tool.
  // Without this metadata Codex invokes apply_patch.bat through PowerShell;
  // Windows batch argument parsing truncates valid multiline patches.
  const fallback = {
    slug: model, display_name: model, description: null,
    default_reasoning_level: null, supported_reasoning_levels: [],
    shell_type: 'unified_exec', visibility: 'none', supported_in_api: true, priority: 99,
    model_messages: { instructions_template: toolAwareFallbackPrompt },
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: true, default_reasoning_summary: 'auto',
    supports_parallel_tool_calls: false,
    support_verbosity: false, apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'bytes', limit: 10000 },
    context_window: contextWindow || 272000, max_context_window: contextWindow || 272000, effective_context_window_percent: 95,
    experimental_supported_tools: [], input_modalities: ['text', 'image'],
  };
  writeModelCatalog(target, { models: [...nativeCatalog.models, fallback] });
  config.model_catalog_json = target;
}

module.exports = { configureApiModel, needsApiToolProfile, apiContextWindow, writeModelCatalog, CODEX_API_TOOL_PROFILE };
