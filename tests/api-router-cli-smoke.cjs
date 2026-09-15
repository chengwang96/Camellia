'use strict';
// Installed Claude CLI -> router -> two local OpenAI-format providers.
// Exercises an actual Read tool round after a quota failure, with isolated auth.
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), http=require('node:http');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const {startApiRouter}=require('../src/api/api-router');
const {normalizeConfig,writeConfig}=require('../src/api/api-router-config');
const {frame}=require('../src/api/api-protocol');
async function run(){
  const exe=process.argv[2]; if(!exe) throw new Error('Pass the absolute installed claude.exe path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-router-cli-'));
  const marker=path.join(root,'marker.txt'); fs.writeFileSync(marker,'router-tool-history-7391');
  const requests=[];
  const backend=http.createServer(async(req,res)=>{
    const parts=[]; for await(const c of req) parts.push(c);
    const body=JSON.parse(Buffer.concat(parts).toString()); requests.push({body,key:req.headers.authorization,url:req.url});
    if(req.headers.authorization==='Bearer exhausted') {res.writeHead(402,{'content-type':'application/json'});res.end('{"error":"quota exhausted"}');return;}
    const hasTool=body.messages.some(m=>m.role==='tool');
    const delta=hasTool ? {content:'Local router tool smoke passed.'} : {tool_calls:[{index:0,id:'read_marker',type:'function',function:{name:'Read',arguments:JSON.stringify({file_path:marker})}}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [
      {id:'mock-chat',choices:[{index:0,delta:{role:'assistant',reasoning_content:'Check the requested local file.'}}]},
      {id:'mock-chat',choices:[{index:0,delta}]},
      {id:'mock-chat',choices:[{index:0,delta:{},finish_reason:hasTool?'stop':'tool_calls'}]},
      {id:'mock-chat',choices:[],usage:{prompt_tokens:20,completion_tokens:10}},'[DONE]',
    ]) res.write(frame(event));
    res.end();
  });
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));
  const portServer=http.createServer(); await new Promise(r=>portServer.listen(0,'127.0.0.1',r));
  const port=portServer.address().port; await new Promise(r=>portServer.close(r));
  const file=path.join(root,'pool.json'), url='http://127.0.0.1:'+backend.address().port;
  writeConfig(file,normalizeConfig({port,providers:[
    {id:'ollama',name:'Ollama mock',baseUrl:url+'/ollama/v1',protocol:'openai',models:[{id:'kimi-k3',upstream:'kimi-k3:cloud'}],keys:[{id:'bad',key:'exhausted'}]},
    {id:'command',name:'Command mock',baseUrl:url+'/provider/v1',protocol:'openai',models:[{id:'kimi-k3',upstream:'moonshotai/kimi-k3'}],keys:[{id:'good',key:'local-good'}]},
  ]}));
  const router=startApiRouter({configPath:file}); await router.ready;
  try{
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|USERPROFILE|HOMEDRIVE|HOMEPATH)$/i.test(k)));
    Object.assign(env,{CLAUDE_CONFIG_DIR:path.join(root,'claude-config'),ANTHROPIC_API_KEY:'local-client',ANTHROPIC_BASE_URL:router.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'});
    const proc=spawn(exe,['--bare','-p','--output-format','stream-json','--input-format','stream-json','--include-partial-messages','--verbose','--model','kimi-k3','--tools','Read','--allowedTools','Read','--max-turns','3'],{cwd:root,env,windowsHide:true});
    let output='',errors=''; proc.stdout.on('data',c=>output+=c);proc.stderr.on('data',c=>errors+=c);
    proc.stdin.end(JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:'Read marker.txt and report its contents.'}]}})+'\n');
    const timer=setTimeout(()=>proc.kill(),30000);
    const code=await new Promise((r,j)=>{proc.on('exit',r);proc.on('error',j);});clearTimeout(timer);
    const events=output.split(/\r?\n/).filter(Boolean).map(s=>{try{return JSON.parse(s);}catch{return {};}});
    const result=events.find(e=>e.type==='result');
    assert.equal(code,0,errors+'\n'+output);
    assert.equal(result?.is_error,false,output);
    assert.match(result?.result || '',/Local router tool smoke passed/);
    assert.equal(requests[0].key,'Bearer exhausted');assert.equal(requests[1].key,'Bearer local-good');
    assert.ok(requests.slice(1).every(r=>r.body.model==='moonshotai/kimi-k3'));
    const continuation=requests.find(r=>r.body.messages.some(m=>m.role==='tool'));
    assert.ok(continuation,'CLI must send a tool result through the bridge');
    assert.match(JSON.stringify(continuation.body.messages),/router-tool-history-7391/);
    assert.ok(continuation.body.messages.some(m=>m.role==='assistant' && m.reasoning_content==='Check the requested local file.'),'reasoning must survive the real CLI tool round');
    console.log('PASS: installed Claude CLI completed a Read tool round through OpenAI providers after same-model quota failover; history and reasoning preserved; local endpoints only');
  }finally{
    await router.stop();backend.closeAllConnections();await new Promise(r=>backend.close(r));
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('dsh-router-cli-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
