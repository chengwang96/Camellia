'use strict';
const { removeTree } = require('./test-fs.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queryAccount, accountCapability, fetchModels, verifyModel } = require('../src/api/provider-accounts');
const { createProviderInsights } = require('../src/api/provider-insights');
const { normalizeConfig, loadConfig, writeConfig } = require('../src/api/api-router-config');
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const provider = (baseUrl, type = 'custom') => ({ id: 'provider', baseUrl, type, protocol: 'openai', enabled: true, models: [{ id:'model', upstream:'model' }], keys: [{ id:'key-1', key:'private-key-never-publish', enabled:true }] });
const deepseek = total => ({ balance_infos: [{ currency:'CNY', total_balance:String(total), topped_up_balance:String(total), granted_balance:'0' }] });
async function query(baseUrl, body) { return queryAccount(provider(baseUrl), 'test-key', { fetchImpl: async (url, options) => { assert.equal(options.headers.Authorization, 'Bearer test-key'); assert.equal(options.redirect, 'error'); return response(body); } }); }

test('DeepSeek and Kimi balance adapters preserve zero, currency and balance components; missing amounts are not zero', async () => {
  const d = await query('https://api.deepseek.com/v1', deepseek(0));
  assert.equal(d.balances[0].value, 0); assert.equal(d.balances[0].currency, 'CNY');
  const k = await query('https://api.moonshot.ai/v1', { status:true, data:{ available_balance:12.34, cash_balance:10, voucher_balance:2.34 } });
  assert.equal(k.balances[0].value, 12.34); assert.equal(k.balances[0].currency, 'USD');
  await assert.rejects(query('https://api.deepseek.com/v1', { balance_infos:[{currency:'CNY'}] }), /returned no recognized/);
  await assert.rejects(query('https://api.moonshot.cn/v1', {status:false,data:{available_balance:0}}), /returned no recognized/);
});
test('subscription adapters distinguish percent vs fractions and only report supplied reset times', async () => {
  const go = await query('https://opencode.ai/zen/go/v1', { usage:{ rolling:{percent:72,resetsAt:'2026-09-15T05:00:00Z'}, monthly:{percent:0} } });
  assert.equal(go.windows[0].usedPercent,72); assert.equal(go.windows[0].resetsAt,'2026-09-15T05:00:00.000Z'); assert.equal(go.windows[1].resetsAt,null);
  const ollama = await query('https://ollama.com/v1', {activity:{cost:'12.80',models:[]},limits:{monthly:{usage:.42,models:[{name:'kimi-k3',request_count:25}]}}});
  assert.equal(ollama.windows[0].usedPercent,42); assert.equal(ollama.windows[0].resetsAt,null); assert.deepEqual(ollama.balances,[]); assert.equal(ollama.modelUsage[0].requests,25);
  const kimi = await query('https://api.kimi.com/coding/v1', {usage:{used:10,limit:100,resetTime:'2026-09-16T00:00:00Z'},limits:[{window:{duration:5,timeUnit:'TIME_UNIT_HOUR'},detail:{used:7,limit:10}}]});
  assert.equal(kimi.windows[0].usedPercent,10); assert.equal(kimi.windows[1].usedPercent,70); assert.equal(kimi.windows[1].label,"5 hours");
});
test('Command Code uses the organization discovered by whoami and presents credits separately from cash', async () => {
  const urls=[];
  const data = await queryAccount(provider('https://api.commandcode.ai/provider/v1'), 'secret', {fetchImpl:async url=>{
    urls.push(url); return response(url.includes('whoami') ? {org:{id:'org a'}} : {credits:{monthlyCredits:10,purchasedCredits:3,freeCredits:0},windowLimits:{fiveHour:{used:7,cap:14,resetAt:'2026-09-15T05:00:00Z'}}});
  }});
  assert.deepEqual(urls,['https://api.commandcode.ai/alpha/whoami?limits=1','https://api.commandcode.ai/alpha/billing/credits?orgId=org%20a']);
  assert.equal(data.balances[0].value,13); assert.equal(data.balances[0].currency,'credits'); assert.equal(data.windows[0].usedPercent,50);
});
test('unsupported relay/Zen hosts never forward secrets to an official balance endpoint', async () => {
  assert.equal(accountCapability(provider('https://opencode.ai/zen/v1')).supported,false);
  const result=await queryAccount(provider('https://relay.example/v1','deepseek'),'secret',{fetchImpl:async()=>{throw new Error('must not fetch');}});
  assert.equal(result.status,'unsupported');
  await assert.rejects(queryAccount(provider('https://api.deepseek.com/v1'),'sk-secret',{fetchImpl:async()=>response({error:'sk-secret'},401)}), e => !e.message.includes('sk-secret') && e.message.includes('401'));
});
test('model discovery deduplicates exact model aliases without merging versions; validation requires a real response', async () => {
  const p=provider('https://api.commandcode.ai/provider/v1','commandcode');
  const models=await fetchModels(p,'secret',{fetchImpl:async()=>response({data:[{id:'moonshotai/kimi-k3',context_length:262144},{id:'moonshotai/kimi-k3'},{id:'moonshotai/kimi-k2.6'},{id:'claude-sonnet-4-6'}]})});
  assert.deepEqual(models.map(m=>m.id),['kimi-k3','kimi-k2.6','claude-sonnet-4-6']); assert.equal(models[2].protocol,'anthropic');
  assert.equal(models[0].maxContext,262144);
  let calls=0;
  await verifyModel(p,'secret',models[0],{fetchImpl:async (url,options)=>{ calls++; assert.match(url,/chat\/completions$/); assert.equal(JSON.parse(options.body).model,'moonshotai/kimi-k3'); return response({choices:[{message:{content:'OK'}}]}); }});
  assert.equal(calls,1);
  await assert.rejects(verifyModel(p,'secret',models[0],{fetchImpl:async()=>response({data:[]})}),/valid model response/);
});

test('Command Code complete endpoint URLs use one base for discovery and validation', async () => {
  for (const suffix of ['/chat/completions', '/responses', '/messages', '/models/']) {
    const p = provider('https://api.commandcode.ai/provider/v1' + suffix, 'commandcode');
    const calls = [];
    const options = { fetchImpl: async (url, init) => {
      calls.push([url, init.method]);
      if (init.method === 'GET') return response({ data: [{ id: 'deepseek/deepseek-v4.1-flash', thinking: { values: [false, true], default: true } }] });
      assert.equal(JSON.parse(init.body).model, 'deepseek/deepseek-v4.1-flash');
      return response({ choices: [{ message: { content: 'OK' } }] });
    } };
    const models = await fetchModels(p, 'secret', options);
    await verifyModel(p, 'secret', models[0], options);
    assert.deepEqual(calls, [
      ['https://api.commandcode.ai/provider/v1/models', 'GET'],
      ['https://api.commandcode.ai/provider/v1/chat/completions', 'POST'],
    ]);
  }
});

test('model discovery leaves absent or malformed context limits unknown', async () => {
  const entries = [{ id: 'missing' }, { id: 'negative', context_length: -10000 },
    { id: 'fraction', context_length: 128000.5 }, { id: 'infinite', context_length: 'Infinity' },
    { id: 'valid', context_window: '1000000' }];
  const models = await fetchModels(provider('https://relay.example/v1'), 'secret', {
    fetchImpl: async () => response({ data: entries }),
  });
  for (const model of models.slice(0, 4)) assert.equal(model.maxContext, undefined);
  assert.equal(models[4].maxContext, 1000000);
});

test('catalog discovery normalizes relay names without discarding distinct upstream aliases', async () => {
  const upstreams = ['openai/openai/gpt-6-astra', 'gpt-6-astra', 'moonshotai/Kimi-K3', 'zai-org/GLM-5.3',
    'deepseek-flash', 'deepseek-v4.1-flash', 'private/GPT-6-Astra'];
  const models = await fetchModels(provider('https://relay.example/v1'), 'fixture', {
    fetchImpl: async () => response({ data: [...upstreams, upstreams[0]].map(id => ({ id, thinking: { values: [] } })) }),
  });
  assert.deepEqual(models.map(model => model.upstream), upstreams);
  assert.deepEqual(models.map(model => model.id), ['gpt-6-astra', 'gpt-6-astra', 'kimi-k3', 'glm-5.3',
    'deepseek-flash', 'deepseek-v4.1-flash', 'private/GPT-6-Astra']);
});

test('catalog discovery preserves explicit reasoning metadata without guessing from model names', async () => {
  const entries = [{ id: 'glm-5.3', thinking: { values: ['low', 'high', 'max'], default: 'max' } },
    { id: 'reported', supported_reasoning_efforts: ['low', 'max'], default_reasoning_effort: 'low' },
    { id: 'account-format', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] },
    { id: 'codex-format', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }] },
    { id: 'no-reasoning', supported_reasoning_efforts: [] },
    { id: 'malformed', thinking: { values: ['low', 2] } }, { id: 'gpt-6-astra' }, null];
  const calls = [];
  const models = await fetchModels(provider('https://relay.example/v1', 'ollama-relay'), 'secret', {
    fetchImpl: async url => { calls.push(url); return response({ data: entries }); },
  });
  assert.deepEqual(models[0].thinking, { values: ['low', 'high', 'max'], default: 'max' });
  assert.deepEqual(models[1].thinking, { values: ['low', 'max'], default: 'low' });
  assert.deepEqual(models[2].thinking, { values: ['ultra'] });
  assert.deepEqual(models[3].thinking, { values: ['high', 'xhigh'] });
  assert.deepEqual(models[4].thinking, { values: [] });
  assert.equal(models[5].thinking, undefined);
  assert.equal(models[6].thinking, undefined);
  assert.equal(calls[0], 'https://relay.example/v1/models');
  assert.ok(calls.slice(1).every(url => url.startsWith('https://relay.example/v1/models/')));
  assert.equal(calls.length, 3);
});

