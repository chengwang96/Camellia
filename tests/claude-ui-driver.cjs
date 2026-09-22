'use strict';
const readline = require('node:readline');
const http = require('node:http');
const path = require('node:path');
const { readJson, writeJson } = require('../src/shared/json-store');
const { createHarness } = require('./claude-harness.cjs');
let h = createHarness();
const fixtures = { alpha: h.folder('Alpha Project'), beta: h.folder('Beta Project') };
fixtures.legacy = h.seedSession('legacy-chat', fixtures.alpha, '已有的独立会话');
const methods = {
  claudeListSessions: 'claude-list-sessions', claudeLoadSession: 'claude-load-session',
  claudeGetSettings: 'claude-get-settings', claudeSaveSettings: 'claude-save-settings',
  claudeMetaOp: 'claude-meta-op', claudeSend: 'claude-send', claudeCancel: 'claude-cancel',
  claudeRenameSession: 'claude-rename-session', claudeArchiveSession: 'claude-archive-session',
  claudeGoalGet: 'claude-goal-get', claudeGoalStart: 'claude-goal-start',
  claudeGoalPause: 'claude-goal-pause', claudeGoalResume: 'claude-goal-resume',
  claudeGoalComplete: 'claude-goal-complete', claudeGoalClear: 'claude-goal-clear',
  apiRouterGetState: 'api-router-get-state', apiRouterSaveConfig: 'api-router-save-config',
  apiRouterReset: 'api-router-reset', apiRouterRotate: 'api-router-rotate',
  providerInsights: 'provider-insights', providerRefresh: 'provider-refresh', providerModels: 'provider-models', providerVerify: 'provider-verify',
  contextCapacity: 'context-capacity', contextCapacityStart: 'context-capacity-start', contextCapacityCancel: 'context-capacity-cancel',
  engineSettingsGet: 'engine-settings-get', engineSettingsSave: 'engine-settings-save', runtimeState: 'runtime-state', runtimeEnsure: 'runtime-ensure',
  downloadSettings: 'download-settings', downloadSaveSettings: 'download-save-settings',
  antigravityAccountState: 'antigravity-account-state', antigravityAccountRefresh: 'antigravity-account-refresh', antigravitySignIn: 'antigravity-sign-in',
  codexAccountState: 'codex-account-state', codexAccountRefresh: 'codex-account-refresh', codexSignIn: 'codex-sign-in',
  kimiAccountState: 'kimi-account-state',
  workbenchSettings: 'workbench-settings', workbenchSaveSettings: 'workbench-save-settings',
  savePastedText: 'save-pasted-text',
};
for (const engine of ['codex', 'kimi', 'antigravity']) {
  for (const action of ['GetLive', 'GetSettings', 'SaveSettings', 'ListSessions', 'LoadSession', 'MetaOp', 'GoalGet']) {
    methods[engine + action] = engine + '-' + action.replace(/[A-Z]/g, (letter, i) => (i ? '-' : '') + letter.toLowerCase());
  }
}
let testUpstream = null;
let nativeBackend = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  try {
    const { method, payload } = JSON.parse(line);
    let result;
    if (method === 'fixtures') result = { ...fixtures, userData: h.userData };
    else if (method === 'configureTestApi') { h.configureApi(); result = true; }
    else if (method === 'seedKimiAccount') {
      const at = new Date().toISOString();
      const quota = { balances: [], windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 28, resetsAt: '2026-09-24T00:00:00Z' },
        { id: 'five-hour', label: '5 hours', usedPercent: 10, resetsAt: '2026-09-17T05:00:00Z' }], modelUsage: [] };
      writeJson(path.join(h.userData, 'kimi-subscription/account-state.json'), { account: { name: 'Kimi Code', region: 'mainland-cn' },
        models: [{ id: 'kimi-code/fixture', name: 'Kimi Coding', isDefault: true, contextWindow: 262144 }], verifiedAt: at, error: null,
        usage: { status: 'ok', checkedAt: at, latest: { ...quota, at }, history: [
          { ...quota, at: new Date(Date.now() - 3600000).toISOString(), windows: quota.windows.map(w => ({ ...w, usedPercent: 5 })) }, { ...quota, at }] } });
      await h.call('kimi-save-settings', { connection: 'subscription', model: 'kimi-code/fixture' });
      h = createHarness(h.root); result = true;
    }
    else if (method === 'seedGoogleAccount') {
      writeJson(path.join(h.userData, 'antigravity/google-account.json'), { models: [
        { id: 'gemini-fixture-high', name: 'Gemini Fixture (High)' }, { id: 'gemini-fixture-low', name: 'Gemini Fixture (Low)' },
      ], verifiedAt: Date.now(), error: '' });
      await h.call('antigravity-save-settings', { connection: 'subscription', model: 'gemini-fixture-high' });
      result = true;
    }
    else if (method === 'pickFile') result = { canceled: false, path: fixtures.alpha };
    else if (method === 'pickAttachments') result = { canceled: false, paths: [path.join(fixtures.alpha, 'image.png'), path.join(fixtures.alpha, 'notes.txt')] };
    else if (method === 'finishTurn') result = h.finishTurn();
    else if (method === 'seedPagedHistory') {
      const ws = h.call('claude-meta-op', { op: 'create-workspace', name: '分页工作区', path: h.folder('Paged') }).workspace;
      const configFile = path.join(h.userData, 'desktop-config.json');
      const config = readJson(configFile);
      for (let i = 0; i < 150; i++) {
        const id = 'paged-' + i;
        h.seedSession(id, ws.path, '分页会话 ' + i, Date.now() - i * 1000);
        config.claudeMeta.sessionWorkspace[id] = i < 75 ? ws.id : null;
      }
      writeJson(configFile, config);
      result = ws.id;
    }
    else if (method === 'lastProcess') {
      const proc = h.processes.at(-1);
      result = proc ? { cwd: proc.cwd, args: proc.args, id: proc.sid } : null;
    } else if (method === 'restart') { const root = h.root; h.api.getSession()?.kill(); h = createHarness(root); result = true; }
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
    else result = await h.call(methods[method], payload);
    const events = h.events.splice(0);
    process.stdout.write(JSON.stringify({ result, events }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.message }) + '\n'); }
});
