'use strict';
// Optional smoke test using the installed CLI, synthetic history, and a loopback
// response server. All Claude configuration is isolated; no model API is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');

async function run() {
  const exe = process.argv[2];
  if (!exe) throw new Error('Usage: node tests/claude-cli-resume.cjs <absolute claude.exe path>');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-resume-'));
  const config = path.join(root, 'config');
  const original = path.join(root, 'original');
  const destination = path.join(root, 'destination');
  const sid = randomUUID();
  const project = path.join(config, 'projects', original.replace(/[^a-z0-9]/gi, '-'));
  for (const dir of [original, destination, project]) fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(project, sid + '.jsonl');
  const userId = randomUUID();
  const common = { cwd: original, sessionId: sid, version: '2.1.218', isSidechain: false, userType: 'external', timestamp: new Date().toISOString() };
  fs.writeFileSync(transcript, [
    { ...common, uuid: userId, parentUuid: null, type: 'user', message: { role: 'user', content: 'Original history marker: workspace-smoke-9274' } },
    { ...common, uuid: randomUUID(), parentUuid: userId, type: 'assistant', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'History acknowledged.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      requests.push(JSON.parse(body));
      const message = { id: 'msg_local_test', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const ev of [
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local resume smoke passed.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } },
        { type: 'message_stop' },
      ]) res.write('event: ' + ev.type + '\ndata: ' + JSON.stringify(ev) + '\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    // Only platform/runtime variables are carried over. Explicit dummy auth,
    // bare mode, and config isolation prevent real credentials or hooks loading.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|USERPROFILE|HOMEDRIVE|HOMEPATH)$/i.test(key)));
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'local-test-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
    });
    const args = ['--bare', '-p', '--resume', transcript, '--output-format', 'stream-json', '--input-format', 'stream-json', '--replay-user-messages', '--include-partial-messages', '--prompt-suggestions', 'true', '--verbose', '--model', 'test-model', '--tools=Read'];
    const proc = spawn(exe, args, { cwd: destination, env, windowsHide: true });
    proc.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Continue the saved history.' }] } }) + '\n');
    let output = '', errors = '';
    proc.stdout.on('data', (chunk) => { output += chunk; });
    proc.stderr.on('data', (chunk) => { errors += chunk; });
    const timeout = setTimeout(() => proc.kill(), 30000);
    const code = await new Promise((resolve, reject) => { proc.on('exit', resolve); proc.on('error', reject); });
    clearTimeout(timeout);
    const events = output.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } });
    const init = events.find((ev) => ev.type === 'system' && ev.subtype === 'init');
    const result = events.find((ev) => ev.type === 'result');
    assert.equal(code, 0, errors + '\n' + output);
    assert.equal(init?.session_id, sid, output);
    assert.equal(fs.realpathSync(init.cwd), fs.realpathSync(destination));
    assert.equal(result?.is_error, false, output);
    assert.ok(requests.some((req) => JSON.stringify(req.messages).includes('workspace-smoke-9274')), 'Resumed request must include the original history');
    console.log('PASS: installed Claude CLI resumed the original session ID and history from an absolute transcript path in a different cwd; local API only');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('dsh-cli-resume-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
run().catch((err) => { console.error(err.message); process.exitCode = 1; });