test('DeepSeek effort metadata is read from the live schema, including the documented off control', async () => {
  const models = await fetchModels(provider('https://api.deepseek.com/v1', 'deepseek'), 'secret', {
    fetchImpl: async url => {
      assert.equal(url, 'https://api.deepseek.com/v1/models');
      return response({ data: [{ id: 'deepseek-flash', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] });
    },
  });
  assert.deepEqual(models[0].thinking, { values: ['none', 'low', 'high', 'max'], default: 'high' });
});

test('other providers use same-host single-model metadata before falling back', async () => {
  const calls = [];
  const models = await fetchModels(provider('https://relay.example/v1'), 'private', {
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer private');
      assert.equal(options.redirect, 'error');
      if (url.endsWith('/models')) return response({ data: [{ id: 'vendor/reported' }, { id: 'unknown' }, { id: 'unavailable' }] });
      if (url.endsWith('/vendor%2Freported')) return response({ data: { id: 'vendor/reported', max_input_tokens: 128000,
        capabilities: { effort: { supported_levels: ['high', 'max'], default_level: 'max' } } } });
      if (url.endsWith('/unknown')) return response({ id: 'different-model', thinking: { values: ['ultra'] } });
      return response({}, 404);
    },
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(models[0].thinking, { values: ['high', 'max'], default: 'max' });
  assert.equal(models[0].maxContext, 128000);
  assert.equal(models[1].thinking, undefined);
  assert.equal(models[2].thinking, undefined);
});

test('missing detail endpoints stop bounded probes without failing the catalog', async () => {
  const entries = Array.from({ length: 200 }, (_, index) => ({ id: 'model-' + index }));
  const calls = [];
  const selected = provider('https://relay.example/v1'); selected.models = [{ id: 'model-199', upstream: 'model-199' }];
  const models = await fetchModels(selected, 'private', {
    fetchImpl: async url => { calls.push(url); return url.endsWith('/models') ? response({ data: entries }) : response({}, 404); },
  });
  assert.equal(models.length, 200);
  assert.equal(calls[1], 'https://relay.example/v1/models/model-199');
  assert.ok(calls.length <= 8);
  assert.ok(models.every(model => model.thinking === undefined));
});

test('MiMo boolean controls are sourced only from documented official routes, never similarly named relays', async () => {
  for (const [baseUrl, thinking] of [['https://api.xiaomimimo.com/v1', true], ['https://token-plan-cn.xiaomimimo.com/v1', true], ['https://relay.example/v1', false]]) {
    const calls = [];
    const models = await fetchModels(provider(baseUrl, 'mimo'), 'private', {
      fetchImpl: async url => {
        calls.push(url);
        return url.endsWith('/models') ? response({ data: [{ id: 'mimo-v2.6-pro' }] }) : response({}, 404);
      },
    });
    assert.deepEqual(models[0].thinking, thinking ? { values: [false, true], default: true } : undefined);
    assert.equal(calls.length, thinking ? 1 : 2);
    assert.ok(calls.every(url => url.startsWith(baseUrl + '/models')));
  }
});

test('Ollama discovery queries native model metadata, preserving defaults and context limits', async () => {
  const entries = [{ id: 'glm-5.3:cloud' }, { id: 'deepseek-v4.1-flash:cloud' }, { id: 'kimi-k2.6:cloud' },
    { id: 'no-thinking:cloud' }, { id: 'metadata-missing:cloud' }, { id: 'unavailable:cloud' },
    { id: 'catalog-only:cloud', thinking: { values: ['custom-depth'], default: 'custom-depth' } }];
  const metadata = {
    'glm-5.3:cloud': { thinking: { values: ['low', 'high', 'max'], default: 'max' }, model_info: { 'glm.context_length': 202752 } },
    'deepseek-v4.1-flash:cloud': { thinking: { values: [false, 'low', 'high', 'max'], default: 'high' } },
    'kimi-k2.6:cloud': { thinking: { values: [false, true], default: true } },
    'no-thinking:cloud': { thinking: { values: [false], default: false } },
    'metadata-missing:cloud': {},
  };
  const calls = [];
  const models = await fetchModels(provider('https://ollama.com/v1', 'ollama'), 'secret', {
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer secret');
      assert.equal(options.redirect, 'error');
      if (url.endsWith('/v1/models')) return response({ data: entries });
      assert.equal(url, 'https://ollama.com/api/show');
      assert.equal(options.method, 'POST');
      const model = JSON.parse(options.body).model;
      if (model === 'catalog-only:cloud') throw new Error('network failure');
      return response(metadata[model] || {}, metadata[model] ? 200 : 404);
    },
  });
  assert.equal(calls.length, 8);
  assert.equal(models[0].id, 'glm-5.3');
  assert.deepEqual(models[0].thinking, metadata['glm-5.3:cloud'].thinking);
  assert.equal(models[0].maxContext, 202752);
  for (const model of models.slice(1, 4)) assert.deepEqual(model.thinking, metadata[model.upstream].thinking);
  assert.equal(models[4].thinking, undefined);
  assert.equal(models[5].thinking, undefined);
  assert.deepEqual(models[6].thinking, entries[6].thinking);
});

test('Ollama detail requests stay on the configured host and have bounded concurrency', async () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ name: 'model-' + index }));
  let active = 0, peak = 0;
  const models = await fetchModels(provider('http://localhost:11434/v1', 'ollama'), 'local-key', {
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer local-key');
      if (url.endsWith('/v1/models')) return response({ models: entries });
      assert.equal(url, 'http://localhost:11434/api/show');
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return response({ thinking: { values: ['high'] } });
    },
  });
  assert.equal(models.length, 12);
  assert.equal(peak, 4);
  assert.ok(models.every(model => model.thinking.values[0] === 'high'));
});

