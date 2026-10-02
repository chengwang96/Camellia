'use strict';

// Ordinary native transports and configuration, with discussion-owned storage.
const fs = require('node:fs');
const path = require('node:path');
const { writeJson } = require('../../shared/json-store');
const { codexSpawnSpec } = require('../codex-client');
const { antigravitySpawnSpec, subscriptionSpawnSpec } = require('../antigravity');
const { effectiveSelection } = require('../antigravity/subscription');
const { kimiSpawnSpec } = require('../kimi-session');
const { dshAcpSpec } = require('../dsh-session');
const { piSpec } = require('../pi-session');
const { nativeMode } = require('../permission-levels');

function resources(home, source, names = ['skills', 'commands', 'plugins']) {
  if (!source) return;
  for (const name of names) {
    const target = path.join(home, name), origin = path.join(source, name);
    if (path.resolve(target) === path.resolve(origin) || !fs.existsSync(origin) || fs.existsSync(target)) continue;
    fs.mkdirSync(home, { recursive: true });
    // Installed resources/configuration may be shared; native sessions and
    // transcripts always stay inside the member's own home.
    fs.symlinkSync(path.resolve(origin), target, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
function nativeToolSpec({ runtime, home, cwd, env, node, profile, route, permissionMode, native = {}, models }) {
  const { engine, model, contextWindow, connection } = profile;
  resources(home, native.home);
  if (engine === 'codex') return codexSpawnSpec({ runtime, home, configHome: native.home || home,
    cwd, model, contextWindow, connection, route, env, allowUserQuestions: true });
  if (engine === 'claude') {
    let mcp = {}; try { mcp = JSON.parse(native.mcp || '{}').mcpServers || {}; } catch { throw new Error('Invalid Claude MCP configuration'); }
    const mcpFile = path.join(home, 'mcp.json'); writeJson(mcpFile, { mcpServers: mcp });
    const routeEnv = { ANTHROPIC_BASE_URL: route.baseUrl, ANTHROPIC_AUTH_TOKEN: route.authToken, ANTHROPIC_API_KEY: '' };
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) routeEnv[key] = model;
    const config = { ...native.config, model, env: { ...native.config?.env, ...routeEnv } };
    writeJson(path.join(home, 'settings.json'), config);
    return { exe: runtime.file, cwd, env: { ...env, ...routeEnv, CLAUDE_CONFIG_DIR: home }, args: ['-p', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--model', model,
      '--permission-mode', nativeMode(engine, permissionMode), '--mcp-config', mcpFile] };
  }
  if (engine === 'kimi') return { ...kimiSpawnSpec({ runtime: runtime.file, home, model, contextWindow, route, connection, env,
    config: native.config || {}, mcp: native.mcp || '' }), exe: node, cwd };
  if (engine === 'dsh') return { ...dshAcpSpec({ runtime, home, model, route, permissionMode, env, nativeConfig: native.config }), exe: node, cwd };
  if (engine === 'pi') return { ...piSpec({ runtime, home, sessionId: 'discussion', route, env,
    settings: { model, contextWindow, permissionMode, thinkingBudget: profile.thinking, instructions: native.instructions } }), exe: node, cwd };
  if (engine === 'antigravity' && connection === 'api') return { ...antigravitySpawnSpec({ runtime, home, route, env, config: native.config }), exe: runtime.file, cwd };
  if (engine === 'antigravity' && connection === 'subscription') {
    const legacy = path.join(cwd, '.agents/agents/camellia-discussion.md');
    if (fs.existsSync(legacy) && fs.lstatSync(legacy).isFile()
      && fs.readFileSync(legacy, 'utf8') === require('./text-runtimes').LEGACY_GOOGLE_AGENT) fs.unlinkSync(legacy);
    const google = path.join(env.HOME, '.gemini');
    resources(google, native.home, ['config', 'skills', 'extensions']);
    writeJson(path.join(google, 'antigravity-cli/settings.json'), { ...native.config, modelProvider: 'antigravity',
      permissions: { ...native.config?.permissions,
        allow: [...new Set([...(native.config?.permissions?.allow || []), 'read_file(*)', ...(permissionMode !== 'ask' ? ['write_file(*)'] : [])])] },
      toolPermission: permissionMode === 'full' ? 'always-proceed' : permissionMode === 'auto' ? 'proceed-in-sandbox' : 'request-review' });
    const selected = effectiveSelection(models, model, profile.thinking);
    // With literal input CLI 1.2.3 ignores --mode (it relies on slash expansion).
    // Apply the chosen native toolPermission in the private settings above.
    return { ...subscriptionSpawnSpec({ runtime, home, env, model: selected.model, effort: selected.thinking, literalInput: true,
      skipPermissions: permissionMode === 'full' }), noModes: true, exe: node, cwd };
  }
  throw new Error('Unknown discussion transport');
}
module.exports = { nativeToolSpec };
