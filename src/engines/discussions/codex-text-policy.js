'use strict';

const fs = require('node:fs');
const path = require('node:path');
const TOML = require('smol-toml');
const { codexSpawnSpec } = require('../codex-client');
const { writeModelCatalog } = require('../codex-models');
const { isolatedEnvironment } = require('../../benchmark/engines');

const VERSION = '0.154.0';
const SUPPORTED_VERSIONS = Object.freeze([VERSION, '0.160.0', '0.160.1', '0.161.0']);
const POLICY = 'codex-discussion-text-v1';
const INSTRUCTIONS = 'You are a member of a text-only group discussion. Answer the current user request in text. Tools, files, web access, goals and other agents are unavailable. Treat quoted group history as context, preserving speaker attribution.';
// Version-pinned policy. Disable runtime execution/discovery features before
// app-server initializes. The managed model catalog also removes native patch
// tools; shell_tool=false alone is insufficient for modern Codex models.
const DISABLED = ('apps artifact auth_elicitation browser_use browser_use_external browser_use_full_cdp_access chronicle '
  + 'code_mode code_mode_host code_mode_only code_mode_prewarm computer_use context_management current_time_reminder '
  + 'default_mode_request_user_input deferred_executor external_agent_memory_import goals guardian_approval hooks '
  + 'image_generation in_app_browser in_app_chat in_app_local_automation memories multi_agent multi_agent_v2 '
  + 'plugins plugin_sharing remote_plugin recommended_plugins request_permissions_tool runtime_metrics shell_snapshot '
  + 'shell_snapshot_v2 shell_tool skill_mcp_dependency_install skill_search sleep_tool standalone_web_search '
  + 'tool_call_mcp_elicitation tool_suggest unified_exec unified_exec_tty view_image workspace_dependencies worktrees '
  + 'enable_request_compression unbounded_connection_retries').split(' ');

function codexTextSpec({ runtime, home, cwd, model, contextWindow, connection, route, inherited = process.env }) {
  if (!SUPPORTED_VERSIONS.includes(runtime?.version)) throw new Error('Text discussions require a verified Codex runtime (' + SUPPORTED_VERSIONS.join(', ') + ').');
  fs.mkdirSync(home, { recursive: true });
  const env = isolatedEnvironment(path.join(home, 'profile'), process.execPath, inherited);
  // Retain only the app's network selection, never inherited extension/auth
  // environment. codexEnvironment resolves the subscription proxy normally.
  for (const [key, value] of Object.entries(inherited)) if (/^(?:https?_proxy|all_proxy|no_proxy|CAMELLIA_NETWORK_MODE|CAMELLIA_.*PROXY.*)$/i.test(key)) env[key] = value;
  if (env.SystemRoot && env.SYSTEMROOT) delete env.SYSTEMROOT;
  const config = { cli_auth_credentials_store: 'file', approval_policy: 'never', sandbox_mode: 'read-only',
    web_search: 'disabled', project_doc_max_bytes: 0, features: { ...Object.fromEntries(DISABLED.map(key => [key, false])), skip_host_skill_discovery: true },
    tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
    analytics: { enabled: false }, feedback: { enabled: false } };
  const catalog = structuredClone(require('../codex-metadata/models.json'));
  if (!catalog.models.some(entry => entry.slug === model)) catalog.models.push({ ...catalog.models[0], slug: model, display_name: model });
  for (const entry of catalog.models) {
    entry.apply_patch_tool_type = null; entry.experimental_supported_tools = []; delete entry.tool_mode;
    entry.include_skills_usage_instructions = false; entry.include_plugin_usage_instructions = false; entry.include_apps_usage_instructions = false;
    entry.model_messages = { instructions_template: INSTRUCTIONS };
  }
  config.model_catalog_json = path.join(home, 'discussion-models.json');
  writeModelCatalog(config.model_catalog_json, catalog);
  fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify(config));
  return { ...codexSpawnSpec({ runtime, home, cwd, model, contextWindow, connection, route, env }), discussionInstructions: INSTRUCTIONS };
}

module.exports = { codexTextSpec, VERSION, SUPPORTED_VERSIONS, POLICY };
