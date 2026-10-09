'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { UnixJobJournal, prepareUnixJob, recoverUnixJob, helperExecutable } = require('../src/engines/discussions/unix-job');
const { createCodex } = require('../src/engines/codex');
const { NativeDiscussionAdapter } = require('../src/engines/discussions/native-adapter');
const { NativeSessionOwnership } = require('../src/engines/discussions/native-ownership');
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');
const unix = { skip: !['darwin', 'linux'].includes(process.platform), timeout: 60000 };
const identity = () => ({ runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const deadline = Date.now() + 15000; while (!fn()) { if (Date.now() > deadline) throw new Error('Native process fixture timed out'); await delay(40); } }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-unix-job-'));
  const journal = new UnixJobJournal({ dir: path.join(dir, 'jobs') });
  const scope = identity(), job = await prepareUnixJob({ identity: scope, journal });
  t.after(async () => { await job.stop(); fs.rmSync(dir, { recursive:true, force:true }); });
  const opts = { cwd:dir, env:{ ...process.env }, stdio:['pipe','pipe','pipe'] };
  return { dir, journal, scope, job, opts };
}
function treeSource(dir) {
  const file = path.join(dir, 'tree.cjs');
  fs.writeFileSync(file, `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const dir=process.argv[2],depth=Number(process.argv[3]);
fs.writeFileSync(path.join(dir,'pid-'+depth),String(process.pid));
if(depth<2) spawn(process.execPath,[__filename,dir,String(depth+1),process.argv[4]||''],{detached:true,stdio:'ignore'}).unref();
setInterval(()=>{fs.writeFileSync(path.join(dir,'beat-'+depth),String(Date.now()));
if(depth===0&&process.argv[4]==='exit-root'&&fs.existsSync(path.join(dir,'beat-2')))process.exit(0);},25);`);
  return file;
}
async function startTree(h, exitRoot = false) {
  const proc = h.job.spawn(process.execPath, [treeSource(h.dir), h.dir, '0', exitRoot ? 'exit-root' : ''], h.opts);
  await until(() => [0,1,2].every(depth => fs.existsSync(path.join(h.dir, 'beat-'+depth))));
  return { proc, pids:[0,1,2].map(depth => Number(fs.readFileSync(path.join(h.dir, 'pid-'+depth)))) };
}

