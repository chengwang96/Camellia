'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./claude-harness.cjs');
const { readJson, writeJson } = require('../src/shared/json-store');

test('Kimi settings are isolated from Claude and cannot override centrally managed credentials', async () => {
  const h = createHarness();
  try {
    h.call('claude-save-settings', { model: 'claude-only', cwd: h.folder('Claude') });
    const result = await h.call('kimi-save-settings', { model: 'kimi-k2.5', permissionMode: 'default', contextWindow: 262144,
      baseUrl: 'https://unmanaged.invalid', apiKey: 'must-not-save', authToken: 'must-not-save' });
    assert.equal(result.ok, true);
    const settings = await h.call('kimi-get-settings');
    assert.equal(settings.contextWindow, 262144);
    assert.equal(settings.model, 'kimi-k2.5');
    assert.equal(h.call('claude-get-settings').model, 'claude-only');
    assert.equal(settings.apiKey, undefined);
    assert.equal(settings.baseUrl, undefined);
    assert.equal((await h.call('kimi-save-settings', { contextWindow: 0 })).ok, false);
    assert.equal((await h.call('kimi-save-settings', { permissionMode: 'bypassPermissions' })).ok, false);
    assert.equal((await h.call('kimi-get-settings')).permissionMode, 'default');
    const failed = await h.call('kimi-send', { prompt: 'No credentials configured' });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Camellia settings/);
    assert.equal(h.processes.length, 0);
  } finally { h.cleanup(); }
});

test('Kimi folders, independent sessions, pinning and archive share the sidebar contract without mixing Claude history', async () => {
  const h = createHarness();
  try {
    const cwd = h.folder('Kimi Workspace');
    h.seedSession('claude-only', cwd, 'Claude history');
    const ws = (await h.call('kimi-meta-op', { op: 'create-workspace', name: 'Kimi 工程', path: cwd })).workspace;
    const dir = path.join(h.userData, 'kimi-history', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const independentCwd = h.folder('Independent');
    for (const [id, folder] of [['kimi-one', cwd], ['kimi-free', independentCwd]]) fs.writeFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', cwd: folder, message: { role: 'user', content: 'Hello ' + id } }) + '\n');
    const file = path.join(h.userData, 'desktop-config.json');
    const config = readJson(file);
    config.kimiMeta.sessionWorkspace = { 'kimi-one': ws.id, 'kimi-free': null };
    config.kimiMeta.sessionCwd = { 'kimi-one': cwd, 'kimi-free': independentCwd };
    writeJson(file, config);
    let list = await h.call('kimi-list-sessions');
    assert.deepEqual(list.sessions.map(s => s.id).sort(), ['kimi-free', 'kimi-one']);
    assert.equal(list.workspaces[0].sessionCount, 1);
    assert.equal((await h.call('kimi-load-session', 'kimi-free')).cwd, independentCwd);
    assert.equal((await h.call('kimi-meta-op', { op: 'assign-session', sessionId: 'kimi-one', workspaceId: null })).ok, false);
    assert.equal((await h.call('kimi-meta-op', { op: 'toggle-pin', sessionId: 'kimi-one' })).ok, true);
    await h.call('kimi-rename-session', { id: 'kimi-one', title: '重命名 Kimi' });
    list = await h.call('kimi-list-sessions');
    assert.equal(list.sessions.find(s => s.id === 'kimi-one').title, '重命名 Kimi');
    assert.equal(list.sessions.find(s => s.id === 'kimi-one').pinned, true);
    await h.call('kimi-meta-op', { op: 'delete-workspace', id: ws.id });
    const independent = await h.call('kimi-load-session', 'kimi-one');
    assert.equal(independent.workspaceId, null);
    assert.equal(independent.cwd, cwd, 'Removing a sidebar folder must preserve Kimi native execution cwd');
    await h.call('kimi-archive-session', { id: 'kimi-one' });
    assert.equal((await h.call('kimi-list-sessions')).sessions.length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'kimi-one.jsonl')), true);
    assert.equal((await h.call('claude-list-sessions')).sessions.length, 1);
    assert.equal((await h.call('kimi-load-session', '../desktop-config')).ok, false);
  } finally { h.cleanup(); }
});
