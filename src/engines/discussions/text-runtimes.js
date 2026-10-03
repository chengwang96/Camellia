'use strict';

// Discussion launches use the same transports as ordinary chat, with private
// histories and native text policies. Credentials still use the selected route
// or official subscription login; no subscription falls back to an API key.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const YAML = require('yaml');
const { SessionPool } = require('../session-pool');
const { ClaudeHistory } = require('../claude-history');
const { ClaudeSession } = require('../claude-session');
const { AcpSession } = require('../acp-session');
const { CodexSession } = require('../codex-session');
const { PiSession, piSpec } = require('../pi-session');
const { kimiSpawnSpec } = require('../kimi-session');
const { dshAcpSpec } = require('../dsh-session');
const { subscriptionSpawnSpec } = require('../antigravity');
const { effectiveSelection } = require('../antigravity/subscription');
const { getDiscussionLaunch, buildDiscussionSpec } = require('./native-launch');
const { writeJson } = require('../../shared/json-store');

const VERSIONS = Object.freeze({ claude: '2.1.273', dsh: '0.1.5-rc.2', kimi: '2.0.0', pi: '0.73.1' });
const SUPPORTED_VERSIONS = Object.freeze({
  claude: Object.freeze([VERSIONS.claude, '2.1.287', '2.1.288']), dsh: Object.freeze([VERSIONS.dsh, '0.2.0-rc.2']),
  kimi: Object.freeze([VERSIONS.kimi, '2.1.1']), pi: Object.freeze([VERSIONS.pi]),
});
const DENY = ['read_file', 'write_file', 'command', 'unsandboxed', 'read_url', 'execute_url', 'mcp'].map(name => name + '(*)');
const LEGACY_GOOGLE_AGENT = '---\nname: camellia-discussion\ndescription: Camellia group discussion\n' +
  'tools: []\nmainAgent: true\nsubagent: false\ninheritCustomizations: false\n---\n' +
  'Participate in the discussion through text. Answer the user directly. Do not use tools or create tasks.\n';

function kimiCredentialFile(home, managed) {
  // Match the native CLI's OAuth key resolution, including regional accounts.
  const key = managed.providers['managed:kimi-code'].oauth.key || 'oauth/kimi-code';
  const name = key.startsWith('oauth/') ? key.slice(6) : key;
  if (!name || name.startsWith('.') || /[\\/:]/.test(name)) throw new Error('Invalid Kimi credential reference');
  return path.join(home, 'credentials', name + '.json');
}

function googleDiscussionSpec({ runtime, home, cwd, env, node, profile, models }) {
  const native = path.join(env.HOME, '.gemini/antigravity-cli');
  writeJson(path.join(native, 'settings.json'), { modelProvider: 'antigravity', enableTelemetry: false,
    permissions: { deny: DENY }, toolPermission: 'request-review', artifactReviewPolicy: 'request-review' });
  const agents = path.join(cwd, '.agents/agents'); fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'camellia-discussion.md'), LEGACY_GOOGLE_AGENT);
  const selected = effectiveSelection(models, profile.model, profile.thinking);
  return { ...subscriptionSpawnSpec({ runtime, home, env, model: selected.model, effort: selected.thinking,
    literalInput: true, discussion: true }), exe: node, cwd };
}

