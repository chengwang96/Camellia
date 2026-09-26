#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { dataDirectory } = require('../src/cli/private-storage');
const { createHeadlessHost } = require('../src/cli/host');
const { listenControl, requestControl } = require('../src/cli/local-control');

function options(args) {
  const result = { action: args[0] || 'help', dataDir: dataDirectory(), payload: {} };
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--ascii') { result.ascii = true; continue; }
    if (args[index] === '--restore-network') { result.restoreNetwork = true; continue; }
    const name = args[index], value = args[++index];
    if (!['--data-dir', '--helper', '--key-file', '--payload', '--lang', '--hostname', '--editor'].includes(name) || !value) throw new Error('Invalid argument; use help');
    if (name === '--payload') result.payload = JSON.parse(value);
    else if (name === '--lang') { if (!['zh-CN', 'en'].includes(value)) throw new Error('Language must be zh-CN or en'); result.language = value; }
    else if (name === '--hostname') { if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new Error('Invalid Tailscale hostname'); result.hostname = value; }
    else {
      if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
      result[{ '--data-dir': 'dataDir', '--helper': 'executable', '--key-file': 'keyFile', '--editor': 'editor' }[name]] = value;
    }
  }
  if (result.restoreNetwork && !['serve', 'service-unit'].includes(result.action)) throw new Error('--restore-network is only valid for serve or service-unit');
  return result;
}

async function main(args = process.argv.slice(2)) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    console.log('Camellia / Linux server development preview\n'
      + 'node scripts/camellia-server.cjs serve [--data-dir /absolute/path] [--helper /path/camellia-tailnet] [--key-file /path/key] [--hostname camellia-server]\n'
      + 'node scripts/camellia-server.cjs ACTION [--data-dir /absolute/path] [--payload JSON]\n'
      + 'node scripts/camellia-server.cjs menu [--data-dir /absolute/path] [--lang zh-CN|en] [--ascii]\n'
      + 'node scripts/camellia-server.cjs native-edit --payload {"engine":"codex","id":"settings"} [--editor /usr/bin/vi]\n'
      + 'node scripts/camellia-server.cjs service-unit [--data-dir /absolute/path] [--helper /path/camellia-tailnet] [--key-file /path/key] [--hostname NAME] [--restore-network]\n'
      + 'service-unit only prints a systemd user unit; it never installs, starts or enables a service.\n'
      + 'Actions: state, settings, start, login, stop, logout, invite, approve, reject, revoke, workspaces, conversations, create-workspace, delete-workspace, create-conversation, set-model, set-language, set-api-enabled\n'
      + 'serve stays in foreground; --restore-network optionally restores already-paired networking without login prompts.\n'
      + 'start enables Tailscale; stop disables networking, not the server.\n'
      + 'Engine commands: runtime-state, runtime-install, account, engine-settings; native-login --payload {"engine":"claude"} (or codex) requires a terminal.\n'
      + 'DSH, Claude, Codex and Kimi plus Antigravity are wired. Native subscription sign-in happens on this server only.');
    return;
  }
  if (process.platform !== 'linux') throw new Error('The server entry point requires Linux; use preview:cli for the settings design');
  process.umask(0o077);
  const selected = options(args);
  if (selected.action === 'native-edit') { await require('../src/cli/native-editor').editNative(selected); return; }
  if (selected.action === 'native-login') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Native account login requires a server terminal');
    const response = await requestControl(selected.dataDir, selected.action, selected.payload);
    if (!response.ok) throw new Error(response.error);
    const spec = response.result;
    const env = { ...process.env, [spec.engine === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: spec.home };
    if (spec.engine === 'antigravity') {
      Object.assign(env, { HOME: spec.home, XDG_CONFIG_HOME: path.join(spec.home, '.config'), XDG_DATA_HOME: path.join(spec.home, '.local/share'), XDG_CACHE_HOME: path.join(spec.home, '.cache'), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
      for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_ADC_AUTH']) delete env[key];
    }
    for (const key of Object.keys(env)) if (/^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$|^CLAUDE_CODE_USE_(BEDROCK|VERTEX)$/.test(key)) delete env[key];
    for (const key of Object.keys(env)) if (/^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY)$/.test(key)) delete env[key];
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn(spec.executable, spec.args, { env, stdio: 'inherit', shell: false });
        const stop = () => child.kill('SIGTERM');
        process.on('SIGINT', stop); process.on('SIGTERM', stop);
        const cleanup = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); };
        child.once('error', error => { cleanup(); reject(error); });
        child.once('exit', code => { cleanup(); resolve(code ?? 1); });
      });
    } finally { await requestControl(selected.dataDir, 'native-login-release', { engine: spec.engine, token: spec.token }); }
    return;
  }
  if (selected.action === 'service-unit') {
    process.stdout.write(require('../src/cli/service-unit').serviceUnit(selected));
    return;
  }
  if (selected.action === 'menu') { await require('../src/cli/settings-console').runSettings(selected); return; }
  if (selected.action !== 'serve') {
    const result = await requestControl(selected.dataDir, selected.action, selected.payload);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const host = createHeadlessHost(selected);
  let control;
  try { control = await listenControl({ dataDir: selected.dataDir, command: host.command }); }
  catch (error) { await host.close(); throw error; }
  console.log('Camellia / Server CLI\nLocal control ready.\nLocal keyfile storage protects against other users, not theft of the entire data directory.');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await control.close(); await host.close(); }
    catch { console.error('Camellia shutdown failed; verify processes before removing the data lock.'); process.exitCode = 1; }
    finally { process.off('SIGINT', close); process.off('SIGTERM', close); }
  };
  process.on('SIGINT', close); process.on('SIGTERM', close);
  if (selected.restoreNetwork) {
    try { await host.startTrustedDevices(); console.log('Trusted-device network restoration checked. Use state to inspect connectivity.'); }
    catch { console.error('Trusted-device networking could not be restored. The local console remains available; use state and start to diagnose.'); }
  } else console.log('Network is disabled; use start to sign into Tailscale.');
}

if (require.main === module) void main().catch(error => {
  console.error('Camellia: ' + String(error.message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
  process.exitCode = 1;
});

module.exports = { main, options };
