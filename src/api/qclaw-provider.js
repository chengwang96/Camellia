'use strict';

// Camellia reaches QClaw through the OpenAI-compatible gateway QClaw starts
// beside its own app. QClaw does not pin that gateway to a fixed port and it
// rotates the bearer token, so the router cannot store either one: it resolves
// them from QClaw's own state file on every configuration read. Nothing here
// talks to the network, and a missing or unreadable state directory just leaves
// the previously configured endpoint in place.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_DIRS = ['.qclaw-oversea', '.qclaw', '.openclaw'];
const DEFAULT_PORT = 28790;
// The router appends "/chat/completions" to a provider base URL, so the local
// gateway's OpenAI prefix has to be part of it.
const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}/v1`;

function stateDirs(environment = process.env) {
  const home = environment.USERPROFILE || environment.HOME || os.homedir();
  const override = String(environment.QCLAW_STATE_DIR || '').trim();
  return [...(override ? [override] : []), ...STATE_DIRS.map(dir => path.join(home, dir))];
}

// The gateway block is only usable when QClaw runs it locally over a token:
// any other shape (remote mode, OAuth, placeholder env vars) is left for the
// user to configure by hand.
function gatewayEndpoint(config) {
  const gateway = config?.gateway;
  if (!gateway || gateway.mode !== 'local') return null;
  const port = Number(gateway.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const token = typeof gateway.auth?.token === 'string' ? gateway.auth.token.trim() : '';
  if (!token || /[\s\x00-\x1f]/.test(token)) return null;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, token };
}

function discoverQclaw({ environment = process.env, files = fs } = {}) {
  for (const dir of stateDirs(environment)) {
    let raw;
    try { raw = files.readFileSync(path.join(dir, 'openclaw.json'), 'utf8'); } catch { continue; }
    let config;
    try { config = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { continue; }
    const found = gatewayEndpoint(config);
    if (found) return { ...found, stateDir: dir };
  }
  return null;
}

module.exports = { discoverQclaw, gatewayEndpoint, stateDirs, STATE_DIRS, DEFAULT_PORT, DEFAULT_BASE_URL };
