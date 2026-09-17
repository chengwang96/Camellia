'use strict';

// The installed native runtimes execute every tool. Only model responses are
// scripted, on loopback, to separate integration bugs from model decisions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { ENGINES, runEngine, isolatedEnvironment, stopProcess } = require('../src/benchmark/engines');
const { AcpSession } = require('../src/engines/acp-session');
const { dshAcpSpec } = require('../src/engines/dsh-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { ClaudeSession } = require('../src/engines/claude-session');
const { claudeSpec } = require('../src/benchmark/engines');

const CONTENT = 'ORIGINAL_词🙂\r\nquotes: "double" \'single\' $literal `backtick` \\slash\r\n';
const EDITED = CONTENT.replace('ORIGINAL_词🙂', 'EDITED_词🙂');
const normalize = text => text.replace(/\r\n/g, '\n');
const quotePs = text => "'" + text.replace(/'/g, "''") + "'";

function nativeCall(ctx, operation, options = {}) {
  const engine = ctx.engine, target = options.target || ctx.target;
  const annotation = { toolSummary: 'Isolated tool audit', toolAction: 'Checking tool integration' };
  let name, args;
  if (operation === 'read') {
    name = { claude: 'Read', codex: 'exec_command', dsh: 'read', kimi: 'Read', antigravity: 'view_file' }[engine];
    args = engine === 'codex' ? { cmd: '[System.IO.File]::ReadAllText(' + quotePs(target) + ')', login: false }
      : engine === 'antigravity' ? { AbsolutePath: target, ...annotation }
      : { [engine === 'kimi' ? 'path' : 'file_path']: target };
  } else if (operation === 'glob' || operation === 'grep') {
    name = engine === 'codex' ? 'exec_command' : engine === 'antigravity' ? (operation === 'glob' ? 'find_by_name' : 'grep_search')
      : engine === 'dsh' ? operation : operation === 'glob' ? 'Glob' : 'Grep';
    args = engine === 'codex' ? { cmd: (operation === 'glob' ? 'rg --files ' : "rg -n 'READ_BETA' ") + quotePs(ctx.cwd), login: false }
      : engine === 'antigravity' ? operation === 'glob' ? { SearchDirectory: ctx.cwd, Pattern: '*.txt', ...annotation }
        : { SearchPath: ctx.cwd, Query: 'READ_BETA', MatchPerLine: true, ...annotation }
      : { path: ctx.cwd, pattern: operation === 'glob' ? '*.txt' : 'READ_BETA', ...(operation === 'grep' && engine !== 'dsh' ? { output_mode: 'content' } : {}) };
  } else if (operation === 'shell') {
    name = { claude: 'Bash', codex: 'exec_command', dsh: 'pwsh', kimi: 'Bash', antigravity: 'run_command' }[engine];
    // echo/exit work in both native Bash (Claude/Kimi) and pwsh.
    const command = engine === 'claude' && process.argv.includes('--complex-shell')
      ? 'echo "=== fixture references ==="; grep -rn "ARDS/tex\\|ARDS\\\\tex\\|build_compile_test\\|/tex/fig\\|tex/ards" "' + ctx.cwd.replace(/\\/g, '/') + '" 2>/dev/null | head -20; echo "(empty = no script depends on it)"; echo; find "' + ctx.cwd.replace(/\\/g, '/') + '" -maxdepth 2 -name ".git" 2>/dev/null; echo EXPECTED_SHELL_ERROR_7; exit 7'
      : 'echo EXPECTED_SHELL_ERROR_7; exit 7';
    args = engine === 'antigravity' ? { CommandLine: command, Cwd: ctx.cwd, WaitMsBeforeAsync: 10000, ...annotation }
      : engine === 'codex' ? { cmd: command, login: false }
      : { command, description: 'Exercise a known failing command' };
  } else if (engine === 'codex') {
    name = 'apply_patch';
    const file = path.basename(target);
    args = { input: operation === 'write'
      ? '*** Begin Patch\n*** Add File: ' + file + '\n' + normalize(CONTENT).trimEnd().split('\n').map(line => '+' + line).join('\n') + '\n*** End Patch'
      : '*** Begin Patch\n*** Update File: ' + file + '\n@@\n-' + (options.invalid ? 'DOES_NOT_EXIST_742' : 'ORIGINAL_词🙂') + '\n+EDITED_词🙂\n*** End Patch' };
  } else if (operation === 'write') {
    name = engine === 'antigravity' ? 'write_to_file' : engine === 'dsh' ? 'write' : 'Write';
    args = engine === 'antigravity' ? { TargetFile: target, CodeContent: CONTENT, Overwrite: false, Description: 'Create an isolated fixture', ...annotation }
      : { [engine === 'kimi' ? 'path' : 'file_path']: target, content: CONTENT };
  } else {
    name = engine === 'antigravity' ? 'replace_file_content' : engine === 'dsh' ? 'edit' : 'Edit';
    const old = options.invalid ? 'DOES_NOT_EXIST_742' : 'ORIGINAL_词🙂';
    args = engine === 'antigravity' ? { TargetFile: target, TargetContent: old, ReplacementContent: 'EDITED_词🙂',
      AllowMultiple: false, StartLine: 1, EndLine: 2, Instruction: 'Replace the fixture marker', Description: 'Check native editing', ...annotation }
      : { [engine === 'kimi' ? 'path' : 'file_path']: target, old_string: old, new_string: 'EDITED_词🙂' };
  }
  const declaration = ctx.tools.find(t => t.function.name === name);
  if (options.escalate) Object.assign(args, { sandbox_permissions: 'danger-full-access', justification: 'Check denial of an isolated fixture write' });
  assert.ok(declaration, ctx.id + ': missing native ' + name);
  for (const required of declaration.function.parameters.required || []) assert.ok(required in args, name + ': missing ' + required);
  return { id: ctx.id + '_' + ctx.stage + '_' + operation + '_' + (options.suffix || '0'), type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function nextCalls(ctx, body) {
  const results = body.messages.filter(m => m.role === 'tool');
  const output = id => {
    const result = results.findLast(m => m.tool_call_id === id);
    assert.ok(result, ctx.id + ': tool result ID lost: ' + id);
    return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  };
  if (ctx.stage) {
    ctx.returned.push(...ctx.lastCalls.map(call => ({ id: call.id, name: call.function.name, output: output(call.id) })));
  }
  if (ctx.denial) {
    ctx.tools = body.tools;
    if (!ctx.stage++) {
      ctx.lastCalls = [nativeCall(ctx, 'write', { target: ctx.deniedTarget })];
      return ctx.lastCalls;
    }
    if (ctx.engine === 'dsh' && ctx.stage === 2) {
      ctx.lastCalls = [nativeCall(ctx, 'write', { target: ctx.deniedTarget, escalate: true })];
      return ctx.lastCalls;
    }
    assert.equal(fs.existsSync(ctx.deniedTarget), ctx.allow, ctx.id + ': native write must follow the approval answer');
    if (ctx.allow) assert.equal(normalize(fs.readFileSync(ctx.deniedTarget, 'utf8')), normalize(CONTENT));
    else assert.match(ctx.returned.at(-1).output, /denied|reject|not allowed|permission/i);
    return [];
  }
  let calls;
  switch (ctx.stage) {
    case 0:
      ctx.tools = body.tools;
      if (engineLocked(ctx)) assert.ok(!ctx.tools.some(t => t.function.name === 'EnterPlanMode'), 'Allow all chat must keep the chosen mode');
      calls = [nativeCall(ctx, 'read', { target: ctx.a, suffix: 'a' }), nativeCall(ctx, 'read', { target: ctx.b, suffix: 'b' })];
      if (process.argv.includes('--single-read')) calls.pop();
      break;
    case 1:
      assert.match(output(ctx.lastCalls[0].id), /READ_ALPHA_词/);
      if (ctx.lastCalls[1]) assert.match(output(ctx.lastCalls[1].id), /READ_BETA_🙂/);
      calls = [nativeCall(ctx, 'write')]; break;
    case 2:
      assert.equal(normalize(fs.readFileSync(ctx.target, 'utf8')), normalize(CONTENT), ctx.id + ': native write changed bytes');
      calls = [nativeCall(ctx, 'read')]; break;
    case 3:
      assert.match(output(ctx.lastCalls[0].id), /ORIGINAL_词/);
      calls = [nativeCall(ctx, 'edit')]; break;
    case 4:
      assert.equal(normalize(fs.readFileSync(ctx.target, 'utf8')), normalize(EDITED), ctx.id + ': edit did not apply');
      calls = [nativeCall(ctx, 'shell')]; break;
    case 5:
      assert.match(output(ctx.lastCalls[0].id), /EXPECTED_SHELL_ERROR_7/);
      assert.match(output(ctx.lastCalls[0].id), /(?:exit|code|error|failed|status)[\s\S]{0,80}7|7[\s\S]{0,80}(?:exit|code|error|failed|status)/i, ctx.id + ': nonzero exit lost');
      // The SDK intentionally invokes an edit-repair model for unmatched text.
      // A missing file is an unambiguous native failure, without that repair.
      calls = [nativeCall(ctx, 'edit', { invalid: true, ...(ctx.engine === 'antigravity' ? { target: path.join(ctx.cwd, 'missing-target.txt') } : {}) })]; break;
    case 6:
      assert.equal(normalize(fs.readFileSync(ctx.target, 'utf8')), normalize(EDITED), ctx.id + ': failed edit mutated file');
      assert.match(output(ctx.lastCalls[0].id), /error|fail|not found|not find|no match|not match|does not|could not|couldn't/i, ctx.id + ': native edit error lost');
      calls = [nativeCall(ctx, 'glob'), nativeCall(ctx, 'grep')]; break;
    case 7:
      assert.match(output(ctx.lastCalls[0].id), /alpha\.txt/);
      assert.match(output(ctx.lastCalls[1].id), /READ_BETA/);
      calls = []; break;
    default: throw new Error(ctx.id + ': unexpected extra model request');
  }
  ctx.stage++; ctx.lastCalls = calls;
  return calls;
}

function engineLocked(ctx) { return ctx.engine === 'claude' && process.argv.includes('--chat') && !ctx.denial; }

async function respond(res, body, calls) {
  const message = { role: 'assistant', content: calls.length ? null : 'TOOL_AUDIT_COMPLETE', ...(calls.length ? { tool_calls: calls } : {}) };
  const usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture', choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage })); return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = delta => res.write(frame({ id: 'fixture', model: body.model, choices: [{ index: 0, delta }] }));
  chunk({ role: 'assistant', reasoning_content: 'Check isolated files.' });
  chunk({ content: calls.length ? 'Running the native tools.' : 'TOOL_AUDIT_COMPLETE' });
  const whole = process.argv.includes('--whole-tool-chunks');
  if (whole) chunk({ tool_calls: calls.map((call, index) => ({ ...call, index })) });
  else for (let index = 0; index < calls.length; index++) chunk({ tool_calls: [{ ...calls[index], index, function: { name: calls[index].function.name, arguments: '' } }] });
  // Interleave tool arguments, including split JSON escapes and surrogate pairs.
  // TCP writes are split inside UTF-8 as well: parsers must preserve code points.
  const longest = whole ? 0 : Math.max(0, ...calls.map(c => c.function.arguments.length));
  for (let offset = 0; offset < longest; offset += 3) {
    for (let index = 0; index < calls.length; index++) {
      const part = calls[index].function.arguments.slice(offset, offset + 3);
      if (!part) continue;
      const data = Buffer.from(frame({ id: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: part } }] } }] }));
      for (let start = 0; start < data.length; start += 31) res.write(data.subarray(start, start + 31));
    }
  }
  res.write(frame({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage }));
  res.end(frame('[DONE]'));
}