test('metadata cache survives old writers without following edited routes or replacing newer metadata', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-model-cache-'));
  context.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('camellia-model-cache-')); removeTree(root); });
  const file = path.join(root, 'pool.json');
  const config = normalizeConfig({ providers: [provider('https://ollama.com/v1', 'ollama')] });
  const selected = config.providers[0], model = selected.models[0];
  const thinking = { values: ['low', 'high', 'max'], default: 'max' };
  const metadata = { version: 1, models: [{ providerId: selected.id, baseUrl: selected.baseUrl, anthropicBaseUrl: selected.anthropicBaseUrl,
    providerProtocol: selected.protocol, upstream: model.upstream, protocol: model.protocol, thinking }] };
  const save = () => fs.writeFileSync(file, JSON.stringify(config));
  save(); fs.writeFileSync(file + '.model-metadata.json', JSON.stringify(metadata));
  assert.deepEqual(loadConfig(file).providers[0].models[0].thinking, thinking);
  model.thinking = { values: ['max'] }; save();
  assert.deepEqual(loadConfig(file).providers[0].models[0].thinking, { values: ['max'] });
  delete model.thinking;
  for (const field of ['baseUrl', 'anthropicBaseUrl', 'protocol']) {
    const original = selected[field]; selected[field] = field === 'protocol' ? 'dual' : 'https://other.example/v1'; save();
    assert.equal(loadConfig(file).providers[0].models[0].thinking, undefined);
    selected[field] = original;
  }
  for (const field of ['upstream', 'protocol']) {
    const original = model[field]; model[field] = field === 'protocol' ? 'anthropic' : 'other-model'; save();
    assert.equal(loadConfig(file).providers[0].models[0].thinking, undefined);
    model[field] = original;
  }
  save(); fs.writeFileSync(file + '.model-metadata.json', 'invalid json');
  assert.equal(loadConfig(file).providers[0].models[0].thinking, undefined);
});

