'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { requestControl } = require('./local-control');
const { readPrivate } = require('./private-storage');
const { LIMIT } = require('./native-settings');

async function editNative({ dataDir, payload, editor = '/usr/bin/vi' }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Native editing requires an interactive server terminal');
  if (!path.isAbsolute(editor) || /[\x00-\x1f]/.test(editor)) throw new Error('Editor must be an absolute executable path without arguments');
  const result = await requestControl(dataDir, 'native-settings-get', { engine: payload.engine });
  if (!result.ok) throw new Error(result.error);
  const document = result.result.files.find(file => file.id === payload.id);
  if (!document || !result.result.editable) throw new Error('Choose a valid document and stop the engine before editing');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-native-edit-'));
  const file = path.join(directory, `configuration.${document.format === 'text' ? 'md' : document.format}`);
  try {
    fs.writeFileSync(file, document.text, { flag: 'wx', mode: 0o600 });
    const code = await new Promise((resolve, reject) => {
      const child = spawn(editor, [file], { stdio: 'inherit', shell: false });
      const stop = () => child.kill('SIGTERM');
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      const clear = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); };
      child.once('error', error => { clear(); reject(error); });
      child.once('exit', code => { clear(); resolve(code); });
    });
    if (code !== 0) throw new Error('Editor did not finish successfully; no settings saved');
    const text = readPrivate(file, LIMIT);
    if (text === document.text) { console.log('No changes.'); return; }
    const prompt = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
    let answer;
    try { answer = await prompt.question(`Save ${payload.engine}/${document.id} on this server (${dataDir})? Hooks/MCP may execute code. Type YES: `); }
    finally { prompt.close(); }
    if (answer.trim() !== 'YES') { console.log('Cancelled.'); return; }
    const saved = await requestControl(dataDir, 'native-settings-save', { engine: payload.engine, id: document.id, revision: document.revision, text, confirmed: true });
    if (!saved.ok) throw new Error(saved.error);
    console.log('Native settings saved. Applies to the next engine process; conversation overrides remain.');
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('camellia-native-edit-')) throw new Error('Unsafe temporary editor path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

module.exports = { editNative };
