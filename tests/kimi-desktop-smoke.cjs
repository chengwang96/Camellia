'use strict';
const { removeTree } = require('./test-fs.cjs');

// Exercise the actual Electron UI, IPC, router and installed Kimi process
// together. Fixtures are loopback only and all windows/storage are isolated.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const http = require('node:http');
const { writeConfig, normalizeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');

async function main() {
  if (!process.versions.electron) {
    const { spawn } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-smoke-'));
    fs.mkdirSync(path.join(root, 'home'));
    const env = { ...process.env, DSH_KIMI_UI_ROOT: root, DSH_HOME: path.join(root, 'dsh'),
      USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home'), TEST_NODE_EXE: process.execPath };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
      const timer = setTimeout(() => child.kill(), 50000);
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      clearTimeout(timer);
      assert.equal(code, 0);
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('kimi-desktop-smoke-'));
      removeTree(root);
    }
    return;
  }

  const { app, BrowserWindow } = require('electron');
  const root = process.env.DSH_KIMI_UI_ROOT;
  assert.ok(root && path.basename(root).startsWith('kimi-desktop-smoke-'));
  const cwd = path.join(root, 'Kimi Example');
  fs.mkdirSync(cwd);
  const requests = [];
  const titles = [];
  const fixture = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid JSON body"}'); return; }
    // Background conversation titles ask for a non-streaming completion. Answer
    // them as JSON and keep them out of the chat log: an SSE reply here would
    // look like a broken provider and cool the only key down before the real
    // turn is sent, and their position in the log is not deterministic.
    if (!body.stream) {
      titles.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'title', model: body.model, usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        choices: [{ index: 0, message: { role: 'assistant', content: '标题生成通过' }, finish_reason: 'stop' }] }));
      return;
    }
    requests.push(body);
    const userIndex = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('UI '));
    const user = JSON.stringify(body.messages[userIndex].content);
    // Shared-conversation context stuffing embeds earlier prompts as JSON data;
    // only the tail after them is the current instruction.
    const promptStart = Math.max(user.lastIndexOf('\\n\\nUI '), user.lastIndexOf('"UI '));
    const current = promptStart > 0 ? user.slice(promptStart) : user;
    const written = body.messages.slice(userIndex).some(m => m.role === 'tool');
    const useTool = current.includes('UI write') && !written;
    const delta = useTool ? { tool_calls: [{ index: 0, id: 'write-test', type: 'function', function: {
      name: 'Write', arguments: JSON.stringify({ path: path.join(cwd, 'result.txt'), content: 'Kimi UI fixture passed' }),
    } }] } : { content: '已完成文件写入，工作区和 API 线路正常。' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const value of [
      { id: 'ui', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先检查工作区，再写入文件。' } }] },
      { id: 'ui', choices: [{ index: 0, delta }] },
      { id: 'ui', choices: [{ index: 0, delta: {}, finish_reason: useTool ? 'tool_calls' : 'stop' }] }, '[DONE]',
    ]) res.write(frame(value));
    res.end();
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'desktop-config.json'), JSON.stringify({
    firstRunComplete: true, nodeExe: process.env.TEST_NODE_EXE, dshHome: path.join(root, 'dsh'),
    kimi: { model: 'kimi-k2.5', permissionMode: 'default' },
  }));
  writeConfig(path.join(root, 'dsh', 'ollama-proxy.json'), normalizeConfig({ port, providers: [{
    id: 'local', name: '本地测试线路', protocol: 'openai', baseUrl: 'http://127.0.0.1:' + fixture.address().port + '/v1',
    models: [{ id: 'kimi-k2.5', upstream: 'kimi-k2.5' }], keys: [{ id: 'local-key', key: 'local-fixture-only' }],
  }] }));
  app.setPath('userData', path.join(root, 'app'));
  app.disableHardwareAcceleration();
  const errors = [];
  app.on('browser-window-created', (_event, window) => {
    window.hide();
    window.webContents.on('preload-error', (_e, _p, error) => errors.push(error.message));
    window.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  });
  require('../src/main/main.js');
  await app.whenReady();
  let window;
  for (let i = 0; i < 150 && !window; i++) {
    window = BrowserWindow.getAllWindows()[0];
    if (!window) await new Promise(resolve => setTimeout(resolve, 30));
  }
  const js = code => window.webContents.executeJavaScript(code);
  async function until(code) {
    for (let i = 0; i < 300; i++) {
      if (!window.webContents.isLoading() && await js(`Boolean(${code})`)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const log = path.join(root, 'app', 'logs', 'dsh-desktop.log');
    throw new Error('UI condition timed out: ' + code + '\n' + await js("JSON.stringify({chat:document.querySelector('#chat')?.textContent,status:document.querySelector('#statusLine')?.textContent,running,currentRunId,acceptSessionEvents})")
      + '\nErrors: ' + JSON.stringify(errors) + '\nRequests: ' + requests.length + '\nLast request: ' + JSON.stringify(requests.at(-1)?.messages.map(m => ({ role: m.role, content: JSON.stringify(m.content).slice(0, 160) }))) + '\n' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(-5000) : 'No log'));
  }
  const shots = path.resolve(__dirname, '../dist/ui-preview');
  fs.mkdirSync(shots, { recursive: true });
  async function snapshot(name) {
    const html = await js(`(() => {
      const root = document.documentElement.cloneNode(true);
      root.querySelectorAll('script').forEach(s => s.remove());
      root.querySelectorAll('link[href]').forEach(s => s.href = new URL(s.getAttribute('href'), location.href).href);
      return '<!doctype html>' + root.outerHTML;
    })()`);
    fs.writeFileSync(path.join(shots, name + '.html'), html);
  }
  await until("document.querySelector('#enterKimi')");
  await js("document.querySelector('#enterKimi').click()");
  await until("document.body.dataset.harness === 'kimi'");
  const ws = await js(`chatApi.metaOp(${JSON.stringify({ op: 'create-workspace', name: '示例工作区', path: cwd })})`);
  await js(`sidebar.load().then(() => newSession(${JSON.stringify(ws.workspace.id)}))`);
  async function send(prompt) {
    await js(`document.querySelector('#input').value = ${JSON.stringify(prompt)}; send()`);
  }
  await send('UI write 请在工作区写入 result.txt，并检查结果。');
  await until("document.querySelector('#permMask.visible')");
  // Switching harnesses must not strand a pending native approval.
  await js("document.querySelector('#backToHome').click()");
  await until("document.querySelector('#enterKimi')");
  await js("document.querySelector('#enterKimi').click()");
  await until("document.querySelector('#permMask.visible')");
  assert.equal(await js("document.querySelector('#permDefaultActions').hidden"), true);
  assert.ok(await js("document.querySelectorAll('#permOptions button').length >= 2"));
  await snapshot('kimi-permission');
  await js("document.querySelector('#permOptions .perm-allow').click()");
  await until("document.querySelector('.run-result.ok')");
  assert.equal(fs.readFileSync(path.join(cwd, 'result.txt'), 'utf8'), 'Kimi UI fixture passed');
  assert.equal(await js("document.querySelectorAll('.tool-card').length"), 1);
  assert.ok(await js("document.querySelector('.tool-state.done') !== null"));
  const chatText = await js("document.querySelector('#chat').textContent");
  assert.match(chatText, /先检查工作区，再写入文件。/);
  assert.match(chatText, /已完成文件写入，工作区和 API 线路正常。/);
  assert.equal(await js("document.querySelector('.turn-meta span').textContent"), 'Kimi');
  await js('sidebar.load()');
  const id = await js('context.sessionId');
  assert.equal((await js(`chatApi.loadSession(${JSON.stringify(id)})`)).workspaceId, ws.workspace.id);
  // The background title request must be a plain completion and must not leave
  // a cooldown behind: the turn above already proves the key stayed usable, and
  // this pins the title feature itself to the local fixture.
  await until(`sidebar.sessions.some(s => s.id === ${JSON.stringify(id)} && s.title === '标题生成通过')`);
  assert.ok(titles.length >= 1, 'The first user message generates a background conversation title');
  assert.equal(titles[0].model, 'kimi-k2.5');
  assert.equal(await js(`sidebar.sessions.find(s => s.id === ${JSON.stringify(id)}).title`), '标题生成通过');
  await snapshot('kimi-chat');

  // Force a process restart immediately after completion. The last native turn
  // must be flushed before a successor opens it and before a fork is made.
  await js("chatApi.saveSettings({ permissionMode: 'yolo' })");
  await send('UI resume 保留上一轮的文件操作记录。');
  await until("document.querySelectorAll('.run-result.ok').length === 2");
  assert.equal(await js('context.sessionId'), id);
  assert.match(JSON.stringify(requests.at(-1).messages), /UI write/);
  await js('sidebar.load()');
  await js(`forkSession(sidebar.sessions.find(s => s.id === ${JSON.stringify(id)}))`);
  await send('UI fork 从最新一轮分叉。');
  await until("document.querySelector('.run-result.ok')");
  assert.notEqual(await js('context.sessionId'), id);
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('UI resume'));
  assert.deepEqual(errors, []);
  console.log('PASS: actual Electron -> Kimi ACP -> router, streamed tools and text, permission click, files in chosen workspace, setting-change resume and latest-turn fork. DOM snapshots saved.');
  fixture.closeAllConnections(); fixture.close();
  app.quit();
}
main().catch(error => { console.error(error); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