function extraTextSpec({ runtime, home, cwd, env, node, profile, route }) {
  const { engine, model, contextWindow, connection } = profile;
  if (engine === 'claude') {
    const mcp = path.join(home, 'mcp.json'); writeJson(mcp, { mcpServers: {} });
    const selected = Object.fromEntries(['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'].map(key => [key, model]));
    Object.assign(selected, { ANTHROPIC_BASE_URL: route.baseUrl, ANTHROPIC_AUTH_TOKEN: route.authToken, ANTHROPIC_API_KEY: '',
      CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    return { exe: runtime.file, cwd, env: { ...env, ...selected }, args: ['-p', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--model', model,
      '--tools', '', '--strict-mcp-config', '--mcp-config', mcp, '--setting-sources', '', '--disable-slash-commands',
      '--settings', JSON.stringify({ disableAllHooks: true })] };
  }
  if (engine === 'kimi') {
    // Kimi treats enabled:[] as "all". A nonempty allow-list with no native
    // tool names disables every builtin and MCP tool, including future ones.
    const spec = kimiSpawnSpec({ runtime: runtime.file, home, model, contextWindow, route, connection, env,
      config: { tools: { enabled: ['camellia_discussion_text_only'] } }, mcp: '{"mcpServers":{}}' });
    return { ...spec, exe: node, cwd };
  }
  if (engine === 'dsh') {
    const spec = dshAcpSpec({ runtime, home, model, route, permissionMode: 'ask', env });
    // Use the installed profile's actual tool rows instead of maintaining a
    // stale name list. A global native guard also rejects unadvertised calls.
    const base = fs.readFileSync(path.join(runtime.dir, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8');
    const ids = [...base.matchAll(/^\s+- id: ([\w-]+)/gm)].map(match => match[1]);
    const patch = path.join(home, 'discussion.patch.yml');
    const disabled = ids.filter(id => /^tool-/.test(id) || ['plan-mode', 'session-title-llm', 'skill-filesystem', 'subagent-spawn-in-process', 'subagent-fork-in-process'].includes(id));
    fs.writeFileSync(patch, YAML.stringify([...disabled.map(id => ({ id, disabled: true })), { insert: [{
      id: 'camellia-discussion-policy', name: path.join(__dirname, 'dsh-text-policy.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), inject: ['tools'],
    }] }]));
    spec.args.push('--patch', patch);
    return { ...spec, exe: node, cwd };
  }
  if (engine === 'pi') {
    const spec = piSpec({ runtime, home, sessionId: 'discussion', settings: { model, contextWindow, permissionMode: 'ask', thinkingBudget: profile.thinking }, route, env });
    // Keep the native RPC protocol and session format; no permission extension
    // or auto-discovered skills/templates are needed for text discussions.
    spec.args.splice(spec.args.indexOf('-e'), 2);
    spec.args.push('--no-tools', '--no-skills', '--no-prompt-templates', '--no-themes');
    return { ...spec, exe: node, cwd };
  }
  throw new Error('Unknown discussion transport');
}

function createTextSession(engine, options) {
  if (engine === 'claude') {
    const id = options.opts.sessionId || randomUUID();
    const spec = { ...options.spec, args: [...options.spec.args, options.opts.sessionId ? '--resume' : '--session-id', id] };
    let sequence = 0;
    const session = new ClaudeSession({ ...options, spec,
      spawn: (exe, args, launch) => options.spawn(exe, args, { ...launch, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }),
      onEvent: event => options.onEvent({ ...event, eventSeq: ++sequence }) });
    session.sessionId = id;
    session.open = async () => { if (session.dead) throw new Error('Claude discussion stopped'); };
    session.shutdown = async () => {
      // Claude flushes its native transcript on EOF. Killing it immediately
      // after a result can discard the just-created conversation before resume.
      if (!session.proc || session.closed) { session.kill(); return; }
      await new Promise(resolve => {
        const timer = setTimeout(() => { session.kill(); resolve(); }, 2000);
        session.proc.once('close', () => { clearTimeout(timer); resolve(); });
        session.proc.stdin.end();
      });
      session.kill();
    };
    return session;
  }
  const Session = engine === 'pi' ? PiSession : engine === 'codex' ? CodexSession : AcpSession;
  return new Session({ ...options, ...(engine === 'pi' ? { sessionId: options.opts.sessionId || randomUUID() } : {}) });
}

function extraDiscussionDrivers({ root, runtimes, registry }) {
  let generation = 0;
  return Object.fromEntries(Object.keys(VERSIONS).map(engine => {
    const sessions = new SessionPool(), history = new ClaudeHistory(path.join(root, 'transcripts', engine));
    return [engine, { sessions, history, ensure(opts) {
      const launch = getDiscussionLaunch(opts, engine);
      if (!launch || sessions.get(opts)) throw new Error('Discussion launch is unavailable or occupied');
      const settings = { ...launch.settings, cwd: opts.cwd };
      const spec = buildDiscussionSpec(launch, runtimes().locate(engine, settings.connection), settings);
      const session = createTextSession(engine, { gen: ++generation, name: engine, settings, opts, exe: spec.exe, spec, spawn: launch.spawn, history,
        log() {}, onSessionId() {}, onResult() {}, onEvent: event => registry.capture(engine, { ...event, conversationId: opts.conversationId }) });
      sessions.set(opts, session);
      try { session.start(); } catch (error) { session.kill?.(); throw error; }
      return session;
    } }];
  }));
}

module.exports = { VERSIONS, SUPPORTED_VERSIONS, DENY, LEGACY_GOOGLE_AGENT, kimiCredentialFile, googleDiscussionSpec, extraTextSpec, createTextSession, extraDiscussionDrivers };