test('Unix supervision preserves byte streams and arguments while CLI output cannot forge stop evidence', unix, async t => {
  const h = await fixture(t), args = ['', 'space value', 'quote"\\value', '中文 $(not-a-shell)'];
  const source = `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>data+=s);process.stdin.on('end',()=>{
console.log(JSON.stringify({args:process.argv.slice(1),env:process.env.TASK_JOB_VALUE,data}));
console.log(JSON.stringify({type:'stopped',sealed:true,activeProcesses:0}));console.error('separate stderr');});`;
  const proc = h.job.spawn(process.execPath, ['-e', source, ...args], { ...h.opts, env:{ ...h.opts.env, TASK_JOB_VALUE:'本轮' } });
  let output = '', errors = ''; proc.stdout.on('data', s => output += s); proc.stderr.on('data', s => errors += s);
  const closed = once(proc, 'close'); proc.stdin.end('输入\n'+'x'.repeat(100000)); await closed;
  const rows = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows[0], { args, env:'本轮', data:'输入\n'+'x'.repeat(100000) });
  assert.equal(rows[1].type, 'stopped'); assert.match(errors, /separate stderr/);
  const proof = await h.job.stop(); assert.equal(proof.activeProcesses, 0); assert.equal(proof.stopped, true);
  assert.ok(proof.totalProcesses >= 1); assert.equal(proc.exitCode, 0);
  assert.throws(() => h.job.spawn(process.execPath, [], h.opts), /stopped|already used/);
});
test('Unix engines cannot inherit the private control and evidence pipes', unix, async t => {
  const h = await fixture(t);
  const source = 'if ( : >&3 ) 2>/dev/null || ( : >&4 ) 2>/dev/null; then exit 23; fi; printf private-pipes-closed';
  const proc = h.job.spawn('/bin/sh', ['-c', source], h.opts);
  let output = ''; proc.stdout.on('data', chunk => output += chunk); proc.stderr.resume();
  await once(proc, 'close');
  assert.equal(proc.exitCode, 0); assert.equal(output, 'private-pipes-closed');
  assert.equal((await h.job.stop()).activeProcesses, 0);
});
test('Unix root exit drains detached children and grandchildren', unix, async t => {
  const h = await fixture(t), { pids } = await startTree(h, true);
  await h.job.stop();
  for (const pid of pids) await until(() => !alive(pid));
});
test('Unix stop drains an active tree even when the engine never reads its full input pipe', unix, async t => {
  const h = await fixture(t), { proc, pids } = await startTree(h);
  proc.stdin.write(Buffer.alloc(2*1024*1024));
  const proof = await h.job.stop(); assert.equal(proof.activeProcesses, 0);
  for (const pid of pids) await until(() => !alive(pid));
});
test('Unix recovery after supervisor loss uses OS membership and leaves unrelated processes running', unix, async t => {
  const h = await fixture(t), { pids } = await startTree(h);
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio:'ignore', detached:true });
  t.after(() => other.kill('SIGKILL'));
  const began = performance.now();
  process.kill(h.job.supervisorPid, 'SIGKILL');
  const proof = await h.job.stop(); assert.equal(proof.stopped, true); assert.equal(proof.activeProcesses, 0);
  assert.ok(performance.now() - began < 10000, 'supervisor loss recovers without waiting for the stop timeout');
  for (const pid of pids) await until(() => !alive(pid));
  assert.equal(alive(other.pid), true);
});
test('Unix recovery fences an unused reservation and cannot mistake an unrelated PID for a launch', unix, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-unix-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const journal = new UnixJobJournal({ dir }), scope = identity(), record = journal.reserve(scope);
  assert.equal((await recoverUnixJob({ identity:scope, journal })).activeProcesses, 0);
  const host = spawn(helperExecutable(), [], { stdio:['ignore','ignore','ignore','pipe','pipe'] });
  const closed = once(host, 'close'); host.stdio[4].resume();
  host.stdio[3].end(JSON.stringify({ ...record, type:'initialize', nonce:'late-helper' })+'\n');
  assert.notEqual((await closed)[0], 0, 'recovered deliveries cannot launch late');
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio:'ignore', detached:true });
  t.after(() => other.kill('SIGKILL')); await once(other, 'spawn');
  const badScope = identity(), badRecord = journal.reserve(badScope);
  fs.writeFileSync(badRecord.stateFile, JSON.stringify({ version:1, ...badScope, rootPid:other.pid, marker:'a'.repeat(64) }));
  await assert.rejects(recoverUnixJob({ identity:badScope, journal }), /without proof|recovery/);
  assert.equal(alive(other.pid), true);
});
test('an app disappearing closes Unix control and leaves no supervised descendants', unix, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-unix-owner-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const workerFile = path.join(dir, 'owner.cjs'), source = require.resolve('../src/engines/discussions/unix-job');
  const scope = identity(), tree = treeSource(dir);
  fs.writeFileSync(workerFile, `const {UnixJobJournal,prepareUnixJob}=require(${JSON.stringify(source)});
(async()=>{const job=await prepareUnixJob({identity:${JSON.stringify(scope)},journal:new UnixJobJournal({dir:${JSON.stringify(path.join(dir,'jobs'))}})});
job.spawn(process.execPath,${JSON.stringify([tree,dir,'0',''])},{cwd:${JSON.stringify(dir)},env:{...process.env},stdio:['pipe','pipe','pipe']});})();`);
  const worker = spawn(process.execPath, [workerFile], { stdio:'ignore' });
  t.after(() => { if (alive(worker.pid)) worker.kill('SIGKILL'); });
  await until(() => [0,1,2].every(depth => fs.existsSync(path.join(dir, 'beat-'+depth))));
  const pids = [0,1,2].map(depth => Number(fs.readFileSync(path.join(dir, 'pid-'+depth))));
  worker.kill('SIGKILL');
  for (const pid of pids) await until(() => !alive(pid));
});
test('the native Codex driver retains its pool until Unix descendants are confirmed stopped', unix, async t => {
  const h = await fixture(t), nativeId = randomUUID(), tree = treeSource(h.dir);
  const file = path.join(h.dir, 'protocol.cjs');
  fs.writeFileSync(file, `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const message=JSON.parse(line);if(message.id===undefined)return;let result={};
if(message.method==='thread/start')result={thread:{id:${JSON.stringify(nativeId)}}};
if(message.method==='turn/start'){
result={turn:{id:'fixture-turn'}};
spawn(process.execPath,[${JSON.stringify(tree)},${JSON.stringify(h.dir)},'1',''],{detached:true,stdio:'ignore'});
const timer=setInterval(()=>{if(!fs.existsSync(path.join(__dirname,'beat-2')))return;clearInterval(timer);
send({method:'item/completed',params:{threadId:${JSON.stringify(nativeId)},item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Fixture answer'}}});
send({method:'turn/completed',params:{threadId:${JSON.stringify(nativeId)},turn:{id:'fixture-turn',status:'completed'}}});},20);
}send({id:message.id,result});});process.stdin.on('end',()=>process.exit(0));`);
  const profile = { engine:'codex', connection:'api', model:'fixture-model', thinking:'', contextWindow:12000 };
  const input = { ...h.scope, discussionId:randomUUID(), participantId:randomUUID(), threadId:randomUUID(),
    requestId:'fixture', nativeId:null, cwd:h.dir, profile, bindingFingerprint:bindingFingerprint(profile) };
  let adapter, proof;
  const codex = createCodex({ dataDir:h.dir, loadConfig:()=>({}), saveConfig:()=>{}, getModels:()=>[profile.model],
    runtimes:()=>({locate:()=>({file:process.execPath})}), onEvent:event=>adapter.capture('codex',event), onGoal(){}, log(){} });
  const driver = { sessions:codex.sessions, ensure:codex.ensureSession };
  const policy = {
    async prepare() { return { settings:{model:profile.model,connection:'api',permissionMode:'plan',thinkingBudget:'',proxyUrl:'',contextWindow:12000},
      launch:{spawn:h.job.spawn,buildSpec:()=>({exe:process.execPath,args:[file],env:h.opts.env,cwd:h.dir})} }; },
    async verify() { return true; }, // Protocol fixture; not enforcement evidence.
    async confirmStopped({session}) {
      assert.strictEqual(driver.sessions.get({conversationId:input.runtimeId}),session);
      proof=await h.job.stop();assert.equal(proof.activeProcesses,0);return proof;
    },
  };
  adapter = new NativeDiscussionAdapter({engine:'codex',driver,policy,runtime:{version:'fixture',policyVersion:'fixture'},
    ownership:new NativeSessionOwnership({readOwners:()=>[]}), evidence:()=>({kind:'real',reference:'synthetic-policy-local-process-fixture-only',
      bindingFingerprint:bindingFingerprint(profile),runtimeVersion:'fixture',policyVersion:'fixture',mode:'tool-free',
      checks:Object.fromEntries(['isolatedSession','pinnedBinding','continuation','stopConfirmed','shellRestricted','mcpRestricted',
        'subagentsRestricted','escalationDisabled','conversationControlDisabled','toolsDisabled'].map(key=>[key,true]))})});
  const handle=adapter.create(input);
  assert.deepEqual(await handle.execute({plan:{prompt:'Fixture request'},signal:new AbortController().signal,onEvent:()=>true}),{text:'Fixture answer'});
  const session=driver.sessions.get({conversationId:input.runtimeId});
  const pids=[session.client.proc.pid,...[1,2].map(depth=>Number(fs.readFileSync(path.join(h.dir,'pid-'+depth))))];
  assert.ok(pids.every(alive));
  assert.equal((await handle.stop()).released,true);assert.equal(proof.kind,'unix-process-group');
  for(const pid of pids)await until(()=>!alive(pid));
  assert.equal(driver.sessions.sessions.size,0);
});
