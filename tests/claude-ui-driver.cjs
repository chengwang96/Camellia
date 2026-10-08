'use strict';
const readline = require('node:readline');
const http = require('node:http');
const path = require('node:path');
const { readJson, writeJson } = require('../src/shared/json-store');
const { createHarness } = require('./claude-harness.cjs');
function createUiHarness(root) {
  const harness = createHarness(root, { respondToInterrupts: true });
  // The native CLI is faked by createHarness; skip downloads and title requests
  // while exercising the real shared-conversation IPC and persistence.
  harness.api.sharedConversations.prepare = async () => {};
  harness.api.sharedConversations.generateTitle = async message => String(message).slice(0, 80);
  return harness;
}
let h = createUiHarness();
const fixtures = { alpha: h.folder('Alpha Project'), beta: h.folder('Beta Project') };
fixtures.legacy = h.seedSession('legacy-chat', fixtures.alpha, '已有的独立会话');
const conversation = h.api.sharedConversations.create('claude', null, '已有的独立会话', fixtures.alpha);
h.api.sharedConversations.append(conversation, { role: 'user', engine: 'claude', text: '已有的独立会话' });
fixtures.conversationId = conversation.id;
const methods = {
  discussion: 'discussion', storageReferencesChanged: 'storage-references-changed',
  pluginCacheMaintain: 'plugin-cache-maintain',
  conversationCommand: 'conversation-command', conversationSwitch: 'conversation-switch',
  apiRouterGetState: 'api-router-get-state', apiRouterSaveConfig: 'api-router-save-config',
  apiRouterReset: 'api-router-reset', apiRouterRotate: 'api-router-rotate',
  providerInsights: 'provider-insights', providerRefresh: 'provider-refresh', providerModels: 'provider-models', providerVerify: 'provider-verify',
  engineSettingsGet: 'engine-settings-get', engineSettingsSave: 'engine-settings-save', runtimeState: 'runtime-state', runtimeEnsure: 'runtime-ensure',
  runtimePythonState: 'runtime-python-state',
  networkSettings: 'network-settings', networkSaveSettings: 'network-save-settings',
  downloadSettings: 'download-settings', downloadSaveSettings: 'download-save-settings',
  runtimeSetPath: 'runtime-set-path',
  subscriptionPreferencesGet: 'subscription-preferences-get', subscriptionPreferencesSave: 'subscription-preferences-save',
  antigravityAccountState: 'antigravity-account-state', antigravityAccountRefresh: 'antigravity-account-refresh', antigravitySignIn: 'antigravity-sign-in',
  antigravityAccountRefreshUsage: 'antigravity-account-refresh-usage',
  antigravityAccountLabel: 'antigravity-account-label',
  codexAccountState: 'codex-account-state', codexAccountRefresh: 'codex-account-refresh', codexSignIn: 'codex-sign-in',
  kimiAccountState: 'kimi-account-state',
  workbenchSettings: 'workbench-settings', workbenchSaveSettings: 'workbench-save-settings',
  savePastedText: 'save-pasted-text',
};
let testUpstream = null;
let nativeBackend = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  try {
    const { method, payload } = JSON.parse(line);
    let result;
    if (method === 'fixtures') result = { ...fixtures, userData: h.userData };
    else if (method === 'seedPluginCacheMaintenance') {
      const fs = require('node:fs');
      for (const relative of ['codex/.tmp', 'codex/api/conversations/cache-one/.tmp', 'codex/api/conversations/cache-two/.tmp']) {
        const directory = path.join(h.userData, relative, 'plugins');
        fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'manifest.json'), 'same');
      }
      for (const id of ['cache-one', 'cache-two']) fs.writeFileSync(path.join(h.userData, 'codex/api/conversations', id, 'native-context.jsonl'), id);
      h.app.relaunch = () => { if (payload?.fail) throw new Error('relaunch failed'); };
      h.app.quit = () => {};
      result = true;
    }
    else if (method === 'finishPluginCacheMaintenance') {
      result = require('../src/main/plugin-cache-startup').completePluginCacheMaintenance({ dataDir: h.userData, assertOffline() {} });
      result.nativeContexts = ['cache-one', 'cache-two'].map(id => require('node:fs').readFileSync(path.join(h.userData, 'codex/api/conversations', id, 'native-context.jsonl'), 'utf8'));
    }
    else if (method === 'configureTestApi') { h.configureApi(); result = true; }
    else if (method === 'seedKimiAccount') {
      const at = new Date().toISOString();
      const quota = { balances: [], windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 28, resetsAt: '2026-09-24T00:00:00Z' },
        { id: 'five-hour', label: '5 hours', usedPercent: 10, resetsAt: '2026-09-17T05:00:00Z' }], modelUsage: [] };
      writeJson(path.join(h.userData, 'kimi-subscription/account-state.json'), { account: { name: 'Kimi Code', region: 'mainland-cn' },
        models: [{ id: 'kimi-code/fixture', name: 'Kimi Coding', isDefault: true, contextWindow: 262144 }], verifiedAt: at, error: null,
        usage: { status: 'ok', checkedAt: at, latest: { ...quota, at }, history: [
          { ...quota, at: new Date(Date.now() - 3600000).toISOString(), windows: quota.windows.map(w => ({ ...w, usedPercent: 5 })) }, { ...quota, at }] } });
      await h.call('conversation-command', { engine: 'kimi', action: 'save-settings', payload: { connection: 'subscription', model: 'kimi-code/fixture' } });
      h = createUiHarness(h.root); result = true;
    }
    else if (method === 'seedGoogleAccount') {
      writeJson(path.join(h.userData, 'antigravity/google-account.json'), { models: [
        { id: 'gemini-fixture-high', name: 'Gemini Fixture (High)' }, { id: 'gemini-fixture-low', name: 'Gemini Fixture (Low)' },
      ], verifiedAt: Date.now(), error: '' });
      // The official CLI reports both limit groups; the settings card renders
      // them exactly as the CLI's own status panel does.
      const at = new Date().toISOString();
      const windows = [
        { id: 'gemini-models:gemini-weekly', label: 'Gemini Models · Weekly', usedPercent: 0, resetsAt: '2026-10-08T18:47:45Z' },
        { id: 'gemini-models:gemini-5h', label: 'Gemini Models · 5-hour', usedPercent: 1, resetsAt: '2026-10-01T23:47:45Z' },
        { id: 'claude-and-gpt-models:3p-weekly', label: 'Claude and GPT models · Weekly', usedPercent: 60, resetsAt: '2026-10-08T18:47:58Z' },
        { id: 'claude-and-gpt-models:3p-5h', label: 'Claude and GPT models · 5-hour', usedPercent: 100, resetsAt: '2026-10-01T23:47:58Z' },
      ];
      writeJson(path.join(h.userData, 'antigravity/google-quota.json'), { status: 'ok', checkedAt: at, error: null,
        latest: { at, balances: [], windows, modelUsage: [] }, history: [{ at, balances: [], windows }] });
      await h.call('conversation-command', { engine: 'antigravity', action: 'save-settings', payload: { connection: 'subscription', model: 'gemini-fixture-high' } });
      result = true;
    }
    else if (method === 'pickFile') result = { canceled: false, path: fixtures.alpha };
    else if (method === 'pickAttachments') result = { canceled: false, paths: [path.join(fixtures.alpha, 'image.png'), path.join(fixtures.alpha, 'notes.txt')] };
    else if (method === 'finishTurn') { result = [...h.api.sharedConversations.active.keys()].at(-1); h.finishTurn(); }
    else if (method === 'seedLongHistory') {
      const manager = h.api.sharedConversations, fs = require('node:fs');
      const c = manager.create('claude', null, 'Long indexed history', fixtures.alpha);
      const count = payload?.count || 10000;
      fs.writeFileSync(path.join(manager.dir, c.id + '.jsonl'), Array.from({ length: count }, (_, index) => JSON.stringify({
        seq: index + 1, role: index % 2 ? 'assistant' : 'user', engine: 'claude', text: 'History message ' + index,
      }) + '\n').join(''));
      c.seq = count; manager.save(c); result = c.id;
    }
    else if (method === 'historyMetrics') result = { ...h.api.sharedConversations.historyStore.metrics, cacheBytes: h.api.sharedConversations.historyStore.used };
    else if (method === 'seedPagedHistory') {
      const manager = h.api.sharedConversations;
      const ws = (await manager.command('claude', 'meta-op', { op: 'create-workspace', name: '分页工作区', path: h.folder('Paged') })).workspace;
      fixtures.pagedSessions = [];
      for (let i = 0; i < 150; i++) {
        const conversation = manager.create('claude', i < 75 ? ws.id : null, '分页会话 ' + i);
        manager.append(conversation, { role: 'user', engine: 'claude', text: '分页会话 ' + i });
        conversation.updatedAt = Date.now() - i * 1000;
        manager.save(conversation);
        fixtures.pagedSessions.push(conversation.id);
      }
      result = ws.id;
    }
    else if (method === 'seedSubscriptionUsage') {
      const file = path.join(h.userData, 'desktop-config.json');
      writeJson(file, { ...readJson(file, {}), subscriptionAccounts: { codex: [{ id: 'default', label: 'Personal' }, { id: 'account-1', label: 'Work' }] } });
      for (const [index, row] of [
        { engine: 'codex', model: 'gpt-5.4', input: 10000, cacheRead: 8000, output: 1000 },
        { engine: 'codex', accountId: 'account-1', model: 'future-model', input: 2000, output: 50 },
        { engine: 'kimi', model: 'kimi-code/k3', input: 23000, cacheRead: 19000, output: 300 },
        { engine: 'codex', model: 'gpt-5.3-codex', input: 100, output: 20, at: new Date(Date.now() - 40 * 86400000) },
      ].entries()) h.api.subscriptionUsage().record({ ...row, id: 'ui-usage-' + index, samples: [row] });
      result = { ok: true };
    }
    else if (method === 'lastProcess') {
      const proc = h.processes.at(-1);
      result = proc ? { cwd: proc.cwd, args: proc.args, id: proc.sid } : null;
    } else if (method === 'restart') {
      const root = h.root;
      h.api.sharedConversations.pauseGoals();
      for (const session of h.api.claudeSessions.sessions.values()) session.kill();
      h = createUiHarness(root); result = true;
    }
    else if (method === 'cleanup') {
      if (nativeBackend) {
        const proc = nativeBackend.current?.proc;
        const closed = proc ? new Promise(r => proc.once('exit', r)) : Promise.resolve();
        nativeBackend.stop(); await closed;
      }
      await h.api.stopRouter(); if (testUpstream) { testUpstream.closeAllConnections(); await new Promise(r=>testUpstream.close(r)); } h.cleanup(); result = true;
    }
    else if (method === 'dshSettingsUrl') {
      require('../integrations/dsh/patch.cjs')(path.resolve(__dirname, '../runtimes/dsh'));
      nativeBackend ||= new (require('../src/main/backend-process').BackendProcess)({ spawn: require('node:child_process').spawn });
      const runtime = path.resolve(__dirname, '../runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
      const ready = await nativeBackend.start({ key: 'native', host: '127.0.0.1', port: 0, exe: process.execPath,
        cwd: path.dirname(runtime), env: { ...process.env, DSH_HOME: path.join(h.home, '.dsh') }, timeoutMs: 120000,
        args: port => [runtime, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)] });
      const url = new URL(ready.url); url.searchParams.set('workbench-settings', '1');
      result = { ok: true, url: url.href };
    }
    else if (method === 'openSettingsWindow') result = { ok: true, target: payload };
    else if (method === 'freePort') { const server=http.createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r)); result=server.address().port; await new Promise(r=>server.close(r)); }
    else if (method === 'configureTestQclaw') {
      if (!testUpstream) throw new Error('Start the loopback upstream before configuring QClaw');
      const stateDir = h.folder('QClaw');
      process.env.QCLAW_STATE_DIR = stateDir;
      process.env.USERPROFILE = h.home;
      process.env.HOME = h.home;
      writeJson(path.join(stateDir, 'openclaw.json'), payload?.enabled === false ? {} : {
        gateway: { mode: 'local', port: testUpstream.address().port,
          auth: { mode: 'token', token: payload?.token || 'test-qclaw-token' } },
      });
      result = { ok: true };
    }
    else if (method === 'startTestUpstream') {
      testUpstream=http.createServer(async (req,res)=>{
        if (req.method === 'GET') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ data: [{ id: 'kimi-k3' }, { id: 'model-test' }, { id: 'model-test' }] })); return; }
        const parts=[]; for await(const c of req) parts.push(c);
        const body=JSON.parse(Buffer.concat(parts).toString());
        const quota=req.headers.authorization.includes('exhausted');
        res.writeHead(quota ? 402 : 200,{'content-type':'application/json'});
        res.end(JSON.stringify(quota ? {error:'quota exhausted'} : {id:'ui-smoke',model:body.model,choices:[{message:{role:'assistant',content:'UI route passed'},finish_reason:'stop'}],usage:{prompt_tokens:25,completion_tokens:8}}));
      });
      await new Promise(r=>testUpstream.listen(0,'127.0.0.1',r)); result='http://127.0.0.1:'+testUpstream.address().port;
    } else if (method === 'routerRequest') {
      const state=await h.call('api-router-get-state');
      const response=await fetch(state.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:payload,messages:[{role:'user',content:'Local UI smoke'}]})});
      result={status:response.status,body:await response.json()};
    }
    else if (/^(claude|codex|kimi|antigravity)(Get|Save)Settings$/.test(method)) {
      // Existing UI fixture controls set/read defaults through the current IPC;
      // they never invoke the retired native-chat renderer channels.
      const [, engine, action] = method.match(/^(claude|codex|kimi|antigravity)(Get|Save)Settings$/);
      result = await h.call('conversation-command', { engine, action: action.toLowerCase() + '-settings', payload });
    }
    else result = await h.call(methods[method], payload);
    const events = h.events.splice(0);
    process.stdout.write(JSON.stringify({ result, events }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.message }) + '\n'); }
});
