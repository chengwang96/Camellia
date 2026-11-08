'use strict';

// Installed harness -> production attachment transport -> shared router ->
// loopback model. No subscription credentials or paid inference are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { isolatedEnvironment } = require('../src/engines/isolated-environment');
const { AcpSession } = require('../src/engines/acp-session');
const { DshSession, dshAcpSpec } = require('../src/engines/dsh-session');
const { KimiSession, kimiSpawnSpec } = require('../src/engines/kimi-session');
const { GrokSession, grokSpawnSpec } = require('../src/engines/grok-session');
const { ClaudeSession } = require('../src/engines/claude-session');
const { CodexSession } = require('../src/engines/codex-session');
const { codexSpawnSpec } = require('../src/engines/codex-client');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { antigravitySpawnSpec } = require('../src/engines/antigravity');
const { claudeSpec, stopProcess } = require('./native-engine-harness.cjs');
const { removeTree } = require('./test-fs.cjs');

const ENGINES = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'grok'];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

async function main() {
  const engines = process.argv.slice(2).length ? process.argv.slice(2) : ENGINES;
  assert.ok(engines.every(engine => ENGINES.includes(engine)), 'Unknown harness');
  const appRoot = path.resolve(__dirname, '..');
  const runtimes = createRuntimeManager({ root: appRoot, installRoot: appRoot, node: () => process.execPath });
  const dsh = runtimes.locate('dsh');
  assert.ok(dsh, 'Install the pinned DSH runtime for the image codec fixture');
  const attachmentRequire = createRequire(createRequire(dsh.file).resolve('@deepseek-ai/dsh-attachment-local'));
  const sharp = attachmentRequire('sharp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-native-images-'));
  const images = [];
  for (const format of ['png', 'jpeg', 'webp', 'gif']) {
    const file = path.join(root, 'reference with spaces.' + format);
    await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 40, g: 120, b: 200 } } })
      .toFormat(format).toFile(file);
    images.push({ path: file, isImage: true });
  }
  const requests = [], serverErrors = [];
  const server = http.createServer(async (req, res) => {
    if (require('./model-metadata-fixture.cjs')(req, res)) return;
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const title = body.tools?.length === 1 && body.tools[0].function?.name === 'session_title';
      const parts = body.messages.filter(message => message.role === 'user').flatMap(message => Array.isArray(message.content) ? message.content : []);
      const media = parts.filter(part => part.type === 'image_url');
      for (const part of media) {
        const url = part.image_url?.url || part.image_url;
        const match = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(url);
        assert.ok(match, 'The upstream must receive inline image bytes, not a local path');
        const { data, info } = await sharp(Buffer.from(match[2], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        // Some native harnesses resize small inputs before serialization.
        assert.ok(info.width > 0 && info.height > 0);
        assert.ok(Math.abs(info.width / info.height - 64 / 48) < 0.02, 'Image aspect ratio changed in transport');
        for (let channel = 0; channel < 3; channel++)
          assert.ok(Math.abs(data[channel] - [40, 120, 200][channel]) <= 8, 'Image pixels changed in transport');
      }
      requests.push({ model: body.model, count: media.length, title,
        text: body.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content
          : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n') });
      const message = title ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'image-title', type: 'function',
        function: { name: 'session_title', arguments: JSON.stringify({ session_title: 'Image fixture' }) } }] }
        : { role: 'assistant', content: 'IMAGE_TRANSPORT_OK' };
      const finish_reason = title ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(frame({ id: 'image-fixture', model: body.model, choices: [{ index: 0, delta: message }] }));
        res.write(frame({ id: 'image-fixture', choices: [{ index: 0, delta: {}, finish_reason }], usage }));
        res.end(frame('[DONE]'));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'image-fixture', model: body.model, choices: [{ index: 0, message, finish_reason }], usage }));
      }
    } catch (error) {
      serverErrors.push(error.stack);
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message }));
    }
  });
  let router;
  try {
    await listen(server);
    const reservation = http.createServer(); await listen(reservation);
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const configPath = path.join(root, 'router.json');
    writeConfig(configPath, normalizeConfig({ port, providers: [{ id: 'fixture', type: 'custom',
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', protocol: 'openai',
      models: engines.map(engine => ({ id: 'image-' + engine, upstream: 'image-' + engine })),
      keys: [{ id: 'local', key: 'loopback-only' }] }] }));
    router = startApiRouter({ configPath }); await router.ready;
    const route = { baseUrl: router.url, authToken: 'proxy-managed' };
    const failures = [];
    for (const engine of engines) {
      let session, proc, complete, generation = 0;
      const logs = [], runtime = runtimes.locate(engine, 'api');
      const home = path.join(root, engine), cwd = path.join(home, 'Project With Spaces');
      fs.mkdirSync(cwd, { recursive: true });
      const env = isolatedEnvironment(home, process.execPath);
      const history = new ClaudeHistory(path.join(home, 'history'));
      const settings = { cwd, model: 'image-' + engine, connection: 'api', permissionMode: 'full' };
      const stop = async () => {
        await session?.shutdown?.(); session?.kill();
        await stopProcess(proc); proc = null;
      };
      const create = async (opts = {}, { standardAcp = false } = {}) => {
        assert.ok(runtime, engine + ' runtime missing');
        const common = { runtime, home: path.join(home, 'native'), cwd, model: settings.model, route, env, permissionMode: 'full' };
        const spec = engine === 'claude' ? claudeSpec(common) : engine === 'codex' ? codexSpawnSpec({ ...common, connection: 'api' })
          : engine === 'dsh' ? dshAcpSpec(common) : engine === 'kimi' ? kimiSpawnSpec({ ...common, runtime: runtime.file })
          : engine === 'grok' ? grokSpawnSpec({ ...common, runtime: runtime.file }) : antigravitySpawnSpec(common);
        if (standardAcp) {
          const index = spec.args.findIndex(arg => path.basename(arg) === 'camellia-history.patch.yml');
          assert.ok(index > 0);
          spec.args.splice(index - 1, 2); spec.nativeHistory = false;
        }
        if (engine === 'claude' && opts.sessionId) spec.args.push('--resume', opts.sessionId);
        const Session = { claude: ClaudeSession, codex: CodexSession, dsh: DshSession, kimi: KimiSession, grok: GrokSession }[engine] || AcpSession;
        session = new Session({ name: engine, gen: ++generation, settings, opts, spec,
          exe: ['dsh', 'kimi'].includes(engine) ? process.execPath : runtime.file,
          spawn: (exe, args, options) => (proc = spawn(exe, args, options)),
          history, log: message => logs.push(message), onSessionId() {}, onEvent() {}, onResult: result => complete?.(result) });
        session.start();
      };
      const turn = (prompt, attachments = []) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { session.kill(); reject(new Error(engine + ' image turn timed out')); }, 90000);
        complete = result => { clearTimeout(timer); resolve(result); };
        try { assert.equal(session.sendUserMessage(prompt, attachments), true); }
        catch (error) { clearTimeout(timer); reject(error); }
      });
      const success = result => {
        assert.equal(result.subtype, 'success', JSON.stringify(result) + '\n' + logs.slice(-5).join('\n'));
        assert.match(result.result, /IMAGE_TRANSPORT_OK/);
      };
      const latest = () => requests.findLast(request => request.model === settings.model && !request.title);
      try {
        await create();
        // The SDK's native Image primitive accepts PNG/JPEG/WebP, not GIF.
        const supported = engine === 'antigravity' ? images.slice(0, 3) : images;
        success(await turn('IMAGE_FIRST: inspect these references', supported));
        assert.equal(latest().count, supported.length, 'Every image must reach upstream');
        success(await turn('IMAGE_FOLLOWUP: retain the reference images'));
        assert.equal(latest().count, supported.length, 'Follow-up history must retain images');
        const sourceId = session.sessionId;
        await stop(); await create({ sessionId: sourceId });
        success(await turn('IMAGE_RESUME: use the same references'));
        assert.equal(session.sessionId, sourceId);
        assert.equal(latest().count, supported.length, 'Native resume must retain image bytes');
        success(await turn('', [images[0]]));
        assert.equal(latest().count, supported.length + 1, 'Image-only input must reach upstream');
        if (engine === 'dsh') {
          await stop(); await create({}, { standardAcp: true });
          success(await turn('IMAGE_STANDARD_ACP: no history extension', [images[0]]));
          assert.equal(latest().count, 1, 'Unmodified ACP must initialize against the selected image route');
        }
        console.log('PASS: ' + engine + ' images=' + supported.length + ', follow-up, native resume, image-only; upstream pixels verified');
      } catch (error) {
        failures.push(engine + ': ' + error.message);
        console.error('FAIL: ' + failures.at(-1));
      } finally { await stop(); }
    }
    assert.deepEqual(serverErrors, [], 'Upstream image validation errors');
    assert.deepEqual(failures, [], 'Native image integration failures');
  } finally {
    await router?.stop(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('camellia-native-images-'));
    removeTree(root);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
