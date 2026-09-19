'use strict';
const { removeTree } = require('./test-fs.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queryAccount, accountCapability, fetchModels, verifyModel } = require('../src/api/provider-accounts');
const { createProviderInsights } = require('../src/api/provider-insights');
const { normalizeConfig } = require('../src/api/api-router-config');
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