async function runChat(options) {
  const { home, cwd, runtime, route, model, signal, onEvent, prompt, engine, denial, allow } = options;
  let session;
  const logs = [];
  const deferred = Promise.withResolvers();
  const abort = () => deferred.resolve({ ok: false, cancelled: true, error: String(signal.reason) });
  signal.addEventListener('abort', abort, { once: true });
  try {
    const permissionMode = denial ? 'default' : 'bypassPermissions';
    const spec = engine === 'claude' ? claudeSpec({ home, cwd, model, route, env: isolatedEnvironment(home, process.execPath) })
      : dshAcpSpec({ runtime, home: path.join(home, '.dsh'), model, route, permissionMode, env: isolatedEnvironment(home, process.execPath) });
    if (engine === 'claude') spec.args[spec.args.indexOf('--permission-mode') + 1] = permissionMode;
    const Session = engine === 'claude' ? ClaudeSession : AcpSession;
    session = new Session({ name: engine + ' chat audit', gen: 1, settings: { cwd, model, permissionMode }, opts: { lockPermissionMode: true },
      spec, exe: engine === 'claude' ? runtime.file : process.execPath, spawn, history: new ClaudeHistory(path.join(home, 'history')), log: line => logs.push(line),
      onEvent: ev => { if (ev.type === 'gui:permission') session.answerPermission(ev.requestId, !denial || allow, ev.input); onEvent(ev); },
      onSessionId: () => {}, onResult: result => deferred.resolve({ ok: !result.is_error, result }) });
    session.start(); session.sendUserMessage(prompt);
    return { ...await deferred.promise, log: logs.join('\n') };
  } finally { signal.removeEventListener('abort', abort); await stopProcess(session?.proc); await session?.kill(); }
}

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tools-audit-'));
  const runtimes = createRuntimeManager({ root: appRoot, installRoot: appRoot, node: () => process.execPath });
  const contexts = new Map(), diagnostics = [], failures = [];
  let router;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body.tools?.length) { diagnostics.push({ auxiliary: true, body }); await respond(res, body, []); return; }
      const ctx = [...contexts.values()].find(ctx => JSON.stringify(body.messages).includes('TOOL_AUDIT_' + ctx.id + '_END'));
      assert.ok(ctx, 'Unidentified native request');
      assert.equal(req.headers.authorization, 'Bearer loopback-only');
      assert.equal(body.model, 'audit-upstream');
      diagnostics.push({ engine: ctx.id, stage: ctx.stage, body });
      if (process.argv.includes('--upstream-error') && ctx.stage === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'EXPECTED_UPSTREAM_FAILURE' } })); return;
      }
      // DSH separately asks for a session title, without tools or tool history.
      await respond(res, body, body.tools?.length ? nextCalls(ctx, body) : []);
    } catch (error) {
      failures.push(error.message);
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message, type: 'invalid_request_error' } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const configPath = path.join(root, 'router.json');
  writeConfig(configPath, normalizeConfig({ port, providers: [{ id: 'fixture', name: 'Loopback fixture', type: 'custom',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', protocol: 'openai',
    models: [{ id: 'audit-model', upstream: 'audit-upstream' }], keys: [{ id: 'fixture-key', key: 'loopback-only' }] }] }));
  try {
    router = startApiRouter({ configPath, timeoutMs: 30000 }); await router.ready;
    const selected = process.argv.find(arg => arg.startsWith('--engine='))?.slice(9);
    const denial = process.argv.includes('--permissions');
    const allow = process.argv.includes('--allow');
    const results = await Promise.allSettled((denial ? ['claude', 'dsh-chat'] : [...ENGINES, 'dsh-chat']).filter(id => !selected || id === selected).map(async id => {
      const engine = id === 'dsh-chat' ? 'dsh' : id;
      const cwd = path.join(root, id, 'Project With Spaces'), home = path.join(root, id, 'profile');
      fs.mkdirSync(cwd, { recursive: true });
      const ctx = { id, engine, cwd, target: path.join(cwd, 'unicode edit.txt'), a: path.join(cwd, 'alpha.txt'), b: path.join(cwd, 'beta.txt'), stage: 0, returned: [],
        denial, allow, deniedTarget: path.join(root, id, 'permission-outside-workspace.txt') };
      fs.writeFileSync(ctx.a, 'READ_ALPHA_词'); fs.writeFileSync(ctx.b, 'READ_BETA_🙂'); contexts.set(id, ctx);
      const observedTools = [];
      const usage = [];
      const route = router.createScope({ model: 'audit-model', providerId: 'fixture', onToolResult: result => observedTools.push(result), onUsage: record => usage.push(record) });
      const events = [], control = new AbortController(), timer = setTimeout(() => control.abort('Native tool audit timed out'), 90000);
      console.log('Auditing ' + id);
      try {
        const result = await (id === 'dsh-chat' || denial || process.argv.includes('--chat') ? runChat : runEngine)({ engine, denial, allow, runtime: runtimes.locate(engine, 'api'), node: process.execPath,
          cwd, home, route, model: 'audit-model', signal: control.signal, onEvent: event => events.push(event),
          prompt: 'TOOL_AUDIT_' + id + '_END Work only in this isolated test project. Execute the prescribed file reads, edits and failure probes, then finish.' });
        await route.close();
        diagnostics.push({ engine: id, result, events, returned: ctx.returned, observedTools, usage });
        if (process.argv.includes('--upstream-error')) {
          const lastAgent = usage.filter(record => record.hasTools).at(-1);
          assert.equal(lastAgent.outcome, 'error'); assert.match(lastAgent.error, /EXPECTED_UPSTREAM_FAILURE/);
          if (engine !== 'kimi') assert.equal(result.ok, false, id + ': a terminal API error must not report success');
          console.log('PASS ' + id + ': terminal upstream error recorded' + (result.ok ? '; native end_turn requires the benchmark API-error guard' : ' and reported by the runtime'));
          return;
        }
        assert.equal(result.ok, true, id + ': ' + JSON.stringify(result));
        if (denial) {
          assert.equal(ctx.stage, ctx.engine === 'dsh' ? 3 : 2);
          assert.ok(events.some(event => event.type === 'gui:permission'), id + ': native permission must reach the UI');
          console.log('PASS ' + id + ': native permission prompt, ' + (allow ? 'approved write executed with exact bytes' : 'denial returned to the model, denied file absent'));
          return;
        }
        assert.equal(ctx.stage, 8, id + ': native tool loop ended early');
        assert.equal(events.filter(event => event.type === 'gui:permission').length, 0, id + ': Allow all must execute ordinary native tools without approval');
        assert.equal(observedTools.length, process.argv.includes('--single-read') ? 8 : 9, id + ': duplicate or missing tool observations');
        assert.deepEqual(observedTools.filter(tool => tool.is_error).map(tool => tool.id), [id + '_4_shell_0', id + '_5_edit_0'], id + ': tool failures missing from benchmark diagnostics');
        console.log('PASS ' + id + ': parallel reads/searches, split arguments, native write/edit, shell and edit errors, exact result IDs');
      } finally { clearTimeout(timer); await route.close(); }
    }));
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason.message);
    assert.deepEqual(failures, []);
    assert.equal(router.getState().activeRequests, 0);
  } finally {
    await router?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const file = path.join(appRoot, 'dist', process.argv.includes('--upstream-error') ? 'tools-native-upstream-error.json'
      : process.argv.includes('--permissions') ? 'tools-native-permissions-' + (process.argv.includes('--allow') ? 'allow' : 'deny') + '.json' : 'tools-native-audit.json');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ failures, diagnostics }, null, 2));
    console.log('Diagnostics: ' + file);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-tools-audit-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
