'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const yaml = require('js-yaml');
const {createHarness} = require('./claude-harness.cjs');
const {loadConfig, writeConfig, normalizeConfig} = require('../src/api/api-router-config');
const {BAD_PORTS} = require('./bad-ports.cjs');
async function freePort() { for (;;) { const s=http.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); if (!BAD_PORTS.has(p)) return p; } }
function pool(port) { return {port,providers:[{id:'p',name:'Local',baseUrl:'http://127.0.0.1:19099/v1',type:'ollama',protocol:'openai',models:[{id:'kimi-k3',upstream:'kimi-k3:cloud'}],keys:[{id:'k',key:'isolated-test-secret'}]}]}; }
test('desktop IPC masks keys, hot reloads and changes ports without losing saved keys',async t=>{
  const h=createHarness(); t.after(async()=>{await h.api.stopRouter(); h.cleanup();});
  const port=await freePort(); const saved=await h.call('api-router-save-config',pool(port));
  assert.equal(saved.ok,true); assert.equal(saved.state.running,true); assert.ok(!JSON.stringify(saved).includes('isolated-test-secret'));
  const masked=await h.call('api-router-get-state'); masked.providers[0].name='Renamed';
  assert.equal((await h.call('api-router-save-config',masked)).state.running,true);
  const changed=await h.call('api-router-get-state'); changed.port=await freePort();
  const next=await h.call('api-router-save-config',changed); assert.equal(next.state.running,true); assert.equal(next.state.port,changed.port);
  assert.equal(loadConfig(path.join(h.home,'.dsh','ollama-proxy.json')).providers[0].keys[0].key,'isolated-test-secret');
  assert.deepEqual((await (await fetch(next.state.url+'/v1/models')).json()).data.map(m=>m.id),['kimi-k3']);
  changed.enabled=false; assert.equal((await h.call('api-router-save-config',changed)).state.running,false);
  assert.throws(()=>h.api.resolveClaudeRoute(),/Camellia settings/);
});
test('a bind failure is visible and does not report a running router',async t=>{
  const h=createHarness(); const occupied=http.createServer(); await new Promise(r=>occupied.listen(0,'127.0.0.1',r));
  t.after(async()=>{await h.api.stopRouter(); await new Promise(r=>occupied.close(r)); h.cleanup();});
  const result=await h.call('api-router-save-config',pool(occupied.address().port));
  assert.equal(result.state.running,false); assert.match(result.state.error,/EADDRINUSE/);
  assert.throws(()=>h.api.resolveClaudeRoute({model:'kimi-k3'}),/EADDRINUSE/);
});
test('DSH pool injection preserves sibling providers, permissions and the selected model',t=>{
  const h=createHarness(); t.after(()=>h.cleanup());
  const home=h.folder('home/.dsh'); const file=path.join(home,'settings.yaml');
  const original={ 'agent-default-model':{provider:'deepseek',model:'my-existing-model'},'llm-pi-ai':{providers:{deepseek:{apiKeyEnv:'DEEPSEEK_API_KEY'},ollama:{api:'openai-completions',baseURL:'https://ollama.com/v1',models:[{id:'kimi-k3:cloud'}]}}},permission:{defaultPreset:'custom'}};
  fs.writeFileSync(file,yaml.dump(original,{indent:2})); writeConfig(path.join(home,'ollama-proxy.json'),normalizeConfig(pool(19098)));
  h.api.syncOllamaBaseUrl(true); h.api.syncOllamaBaseUrl(true);
  const next=yaml.load(fs.readFileSync(file,'utf8'));
  assert.deepEqual(next['agent-default-model'],original['agent-default-model']); assert.deepEqual(next.permission,original.permission);
  assert.deepEqual(next['llm-pi-ai'].providers.deepseek,original['llm-pi-ai'].providers.deepseek);
  assert.equal(next['llm-pi-ai'].providers['api-pool'].apiKeyEnv,'DSH_API_ROUTER_KEY');
  assert.equal(next['llm-pi-ai'].providers['api-pool'].baseURL,'http://127.0.0.1:19098');
  assert.equal(next['llm-pi-ai'].providers['api-pool'].api,'anthropic-messages');
  assert.equal(next['llm-pi-ai'].providers.ollama.baseURL,'http://127.0.0.1:19098/v1');
  assert.deepEqual(next['llm-pi-ai'].providers['api-pool'].models,[{id:'kimi-k3'}]);
});
test('Claude pins all CLI model tiers to the chosen model and clears direct API credentials',t=>{
  const h=createHarness(); t.after(()=>h.cleanup());
  const home=h.folder('home/.dsh'); writeConfig(path.join(home,'ollama-proxy.json'),normalizeConfig(pool(19098)));
  const spec=h.api.claudeSpawnSpec({model:'kimi-k3',baseUrl:'https://example.test',authToken:'stale-token',apiKey:'stale-direct-key'},{});
  assert.equal(spec.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:19098'); assert.equal(spec.env.ANTHROPIC_API_KEY,'');
  assert.equal(spec.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,'kimi-k3'); assert.equal(spec.env.CLAUDE_CODE_SUBAGENT_MODEL,'kimi-k3');
  const overlay=JSON.parse(fs.readFileSync(spec.args[spec.args.indexOf('--settings')+1],'utf8'));
  assert.equal(overlay.env.ANTHROPIC_API_KEY,''); assert.equal(overlay.env.ANTHROPIC_DEFAULT_OPUS_MODEL,'kimi-k3');
  assert.ok(!JSON.stringify(overlay).includes('stale-direct-key'));
  assert.throws(()=>h.api.claudeSpawnSpec({},{}),/Select a configured model/);
  assert.equal(h.api.resolveClaudeRoute({baseUrl:'https://example.test',authToken:'custom'}).baseUrl,'http://127.0.0.1:19098');
});

test('Claude cannot bypass an unconfigured pool with legacy credentials', t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const legacy = { model: 'test-model', baseUrl: 'https://example.test', apiKey: 'private-key', authToken: 'private-token' };
  const settingsFile = path.join(h.folder('app'), 'desktop-config.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ claude: legacy }));
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('claude-get-settings'))), { model: 'test-model' });
  const saved = h.call('claude-save-settings', { baseUrl: 'https://override.test', apiKey: 'new-key', permissionMode: 'plan' });
  assert.equal(saved.settings.permissionMode, 'plan');
  assert.equal(saved.settings.apiKey, undefined);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile)).claude.apiKey, 'private-key');
  const result = h.call('claude-send', { prompt: 'hello', settings: legacy });
  assert.equal(result.ok, false);
  assert.match(result.error, /Camellia settings/);
  assert.equal(h.processes.length, 0);
});

test('the global balance and quota cadence reaches the running router without a restart',async t=>{
  const h=createHarness(); t.after(async()=>{await h.api.stopRouter(); h.cleanup();});
  await h.call('api-router-save-config',pool(await freePort()));
  const initial=await h.call('api-router-get-state');
  assert.equal(initial.quotaCheck.enabled,true);
  assert.equal(initial.quotaCheck.intervalMs,15*60000);
  assert.equal(h.call('workbench-settings').accountRefreshMinutes,15);
  assert.equal(h.call('workbench-save-settings',{language:'en',theme:'system',autoRefreshBalances:true,accountRefreshMinutes:5}).ok,true);
  const applied=await h.call('api-router-get-state');
  assert.equal(applied.quotaCheck.intervalMs,5*60000);
  assert.equal(applied.quotaCheck.enabled,true);
  // The master switch also stops quota readings from steering routing.
  assert.equal(h.call('workbench-save-settings',{autoRefreshBalances:false}).ok,true);
  assert.equal((await h.call('api-router-get-state')).quotaCheck.enabled,false);
});