test('config writes persist discovered thinking metadata without storing credentials', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-model-cache-write-'));
  context.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('camellia-model-cache-write-')); removeTree(root); });
  const file = path.join(root, 'pool.json');
  const cfg = normalizeConfig({ providers: [{ ...provider('https://api.deepseek.com/v1', 'deepseek'), anthropicBaseUrl: 'https://api.deepseek.com/anthropic/v1',
    protocol: 'dual', models: [{ id: 'deepseek-flash', upstream: 'deepseek-flash', protocol: 'auto', thinking: { values: ['none', 'low', 'high', 'max'], default: 'high' } }] }] });
  writeConfig(file, cfg);
  const metadataFile = file + '.model-metadata.json';
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  assert.deepEqual(metadata.models[0].thinking, cfg.providers[0].models[0].thinking);
  assert.ok(!fs.readFileSync(metadataFile, 'utf8').includes('private-key-never-publish'));
  delete cfg.providers[0].models[0].thinking;
  writeConfig(file, cfg);
  assert.deepEqual(loadConfig(file).providers[0].models[0].thinking, { values: ['none', 'low', 'high', 'max'], default: 'high' });
});

test('balance history survives reload, coalesces refreshes, preserves last success, and never crosses replacement keys', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-insights-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('dsh-insights-'));removeTree(root);});
  const file=path.join(root,'insights.json');
  let cfg=normalizeConfig({providers:[provider('https://api.deepseek.com/v1')]}), now=Date.parse('2026-09-15T00:00:00Z'), calls=0, fail=false, release;
  const fetchImpl=async()=>{calls++; if(release)await release.promise; return fail ? response({},401) : response(deepseek(12));};
  const make=()=>createProviderInsights({file,getConfig:()=>cfg,now:()=>now,fetchImpl});
  let insights=make();
  let done;release={promise:new Promise(r=>{done=r;})};
  const a=insights.refresh(),b=insights.refresh();done();await Promise.all([a,b]);release=null;
  assert.equal(calls,1); assert.equal(insights.state().keys['key-1'].history.length,1);
  now+=16*60000;await insights.refresh();insights=make();assert.equal(insights.state().keys['key-1'].history.length,2);
  fail=true;await insights.refresh();assert.equal(insights.state().keys['key-1'].status,'error');assert.equal(insights.state().keys['key-1'].latest.balances[0].value,12);
  assert.ok(!fs.readFileSync(file,'utf8').includes('private-key-never-publish'));assert.ok(!JSON.stringify(insights.state()).includes('identity'));
  const next=structuredClone(cfg);next.providers[0].keys[0].key='replacement';cfg=normalizeConfig(next,cfg);
  assert.equal(insights.state().keys['key-1'].latest,undefined);assert.equal(insights.state().keys['key-1'].history.length,0);
});

