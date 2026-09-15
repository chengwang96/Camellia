'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { writeText } = require('../shared/json-store');

function readDocument(file) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') source = ''; else throw err; }
  const doc = YAML.parseDocument(source, { merge: true, prettyErrors: false });
  if (doc.errors.length) throw new Error(`${path.basename(file)}: Invalid YAML`);
  if (doc.contents == null) doc.contents = doc.createNode({});
  if (!YAML.isMap(doc.contents)) throw new Error(`${path.basename(file)}: Configuration must be a mapping`);
  return doc;
}

// Copy-on-write for aliases: override this branch without editing the shared
// anchor. Inherited maps are materialized only along the path being changed.
function mapAt(doc, keys) {
  let map = doc.contents;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let child = map.get(key, true);
    if (YAML.isAlias(child)) {
      child = doc.createNode({ '<<': child });
      map.set(key, child);
    } else if (child == null || (YAML.isScalar(child) && child.value == null)) {
      const inherited = keys.slice(0, i + 1).reduce((value, part) => value?.[part], doc.toJS());
      child = doc.createNode(inherited ?? {});
      map.set(key, child);
    }
    if (!YAML.isMap(child)) throw new Error(`Configuration entry ${keys.slice(0, i + 1).join('.')} must be a mapping`);
    map = child;
  }
  return map;
}

function readCredential(home, name) {
  return String(readDocument(path.join(home, '.credentials.yaml')).toJS()[name] ?? '');
}

function configureProvider(home, { providerId, apiKeyEnv, apiKey, model }) {
  const settingsFile = path.join(home, 'settings.yaml');
  const credentialsFile = path.join(home, '.credentials.yaml');
  const settings = readDocument(settingsFile);
  const credentials = readDocument(credentialsFile);
  const previous = settings.toJS()['agent-default-model'];
  const selection = mapAt(settings, ['agent-default-model']);
  selection.set('provider', providerId);
  selection.set('model', previous?.provider === providerId && previous.model ? previous.model : model);
  mapAt(settings, ['llm-pi-ai', 'providers', providerId]).set('apiKeyEnv', apiKeyEnv);
  if (!settings.has('permission')) settings.set('permission', settings.createNode({ defaultPreset: 'danger-full-access' }));
  if (apiKey) credentials.set(apiKeyEnv, apiKey);
  else credentials.delete(apiKeyEnv);
  // Parse and serialize both documents before replacing either file.
  const settingsText = String(settings), credentialsText = String(credentials);
  writeText(credentialsFile, credentialsText);
  writeText(settingsFile, settingsText);
}

function syncPoolProvider(file, { active, port, models, hasOllama }) {
  const doc = readDocument(file);
  const providers = doc.toJS()['llm-pi-ai']?.providers;
  let changed = false;
  if (active && models.length) {
    const pool = mapAt(doc, ['llm-pi-ai', 'providers', 'api-pool']);
    const fields = {
      displayName: "API route pool", apiKeyEnv: 'DSH_API_ROUTER_KEY',
      api: 'anthropic-messages', baseURL: `http://127.0.0.1:${port}`,
      defaultContextWindow: 65536, defaultMaxTokens: 8192,
    };
    for (const [key, value] of Object.entries(fields)) pool.set(key, value);
    pool.set('models', doc.createNode(models.map(id => ({ id }))));
    if (!doc.has('agent-default-model')) doc.set('agent-default-model', doc.createNode({ provider: 'api-pool', model: models[0] }));
    changed = true;
  }
  // Keep the legacy Ollama provider working for existing DSH selections.
  if (hasOllama && providers?.ollama) {
    mapAt(doc, ['llm-pi-ai', 'providers', 'ollama']).set('baseURL', `http://127.0.0.1:${active ? port : 11434}/v1`);
    changed = true;
  }
  if (changed) writeText(file, String(doc));
}

function cleanupLegacyRoute(file) {
  if (!fs.existsSync(file)) return false;
  const doc = readDocument(file);
  const baseURL = doc.toJS()['llm-pi-ai']?.providers?.['opencode-go']?.baseURL;
  if (typeof baseURL !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/.test(baseURL)) return false;
  const provider = mapAt(doc, ['llm-pi-ai', 'providers', 'opencode-go']);
  if (provider.has('baseURL')) provider.delete('baseURL');
  const remaining = doc.toJS()['llm-pi-ai'].providers['opencode-go'];
  if (remaining.baseURL) {
    // Materialize this legacy branch when the URL came from a merge; null is
    // not a valid baseURL in DSH's provider schema.
    delete remaining.baseURL;
    doc.setIn(['llm-pi-ai', 'providers', 'opencode-go'], doc.createNode(remaining));
  }
  writeText(file, String(doc));
  return true;
}

module.exports = { configureProvider, readCredential, syncPoolProvider, cleanupLegacyRoute };
