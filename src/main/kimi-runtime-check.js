'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { frame } = require('../api/api-protocol');
const { KimiSession, kimiSpawnSpec } = require('../engines/kimi-session');
const { patchKimiRuntime } = require('../engines/kimi-steer');
const { nativeHistoryModule } = require('../engines/native-history-module');
const { kimiAcpFingerprint, kimiAcpVerificationFile } = require('../engines/kimi-native-history');

async function verifyKimiRuntime({ node, runtime, version }) {
  const metadata = JSON.parse(fs.readFileSync(path.resolve(path.dirname(runtime), '../package.json'), 'utf8'));
  if (metadata.name !== '@moonshot-ai/kimi-code' || metadata.version !== version)
    throw new Error('The downloaded package identity or version does not match.');
  const source = fs.readFileSync(runtime, 'utf8');
  const { patched, ...capabilities } = patchKimiRuntime(source);
  if (!capabilities.nativeHistory || !capabilities.nativeSteer || !capabilities.nativeBackgroundTasks)
    throw new Error('The Kimi ACP adapter could not be applied.');
  const file = nativeHistoryModule(runtime, patched);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-kimi-check-'));
  const answer = 'Camellia Kimi background check passed.';
  const release = path.join(cwd, 'release-bg.txt');
  let session, timer, releaseTimer, requestCount = 0;
  const result = Promise.withResolvers();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end('{"data":[]}');
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { messages } = JSON.parse(Buffer.concat(chunks));
      let tool;
      switch (++requestCount) {
        case 1:
          tool = { name: 'Bash', arguments: JSON.stringify({
            command: 'for ((i=0; i<150; ++i)); do [ ! -f release-bg.txt ] || exit 0; sleep 0.1; done; exit 1',
            description: 'Wait for the compatibility check', run_in_background: true,
          }) };
          break;
        case 2: {
          const taskId = JSON.stringify(messages).match(/task_id(?:\\?"|[^a-z])*([a-z]+-[a-z0-9]+)/i)?.[1];
          if (!taskId) throw new Error('The background tool did not return a task ID.');
          tool = { name: 'WaitFor', arguments: JSON.stringify({ task_id: taskId, timeout: 10 }) };
          releaseTimer = setTimeout(() => {
            try { fs.writeFileSync(release, 'release'); } catch (error) { result.reject(error); }
          }, 150);
          break;
        }
        default:
          if (!messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('task.completed')))
            throw new Error('The model did not receive the native task completion notification.');
      }
      const delta = tool
        ? { tool_calls: [{ index: 0, id: 'check-' + requestCount, type: 'function', function: tool }] }
        : { content: answer };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frame({ id: 'check', choices: [{ index: 0, delta: { role: 'assistant', ...delta } }] })
        + frame({ id: 'check', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })
        + frame('[DONE]'));
    } catch (error) {
      res.destroy();
      result.reject(error);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LANG|KIMI_GIT_BASH_PATH)$/i.test(key)));
    Object.assign(env, { HOME: cwd, USERPROFILE: cwd, APPDATA: cwd, LOCALAPPDATA: cwd,
      XDG_CONFIG_HOME: cwd, XDG_DATA_HOME: cwd, XDG_CACHE_HOME: cwd, NO_PROXY: '*' });
    const model = 'kimi-k2.5';
    const spec = kimiSpawnSpec({ home: path.join(cwd, 'home'), runtime, preparedRuntime: { file, ...capabilities }, model, env,
      route: { baseUrl: 'http://127.0.0.1:' + server.address().port, authToken: 'local-check' } });
    session = new KimiSession({ gen: 1, settings: { cwd, model, permissionMode: 'default' }, opts: {},
      exe: node, spawn, spec, history: { root: path.join(cwd, 'history') }, log() {}, onSessionId() {},
      onEvent(event) {
        if (event.type === 'gui:permission') session.answerPermission(event.requestId, true);
      },
      onResult: result.resolve });
    timer = setTimeout(() => result.reject(new Error('The local ACP check timed out.')), 30000);
    session.start();
    session.sendUserMessage('Verify that a background task can finish and deliver its reply.');
    const reply = await result.promise;
    if (reply.is_error) throw new Error('The local ACP check failed: ' + reply.result);
    if (reply.subtype !== 'success' || !reply.result?.includes(answer))
      throw new Error('The ACP turn ended before the background task delivered its reply.');
    fs.writeFileSync(kimiAcpVerificationFile(runtime), kimiAcpFingerprint(metadata, source));
  } finally {
    clearTimeout(timer);
    clearTimeout(releaseTimer);
    // Release the fixture command even if the candidate failed mid-turn.
    try { fs.writeFileSync(release, 'release'); } catch {}
    try { await session?.shutdown(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }
}

module.exports = { verifyKimiRuntime };
