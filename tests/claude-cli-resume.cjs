'use strict';
const { removeTree } = require('./test-fs.cjs');
// Optional smoke test using the installed CLI, synthetic history, and a loopback
// response server. All Claude configuration is isolated; no model API is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { claudeEditBoundary } = require('../src/engines/native-edit-boundary');

async function run() {
  const exe = process.argv[2];
  const edit = process.argv.includes('--edit');
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
  const keptId = randomUUID(), droppedId = randomUUID();
  const common = { cwd: original, sessionId: sid, version: '2.1.218', isSidechain: false, userType: 'external', timestamp: new Date().toISOString() };
  const rows = [
    { ...common, uuid: userId, parentUuid: null, type: 'user', message: { role: 'user', content: 'Original history marker: workspace-smoke-9274' } },
    { ...common, uuid: keptId, parentUuid: userId, type: 'assistant', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'History acknowledged.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  if (edit) rows.push(
    { ...common, uuid: droppedId, parentUuid: keptId, type: 'user', message: { role: 'user', content: 'SUPERSEDED_REQUEST' } },
    { ...common, uuid: randomUUID(), parentUuid: droppedId, type: 'assistant', message: { id: 'msg_discarded', type: 'message', role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'SUPERSEDED_REPLY' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } },
  );
  fs.writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const originalTranscript = fs.readFileSync(transcript, 'utf8');
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
    if (edit) {
      const boundary = await claudeEditBoundary(transcript, 'SUPERSEDED_REQUEST');
      assert.deepEqual(boundary, { resumeSessionAt: keptId, resumeDropsTurn: droppedId });
      args.push('--fork-session', '--resume-session-at', boundary.resumeSessionAt, '--resume-drops-turn', boundary.resumeDropsTurn);
    }
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
    if (edit) assert.notEqual(init?.session_id, sid, output);
    else assert.equal(init?.session_id, sid, output);
    assert.equal(fs.realpathSync(init.cwd), fs.realpathSync(destination));
    assert.equal(result?.is_error, false, output);
    assert.ok(requests.some((req) => JSON.stringify(req.messages).includes('workspace-smoke-9274')), 'Resumed request must include the original history');
    if (edit) {
      assert.ok(requests.length > 0);
      for (const request of requests) assert.doesNotMatch(JSON.stringify(request.messages), /SUPERSEDED_REQUEST|SUPERSEDED_REPLY/);
      assert.equal(fs.readFileSync(transcript, 'utf8'), originalTranscript, 'Native edit must preserve the source transcript');
    }
    console.log(edit
      ? 'PASS: installed Claude CLI guarded native edit retains earlier history, excludes the superseded turn, and preserves the source session; local API only'
      : 'PASS: installed Claude CLI resumed the original session ID and history from an absolute transcript path in a different cwd; local API only');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('dsh-cli-resume-'));
    removeTree(resolved);
  }
}
run().catch((err) => { console.error(err.message); process.exitCode = 1; });