test('account refresh cache follows changed global cadence and manual refresh bypasses it', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-insights-cadence-'));
  context.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('dsh-insights-cadence-')); removeTree(root); });
  let clock = Date.now(), interval = 15 * 60000, calls = 0;
  const config = normalizeConfig({ providers: [provider('https://api.deepseek.com/v1')] });
  const insights = createProviderInsights({ file: path.join(root, 'insights.json'), getConfig: () => config,
    now: () => clock, getRefreshIntervalMs: () => interval,
    fetchImpl: async () => { calls++; return response(deepseek(12)); } });
  await insights.refresh({ force: false });
  clock += 5 * 60000;
  await insights.refresh({ force: false });
  assert.equal(calls, 1);
  interval = 5 * 60000;
  await insights.refresh({ force: false });
  assert.equal(calls, 2);
  interval = 30 * 60000;
  clock += 15 * 60000;
  await insights.refresh({ force: false });
  assert.equal(calls, 2);
  await insights.refresh();
  assert.equal(calls, 3);
  clock += 30 * 60000;
  await insights.refresh({ force: false });
  assert.equal(calls, 4);
});

test('account refresh and model verification preserve both results regardless of completion order', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-insights-race-'));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('dsh-insights-race-'));removeTree(root);});
  const cfg=normalizeConfig({providers:[provider('https://api.deepseek.com/v1')]});
  for (const finishFirst of ['balance','verify']) {
    const gates={};
    const insights=createProviderInsights({file:path.join(root,finishFirst+'.json'),getConfig:()=>cfg,fetchImpl:async url=>{
      const type=url.endsWith('balance') ? 'balance' : 'verify';
      await new Promise(resolve=>{gates[type]=resolve;});
      return response(type==='balance' ? deepseek(12) : {choices:[{message:{content:'OK'}}]});
    }});
    const tasks={balance:insights.refresh(),verify:insights.verify({providerId:'provider',keyId:'key-1',model:'model'})};
    gates[finishFirst]();await tasks[finishFirst];
    const last=finishFirst==='balance'?'verify':'balance';gates[last]();await tasks[last];
    assert.equal(insights.state().keys['key-1'].verification.ok,true);
    assert.equal(insights.state().keys['key-1'].latest.balances[0].value,12);
  }
});
