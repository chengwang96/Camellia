'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { startApiRouter, retryDelay } = require('../src/api/api-router');
const { normalizeConfig, writeConfig, loadConfig, publicState } = require('../src/api/api-router-config');
const { frame, SSEParser, convertRequest } = require('../src/api/api-protocol');

async function port() { const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const p = server.address().port; await new Promise(r => server.close(r)); return p; }
const mapping = (id = 'kimi-k3', upstream = 'vendor/Kimi-K3', protocol = 'auto') => ({ id, upstream, protocol });
const provider = (id, url, keys = ['secret-' + id], models = [mapping()], protocol = 'openai') => ({ id, name: id, type: 'custom', baseUrl: url, protocol, enabled: true, models, keys: keys.map((key,i) => ({ id: id+'-key-'+i, key, enabled: true })) });
const completion = (model, text = '你好') => ({ id:'test', model, choices:[{ index:0, message:{ role:'assistant', content:text }, finish_reason:'stop' }], usage:{ prompt_tokens:10, completion_tokens:4 } });
const reply = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type':'application/json', ...headers }); res.end(JSON.stringify(body)); };
function stream(res, events) { res.writeHead(200, { 'content-type':'text/event-stream' }); const data = Buffer.from(events.map(e => frame(e, e.type || '')).join('')); for (let i=0; i<data.length; i+=2) res.write(data.subarray(i,i+2)); res.end(); }
function openEvents(text = '你好', tools = false) {
  return [
    { choices:[{ index:0, delta:{ role:'assistant', reasoning_content:'先思考' } }] },
    { choices:[{ index:0, delta:{ content:text } }] },
    ...(tools ? [
      { choices:[{ index:0, delta:{ tool_calls:[{ index:0, id:'call_1', type:'function', function:{ name:'read', arguments:'{"path":' } }] } }] },
      { choices:[{ index:0, delta:{ tool_calls:[{ index:0, function:{ arguments:'"文档"}' } }] } }] },
    ] : []),
    { choices:[{ index:0, delta:{}, finish_reason:tools ? 'tool_calls' : 'stop' }] },
    { choices:[], usage:{ prompt_tokens:15, completion_tokens:9, prompt_tokens_details:{ cached_tokens:5 } } }, '[DONE]',
  ];
}
async function fixture(t, respond, makeProviders, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'dsh-api-router-'));
  const requests = [];
  const backend = http.createServer(async (req,res) => {
    const parts=[]; for await (const c of req) parts.push(c);
    const body=JSON.parse(Buffer.concat(parts).toString() || '{}');
    const record={ url:req.url, headers:req.headers, body }; requests.push(record);
    try { await respond(record,res); } catch(e) { res.destroy(e); }
  });
  backend.listen(0,'127.0.0.1'); await once(backend,'listening');
  const url = 'http://127.0.0.1:'+backend.address().port;
  const file = path.join(root,'pool.json');
  writeConfig(file, normalizeConfig({ port:await port(), providers:makeProviders(url) }));
  const router=startApiRouter({ configPath:file, timeoutMs:options.timeoutMs || 2000 }); await router.ready;
  t.after(async () => {
    await router.stop(); backend.closeAllConnections(); await new Promise(r=>backend.close(r));
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('dsh-api-router-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(root,{recursive:true,force:true});
  });
  const post=(body, endpoint='/v1/chat/completions', opts={}) => fetch(router.url+endpoint,{ method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer client-placeholder', 'x-api-key':'client-private', ...opts.headers }, body:JSON.stringify({ model:'kimi-k3', messages:[{role:'user',content:'hello'}], ...body }), signal:opts.signal });
  return {router,requests,file,post,url};
}

test('per-model, per-day and per-key token counts survive config saves and keep old unclassified totals', async t => {
  const f=await fixture(t,(r,res)=> r.headers.authorization==='Bearer bad-key' ? reply(res,402,{error:'quota'}) : r.body.stream ? stream(res,openEvents()) : reply(res,200,completion(r.body.model)), url=>[
    provider('multi',url,['bad-key','good-key'],[mapping('m1','M1'),mapping('m2','M2')])]);
  await f.post({model:'m1',stream:true}).then(r=>r.text()); await f.post({model:'m2'});
  const state=f.router.getState(), usage=state.usage['multi-key-1'];
  assert.equal(usage.requests,2);assert.equal(usage.byModel.m1.inputTokens,15);assert.equal(usage.byModel.m1.cacheReadTokens,5);assert.equal(usage.byModel.m2.outputTokens,4);
  assert.equal(state.usage['multi-key-0'].byModel.m1.failures,1);assert.equal(Object.keys(usage.daily).length,1);
  f.router.updateConfig(state);assert.deepEqual(f.router.getState().usage['multi-key-1'].byModel,usage.byModel);
  const old=normalizeConfig({keys:['old-key'],usage:[{requests:10,inputTokens:100}]});
  assert.equal(Object.values(old.usage)[0].requests,10);assert.deepEqual(Object.values(old.usage)[0].byModel,{});
});

test('missing token fields are reported as unavailable and failed token counts do not enter business usage', async t => {
  const f=await fixture(t,(r,res)=>reply(res, r.url.endsWith('count_tokens') ? 429 : 200,
    r.url.endsWith('count_tokens') ? {error:'rate limit'} : {...completion(r.body.model), usage:{cost:1.2}}),
    url=>[provider('a',url,['secret'],[mapping()],'anthropic')]);
  assert.equal((await f.post({},'/v1/messages/count_tokens')).status,503);
  assert.equal(f.router.getState().usage['a-key-0'].failures,0);
  f.router.reset();
  const cfg=f.router.getState();cfg.providers[0].protocol='openai';f.router.updateConfig(cfg);
  assert.equal((await f.post({})).status,200);
  assert.equal(f.router.getState().usage['a-key-0'].unreported,1);
  assert.equal(f.router.getState().usage['a-key-0'].inputTokens,0);
});

test('legacy Ollama pool migrates keys, active order and usage without exposing credentials', () => {
  const cfg=normalizeConfig({ keys:['original-account-secret-1','original-account-secret-2'], activeIndex:1, usage:[{requests:7,inputTokens:100}] });
  assert.equal(cfg.version,2); assert.equal(cfg.providers[0].keys.length,2);
  assert.equal(cfg.active['kimi-k3'],cfg.providers[0].keys[1].id);
  assert.equal(cfg.usage[cfg.providers[0].keys[0].id].requests,7);
  assert.equal(cfg.providers[0].models[0].upstream,'kimi-k3:cloud');
  assert.ok(!JSON.stringify(publicState(cfg)).includes('original-account-secret'));
  const edited=publicState(cfg); edited.providers[0].keys.reverse();
  const next=normalizeConfig(edited,cfg);
  assert.equal(next.providers[0].keys[0].key,'original-account-secret-2');
  assert.equal(next.usage[cfg.providers[0].keys[0].id].requests,7);
});

test('quota failure advances across providers for the same model, then stays on that key', async t => {
  const f=await fixture(t,(r,res)=>r.url.startsWith('/first') ? reply(res,402,{error:'insufficient balance'}) : reply(res,200,completion(r.body.model)),url=>[
    provider('first',url+'/first'), provider('unrelated',url+'/wrong',['other'],[mapping('kimi-k2.6','K2.6')]), provider('second',url+'/second')]);
  assert.equal((await f.post({model:'kimi-k3:cloud'})).status,200);
  assert.equal((await f.post({})).status,200);
  assert.deepEqual(f.requests.map(r=>r.url),['/first/chat/completions','/second/chat/completions','/second/chat/completions']);
  assert.ok(f.requests.every(r=>r.body.model==='vendor/Kimi-K3'));
  assert.equal(f.router.getState().active['kimi-k3'],'second-key-0');
  assert.equal(f.router.getState().usage['first-key-0'].failures,1);
  assert.equal(f.router.getState().usage['second-key-0'].inputTokens,20);
  assert.equal(f.requests[1].headers.authorization,'Bearer secret-second');
  assert.equal(f.requests[1].headers['x-api-key'],undefined);
});

test('exhaustion and unknown models return errors without crossing into another model', async t => {
  const f=await fixture(t,(_r,res)=>reply(res,429,{error:'quota'}, {'retry-after':'120'}),url=>[
    provider('a',url+'/a'),provider('b',url+'/b',['b'],[mapping('kimi-k2.6','K2.6')])]);
  const res=await f.post({}); assert.equal(res.status,503); assert.match((await res.json()).error.message,/model was not changed/); assert.ok(Number(res.headers.get('retry-after'))>=119);
  assert.equal((await f.post({})).status,503);
  assert.equal((await f.post({model:'unconfigured'})).status,404);
  assert.equal(f.requests.length,1);
});

test('cooldowns are per model and authentication failures pause the entire key', async t => {
  const f=await fixture(t,(r,res)=>r.body.model==='M1' ? reply(res,429,{error:'rate_limit'}) : reply(res,200,completion(r.body.model)),url=>[
    provider('a',url+'/a',['secret'],[mapping('m1','M1'),mapping('m2','M2')])]);
  await f.post({model:'m1'}); assert.equal((await f.post({model:'m2'})).status,200);
  f.router.reset('m1'); await f.post({model:'m1'}); assert.equal(f.requests.length,3);
  assert.equal(f.router.getState().usage['a-key-0'].blocked,false);
});

test('401 key is skipped; replacing it clears its block and does not inherit old usage', async t => {
  const f=await fixture(t,(r,res)=>r.headers.authorization==='Bearer bad-secret' ? reply(res,401,{error:'invalid key'}) : reply(res,200,completion(r.body.model)),url=>[provider('a',url,['bad-secret','good-secret'])]);
  assert.equal((await f.post({})).status,200);
  assert.equal(f.router.getState().usage['a-key-0'].blocked,true);
  const cfg=f.router.getState(); cfg.providers[0].keys[0].key='replacement-secret'; f.router.updateConfig(cfg);
  assert.equal(f.router.getState().usage['a-key-0'].blocked,false);
  assert.equal(f.router.getState().usage['a-key-1'].requests,1);
  f.router.reset(); await f.post({}); assert.equal(f.requests.at(-1).headers.authorization,'Bearer replacement-secret');
});

test('generic 400 errors are not retried and keys cannot leak through error/state responses', async t => {
  const key='sk-secret-never-display';
  const f=await fixture(t,(_r,res)=>reply(res,400,{error:{message:'invalid input '+key}}),url=>[provider('a',url,[key,'next-secret'])]);
  const res=await f.post({}); assert.equal(res.status,400); assert.ok(!(await res.text()).includes(key));
  assert.equal(f.requests.length,1);
  const state=await (await fetch(f.router.url+'/__router/state')).text(); assert.ok(!state.includes(key)); assert.ok(!state.includes('next-secret'));
  assert.equal((await f.post({},'/v1/messages',{headers:{origin:'https://unrelated.test'}})).status,403);
});

test('Anthropic to OpenAI bridge preserves system, tool history, images and streamed tool arguments', async t => {
  const f=await fixture(t,(_r,res)=>stream(res,openEvents('你好',true)),url=>[provider('command',url+'/provider/v1')]);
  const body={ stream:true, max_tokens:1024, system:[{type:'text',text:'system rules'}], tools:[{name:'read',description:'read',input_schema:{type:'object',properties:{path:{type:'string'}}}}], messages:[
    {role:'user',content:[{type:'text',text:'look'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}]},
    {role:'assistant',content:[{type:'thinking',thinking:'previous reasoning',signature:''},{type:'tool_use',id:'call_old',name:'read',input:{path:'old'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'call_old',content:'old result'},{type:'text',text:'continue'}]},
  ]};
  const res=await f.post(body,'/v1/messages'); assert.equal(res.status,200);
  const events=[]; const parser=new SSEParser(obj=>events.push(obj)); parser.feed(Buffer.from(await res.text())); parser.end();
  const request=f.requests[0].body;
  assert.equal(f.requests[0].url,'/provider/v1/chat/completions');
  assert.equal(request.messages[0].content,'system rules');
  assert.match(request.messages[1].content[1].image_url.url,/^data:image\/png/);
  assert.equal(request.messages[2].reasoning_content,'previous reasoning');
  assert.equal(request.messages[3].tool_call_id,'call_old');
  assert.equal(request.messages[4].content,'continue');
  assert.equal(request.tools[0].function.name,'read');
  assert.equal(events[0].type,'message_start'); assert.equal(events[0].message.model,'kimi-k3');
  assert.equal(events.filter(e=>e.delta?.type==='text_delta').map(e=>e.delta.text).join(''),'你好');
  assert.deepEqual(JSON.parse(events.filter(e=>e.delta?.type==='input_json_delta').map(e=>e.delta.partial_json).join('')),{path:'文档'});
  assert.equal(events.at(-2).delta.stop_reason,'tool_use'); assert.equal(events.at(-1).type,'message_stop');
  assert.equal(f.router.getState().usage['command-key-0'].inputTokens,15);
  assert.equal(f.router.getState().usage['command-key-0'].outputTokens,9);
});

test('Anthropic native messages and count_tokens use their configured base path and auth', async t => {
  const f=await fixture(t,(r,res)=>reply(res,200,r.url.endsWith('count_tokens') ? {input_tokens:8} : {type:'message',model:r.body.model,role:'assistant',content:[{type:'text',text:'native'}],usage:{input_tokens:3,cache_read_input_tokens:7,output_tokens:2}}),url=>[
    {...provider('deepseek',url+'/v1',['secret'],[mapping()], 'dual'),anthropicBaseUrl:url+'/anthropic/v1'}]);
  assert.equal((await f.post({},'/v1/messages')).status,200);
  assert.equal((await f.post({},'/v1/messages/count_tokens')).status,200);
  assert.deepEqual(f.requests.map(r=>r.url),['/anthropic/v1/messages','/anthropic/v1/messages/count_tokens']);
  assert.equal(f.requests[0].headers['x-api-key'],'secret');
  assert.equal(f.router.getState().usage['deepseek-key-0'].inputTokens,10);
  assert.equal(f.router.getState().usage['deepseek-key-0'].requests,1);
});

test('OpenAI clients can use an Anthropic-only line with reasoning, tools and final usage', async t => {
  const events=[
    {type:'message_start',message:{id:'a1',model:'upstream',usage:{input_tokens:6,cache_read_input_tokens:4,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Claude output'}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:7}}, {type:'message_stop'},
  ];
  const f=await fixture(t,(_r,res)=>stream(res,events),url=>[provider('anthropic',url+'/v1',['secret'],[mapping('claude-model','claude-model')],'anthropic')]);
  const res=await f.post({model:'claude-model',stream:true}); const text=await res.text();
  assert.match(text,/Claude output/); assert.match(text,/"prompt_tokens":10/); assert.match(text,/"completion_tokens":7/); assert.match(text,/\[DONE\]/);
  assert.equal(f.requests[0].url,'/v1/messages'); assert.equal(f.requests[0].body.model,'claude-model');
});

test('a quota SSE error before content can fail over, while partial output never replays', async t => {
  let partial=false;
  const f=await fixture(t,(r,res)=> {
    if (r.url.startsWith('/a')) {
      if (partial) stream(res,[openEvents('partial')[0],{error:{type:'rate_limit_error',message:'quota'}}]);
      else stream(res,[{error:{type:'rate_limit_error',message:'quota'}}]);
    } else stream(res,openEvents('backup'));
  },url=>[provider('a',url+'/a'),provider('b',url+'/b')]);
  const first=await f.post({stream:true},'/v1/messages'); assert.match(await first.text(),/backup/); assert.equal(f.requests.length,2);
  f.router.reset(); partial=true;
  const second=await f.post({stream:true},'/v1/messages'); assert.match(await second.text(),/"type":"error"/);
  assert.equal(f.requests.length,3);
  assert.equal(f.router.getState().usage['a-key-0'].requests,0);
});

test('timeout before output retries another line of the same model', async t => {
  const f=await fixture(t,(r,res)=> {
    if (r.url.startsWith('/slow')) return;
    stream(res,openEvents());
  },url=>[provider('slow',url+'/slow'),provider('fast',url+'/fast')],{timeoutMs:60});
  assert.equal((await f.post({stream:true},'/v1/messages')).status,200);
  assert.equal(f.requests.length,2);
});

test('timeout after a partial response ends with an error and never replays', async t => {
  const f=await fixture(t,(_r,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(frame({choices:[{index:0,delta:{content:'partial'}}]}));
  },url=>[provider('a',url,['a','b'])],{timeoutMs:60});
  const res=await f.post({stream:true},'/v1/messages'); const text=await res.text();
  assert.match(text,/partial/); assert.match(text,/"type":"error"/);
  assert.equal(f.requests.length,1); assert.equal(f.router.getState().usage['a-key-0'].requests,0);
});

test('a key removed during failover is never tried from an old route snapshot', async t => {
  let release; const gate=new Promise(r=>release=r);
  const f=await fixture(t,async(r,res)=>{
    if(r.url.startsWith('/a')){await gate;reply(res,402,{error:'quota'});}else reply(res,200,completion(r.body.model));
  },url=>[provider('a',url+'/a'),provider('b',url+'/b')]);
  const pending=f.post({});
  while(!f.requests.length) await new Promise(r=>setTimeout(r,5));
  const state=f.router.getState();state.providers.pop();f.router.updateConfig(state);release();
  assert.equal((await pending).status,503);assert.equal(f.requests.length,1);
});

test('disconnect cancels the upstream without trying another key', async t => {
  let closedResolve; const closed=new Promise(r=>closedResolve=r);
  const f=await fixture(t,(_r,res)=> { res.on('close',closedResolve); res.writeHead(200,{'content-type':'text/event-stream'}); res.write(frame(openEvents()[0])); },url=>[provider('a',url,['a','b'])]);
  const controller=new AbortController(); const res=await f.post({stream:true},'/v1/messages',{signal:controller.signal});
  await res.body.getReader().read(); controller.abort();
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream not cancelled')),1000).unref())]);
  assert.equal(f.requests.length,1); assert.equal(f.router.getState().usage['a-key-0'].requests,0);
});

test('usage survives shutdown and masked edits/reordering; invalid config never overwrites the pool', async t => {
  const f=await fixture(t,(r,res)=>reply(res,200,completion(r.body.model)),url=>[provider('a',url,['one-secret','two-secret'])]);
  await f.post({}); const state=f.router.getState(); state.providers[0].keys.reverse(); f.router.updateConfig(state);
  assert.throws(()=>f.router.updateConfig({...state,providers:[{...state.providers[0],baseUrl:'http://remote.invalid/v1'}]}),/HTTPS/);
  await f.router.stop();
  const saved=loadConfig(f.file); assert.equal(saved.providers[0].keys[0].key,'two-secret'); assert.equal(saved.usage['a-key-0'].requests,1);
});

test('Retry-After accepts seconds and dates; unsupported rich blocks fail visibly', () => {
  assert.equal(retryDelay({'retry-after':'30'},1000),30000);
  assert.equal(retryDelay({'retry-after':new Date(61000).toUTCString()},1000),60000);
  assert.throws(()=>convertRequest({messages:[{role:'user',content:[{type:'document',source:{}}]}]},'anthropic','openai'),/does not support document/);
});

test('malformed successful JSON responses retry within the model instead of crashing or recording success', async t => {
  for (const body of [null, [], 'not-a-message', {}, { choices: [] }]) {
    await t.test(JSON.stringify(body), async t => {
      const f = await fixture(t, (r, res) => reply(res, 200, r.url.startsWith('/bad') ? body : completion(r.body.model)),
        url => [provider('bad', url + '/bad'), provider('good', url + '/good')]);
      assert.equal((await f.post({})).status, 200);
      assert.equal(f.requests.length, 2);
      assert.equal(f.router.getState().usage['bad-key-0'].requests, 0);
      assert.equal(f.router.getState().usage['good-key-0'].requests, 1);
    });
  }
});

test('empty SSE completion retries the same model; native event names survive forwarding', async t => {
  const f = await fixture(t, (r, res) => {
    if (r.url.startsWith('/bad')) return stream(res, ['[DONE]']);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of openEvents('valid')) res.write(frame(event, event === '[DONE]' ? '' : 'message'));
    res.end();
  }, url => [provider('bad', url + '/bad'), provider('good', url + '/good')]);
  const res = await f.post({ stream: true });
  const text = await res.text();
  assert.match(text, /event: message/);
  assert.match(text, /valid/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.router.getState().usage['bad-key-0'].requests, 0);
});

test('failed config persistence cannot change the live router', async t => {
  const f = await fixture(t, (r, res) => reply(res, 200, completion(r.body.model)), url => [provider('original', url)]);
  const edit = f.router.getState(); edit.providers[0].name = 'unsaved';
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('write failed'); });
  assert.throws(() => f.router.updateConfig(edit), /write failed/);
  rename.mock.restore();
  assert.equal(f.router.getState().providers[0].name, 'original');
  assert.equal(loadConfig(f.file).providers[0].name, 'original');
});
