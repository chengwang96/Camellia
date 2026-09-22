'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CODEX_API_TOOL_PROFILE = 'native-apply-patch-v2';
const nativeCatalog = require('./codex-metadata/models.json');
const fallbackPrompt = fs.readFileSync(path.join(__dirname, 'codex-metadata/fallback-prompt.md'), 'utf8');
const toolAwareFallbackPrompt = fallbackPrompt.replace(/^## (?:Planning|`update_plan`)\r?\n[\s\S]*?(?=^#{1,2} |$(?![\s\S]))/gm, '');

function nativeModel(model) {
  const suffix = /^[a-zA-Z0-9_-]+\/([^/]+)$/.exec(model)?.[1];
  return nativeCatalog.models.some(entry => model.startsWith(entry.slug) || suffix?.startsWith(entry.slug));
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
  // Match 0.154.0's unknown-model defaults, adding only its native patch tool.
  // Without this metadata Codex invokes apply_patch.bat through PowerShell;
  // Windows batch argument parsing truncates valid multiline patches.
  const fallback = {
    slug: model, display_name: model, description: null,
    default_reasoning_level: null, supported_reasoning_levels: [],
    shell_type: 'default', visibility: 'none', supported_in_api: true, priority: 99,
    model_messages: { instructions_template: toolAwareFallbackPrompt },
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: true, default_reasoning_summary: 'auto',
    support_verbosity: false, apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'bytes', limit: 10000 }, supports_parallel_tool_calls: false,
    context_window: contextWindow || 272000, max_context_window: contextWindow || 272000, effective_context_window_percent: 95,
    experimental_supported_tools: [], input_modalities: ['text', 'image'],
  };
  fs.writeFileSync(target, JSON.stringify({ models: [...nativeCatalog.models, fallback] }));
  config.model_catalog_json = target;
}

module.exports = { configureApiModel, CODEX_API_TOOL_PROFILE };
