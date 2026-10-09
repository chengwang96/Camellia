'use strict';

// Local runtime integration by default. --online <existing-user-data> explicitly
// uses one configured ChatGPT account for a few small real text requests. Only
// auth/account metadata are copied into a temporary app data directory; the
// original app settings and chat records are never modified.
// --runtime-root <app-data> selects installed binaries without using its accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { createCodex } = require('../src/engines/codex');
const { createAntigravity } = require('../src/engines/antigravity');
const { createDiscussionBoundary } = require('../src/engines/discussions/native-boundary');
const { DiscussionProduction } = require('../src/engines/discussions/production');
const { DiscussionService } = require('../src/engines/discussions/service');
const { apiAccountRef } = require('../src/engines/discussions/catalog');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { startApiRouter } = require('../src/api/api-router');
const { frame } = require('../src/api/api-protocol');
const { isolatedEnvironment } = require('../src/benchmark/engines');

async function main() {
  const online = process.argv.includes('--online'), source = online ? process.argv[process.argv.indexOf('--online') + 1] : null;
  const onlineApi = process.argv.includes('--online-api') ? process.argv[process.argv.indexOf('--online-api') + 1] : null;
  const engine = process.argv.includes('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : 'codex';
  const runtimeRoot = process.argv.includes('--runtime-root') ? process.argv[process.argv.indexOf('--runtime-root') + 1] : null;
  const toolCheck = process.argv.includes('--tools');
  const imageFile = process.argv.includes('--image') ? process.argv[process.argv.indexOf('--image') + 1] : null;
  assert.ok(['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(engine));
  if (process.argv.includes('--runtime-root')) assert.ok(runtimeRoot && path.isAbsolute(runtimeRoot), 'Pass the runtime installation root explicitly');
  if (onlineApi) assert.ok(path.isAbsolute(onlineApi));
  if (online) assert.ok(source && path.isAbsolute(source), 'Pass the existing app data directory explicitly');
  // macOS exposes the temporary directory through /var, a system symlink.
  // Use its real path before the native ownership inventory checks ancestors.
  const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'discussion-production-'));
  const runtime = createRuntimeManager({ root: path.resolve(__dirname, '..'), installRoot: runtimeRoot || path.resolve(__dirname, '..') });
  let router, server, service, production, boundary, remoteGateway, config = {}, requests = 0, holdVerification = false;
  const faults = [], logs = [];
  let approvals = 0;
  let profile;
  if (online && engine === 'codex') {
    fs.mkdirSync(path.join(dataDir, 'codex/subscription'), { recursive: true });
    for (const file of ['codex/account-state.json', 'codex/subscription/auth.json']) fs.copyFileSync(path.join(source, file), path.join(dataDir, file));
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'codex/account-state.json')));
    const model = process.env.DISCUSSION_SMOKE_MODEL || state.models[0].id;
    assert.ok(state.models.some(m => m.id === model));
    profile = { engine: 'codex', connection: 'subscription', model, accountRef: 'default', thinking: '', contextWindow: 262144 };
  } else if (online && ['antigravity', 'kimi'].includes(engine)) {
    const relative = engine === 'antigravity' ? 'antigravity/google-account.json' : 'kimi-subscription/account-state.json';
    const state = JSON.parse(fs.readFileSync(path.join(source, relative)));
    fs.mkdirSync(path.dirname(path.join(dataDir, relative)), { recursive: true });
    fs.copyFileSync(path.join(source, relative), path.join(dataDir, relative));
    if (engine === 'kimi') for (const file of ['config.toml', 'credentials/kimi-code.json']) {
      fs.mkdirSync(path.dirname(path.join(dataDir, 'kimi-subscription', file)), { recursive: true });
      fs.copyFileSync(path.join(source, 'kimi-subscription', file), path.join(dataDir, 'kimi-subscription', file));
    }
    const models = engine === 'antigravity' ? require('../src/engines/antigravity/subscription').groupModels(state.models) : state.models;
    const model = process.env.DISCUSSION_SMOKE_MODEL || models[0].id;
    assert.ok(models.some(row => row.id === model));
    const nativeModel = engine === 'kimi' ? require('../src/engines/kimi-session').managedKimiConfig(path.join(dataDir, 'kimi-subscription')).models[model] : null;
    profile = { engine, connection: 'subscription', model, accountRef: 'default', thinking: '',
      contextWindow: models.find(row => row.id === model)?.contextWindow || nativeModel?.max_context_size || 262144 };
  } else {
    server = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests++;
      const text = JSON.stringify(body), code = /DISCUSSION_[a-f0-9]+/.exec(text)?.[0];
      if (code) assert.ok(!body.tools?.length);
      if (holdVerification && code) return;
      if (text.includes('HOLD_FOR_STOP')) return;
      const reply = code || (/VISIBLE_[A-Z0-9]+/.exec(text)?.[0]) || 'Local discussion reply';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: reply } }] }));
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } })); res.end(frame('[DONE]'));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    let providers = [{ id: 'local', name: 'Local model fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai',
      keys: [{ id: 'fixed-key', key: 'fixture-not-a-secret' }], models: [{ id: 'text-fixture', upstream: 'fixture' }] }];
    if (onlineApi) {
      const configured = normalizeConfig(JSON.parse(fs.readFileSync(onlineApi)));
      const selected = configured.providers.find(p => p.enabled && p.models.some(m => m.id === process.env.DISCUSSION_SMOKE_MODEL));
      assert.ok(selected, 'Set DISCUSSION_SMOKE_MODEL to a configured API model');
      const key = selected.keys.find(k => k.enabled); assert.ok(key);
      providers = [{ ...selected, keys: [key], models: selected.models.filter(m => m.id === process.env.DISCUSSION_SMOKE_MODEL) }];
    }
    const routerConfig = normalizeConfig({ port, providers });
    const file = path.join(dataDir, 'router.json'); writeConfig(file, routerConfig); router = startApiRouter({ configPath: file }); await router.ready;
    const provider = routerConfig.providers[0];
    profile = { engine, connection: 'api', model: provider.models[0].id, accountRef: apiAccountRef(provider, provider.models[0]), thinking: '', contextWindow: provider.models[0].contextWindow || 262144 };
  }
  console.log('Using installed runtime:', engine, runtime.locate(engine, profile.connection)?.version);
  const codex = createCodex({ dataDir, loadConfig: () => config, saveConfig: patch => Object.assign(config, patch), getModels: () => [profile.model],
    getRoute: () => ({ baseUrl: router?.url }), runtimes: () => runtime, onEvent: event => boundary?.registry.capture('codex', event), onGoal() {}, log: line => logs.push(line) });
  const antigravity = createAntigravity({ dataDir, cliSettingsFile: path.join(dataDir, 'google/settings.json'), node: () => process.execPath,
    environment: () => isolatedEnvironment(path.join(dataDir, 'ordinary-profile'), process.execPath),
    loadConfig: () => config, saveConfig: patch => Object.assign(config, patch), getModels: () => [profile.model], getRoute: () => ({ baseUrl: router?.url }),
    runtimes: () => runtime, onEvent: event => boundary?.registry.capture('antigravity', event), onGoal() {}, log: line => logs.push(line) });
  try {
    boundary = createDiscussionBoundary({ dataDir, drivers: { codex, antigravity }, conversations: () => [], managedNative: () => production.inventory(), nativeStorage: () => production.nativeStorage(), ordinaryNativeSeparate: input => production.ordinaryStorageSeparate(input) });
    const getCatalog = () => [{ binding: profile, label: profile.model, accountLabel: 'Selected verification account' }];
    production = new DiscussionProduction({ dataDir, registry: boundary.registry, codex, antigravity, runtimes: () => runtime, getRouter: () => router, getCatalog,
      getNativeConfig: engine => engine === 'antigravity' && online && toolCheck ? { config: { permissions: { ask: ['write_file(*)'] } } } : {},
      log: line => logs.push(line) });
    service = new DiscussionService({ dataDir, registry: boundary.registry, production, getCatalog, onError: error => faults.push(error.message) });
    if (process.argv.includes('--remote')) {
      const { RemoteDiscussions } = require('../src/main/remote/discussions');
      const { RemoteAccess } = require('../src/main/remote/access');
      const { RemoteGateway } = require('../src/main/remote/gateway');
      const access = new RemoteAccess({ file: path.join(dataDir, 'remote-devices.json') });
      const invite = access.invite([], { allWorkspaces: true }), pending = access.request({ code: invite.code, name: 'Native integration fixture' });
      access.approve(pending.id); const credential = access.claim(pending.id, pending.claim);
      const nativeCall = service.call.bind(service), backend = Object.create(service); backend.call = nativeCall;
      const remote = new RemoteDiscussions({ file: path.join(dataDir, 'remote-receipts.json'), getService: () => backend, access });
      remoteGateway = new RemoteGateway({ access, reader: { manager: {}, workspaces: () => [] }, discussions: remote, validateHost: host => host === '127.0.0.1' });
      await remoteGateway.start('127.0.0.1', 0);
      async function request(route, value) {
        const response = await fetch(remoteGateway.url + route, { method: value ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + credential.token, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
        assert.equal(response.status, 200); return response.json();
      }
      service.call = async (action, payload = {}) => {
        if (!['create', 'add-member', 'send', 'stop', 'permission-response'].includes(action)) return nativeCall(action, payload);
        const { id, requestId, ...parameters } = payload;
        if (action === 'send' && parameters.attachments?.length) parameters.attachments = parameters.attachments.map(file => ({ name: file.name, isImage: file.isImage, data: fs.readFileSync(file.path).toString('base64') }));
        if (action === 'permission-response') {
          const snapshot = await request('/v1/discussions/' + id);
          const permission = snapshot.group.pendingApprovals.find(p => p.requestId === requestId && p.deliveryId === parameters.deliveryId);
          assert.ok(permission); parameters.approvalId = requestId; parameters.fingerprint = permission.fingerprint;
        }
        const commandId = action === 'send' ? requestId : randomUUID();
        let receipt = await request('/v1/discussions/commands', { requestId: commandId, instanceId: remoteGateway.instanceId, action, ...(id ? { id } : {}), parameters });
        const started = Date.now();
        while (receipt.state === 'pending') {
          if (Date.now() - started > 180000) throw new Error('Remote native command timed out');
          await new Promise(resolve => setTimeout(resolve, 200)); receipt = await request('/v1/discussions/commands/' + commandId);
        }
        assert.equal(receipt.state, 'completed', receipt.error);
        return request('/v1/discussions/' + receipt.groupId);
      };
      console.log('Using authenticated remote HTTP commands, uploaded attachment bytes, and fingerprinted approval responses');
    }
    const catalog = (await service.call('catalog')).bindings;
    assert.equal(catalog[0].capability.available, false);
    if (!online && !onlineApi) {
      holdVerification = true;
      let verificationError;
      const cancelled = service.call('verify-binding', { bindingId: catalog[0].id }); cancelled.catch(error => { verificationError = error; });
      const started = Date.now();
      while (!requests) { if (verificationError) throw verificationError; if (Date.now() - started > 30000) throw new Error('Verification did not reach the local model'); await new Promise(resolve => setTimeout(resolve, 100)); }
      await service.call('cancel-verification', { bindingId: catalog[0].id });
      await assert.rejects(cancelled);
      assert.equal(production.checks.size, 0); assert.equal(production.activities.size, 0);
      assert.equal((await service.call('catalog')).bindings[0].capability.available, false);
      holdVerification = false;
      console.log('PASS cancellation during real native verification: drained, no binding admitted');
    }
    console.log('Testing verification immediately after adding members:', profile.engine, profile.connection, profile.model);
    const group = (await service.call('create', { title: 'Production connection verification' })).group;
    const requestsBeforeAdd = requests;
    const added = await service.call('add-member', { id: group.id, name: 'First', bindingId: catalog[0].id });
    assert.equal(added.group.participants[0].verifying, true);
    await service.call('add-member', { id: group.id, name: 'Second', bindingId: catalog[0].id });
    const verificationStart = Date.now();
    while (service.memberChecks.size) {
      if (Date.now() - verificationStart > 180000) throw new Error('Automatic member verification did not finish');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const verified = (await service.call('load', { id: group.id })).group;
    assert.ok(verified.participants.every(p => p.capability.available && !p.verifying && !p.verificationError), JSON.stringify(verified.participants));
    assert.deepEqual(verified.messages, []);
    if (!online && !onlineApi) assert.equal(requests - requestsBeforeAdd, 2, 'same-connection additions share a single two-turn verification');
    console.log('PASS new members: real two-turn verification completes before any send, shared connection checked once, public history empty');
    const members = service.manager.get(group.id).participants;
    // Older beta groups persisted no context metadata. They must still send
    // through the matching current model/account without being re-created.
    service.manager.configureMember(group.id, members[0].id, { contextWindow: 0 });
    async function send(text, participantIds, mode = 'parallel', attachments = []) {
      const result = await service.call('send', { id: group.id, requestId: randomUUID(), text, participantIds, mode, attachments });
      const started = Date.now();
      while (service.scheduler.runs.size || service.manager.get(group.id).deliveries.some(d => ['queued', 'preparing', 'running', 'stopping'].includes(d.status))) {
        if (toolCheck) for (const permission of service.scheduler.permissions(group.id)) {
          approvals++;
          const option = permission.options?.find(row => row.kind === 'allow_once');
          await service.call('permission-response', { id: group.id, deliveryId: permission.deliveryId, runId: permission.runId,
            requestId: permission.requestId, allow: true, ...(option ? { optionId: option.optionId } : {}) });
        }
        if (Date.now() - started > 90000) throw new Error('Discussion delivery timed out: ' + faults.join('; '));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const state = service.manager.get(group.id);
      const latest = state.deliveries.filter(d => d.requestId === result.group.requests.at(-1).id);
      assert.ok(latest.every(d => d.status === 'completed'), JSON.stringify(latest.map(d => ({ status: d.status, reason: d.failureReason, unavailable: d.unavailableReason }))) + faults.join('; '));
      return state;
    }
    if (imageFile) {
      assert.ok(online || onlineApi, 'Image smoke requires an explicitly selected real connection');
      const { attachments } = await service.call('import-attachments', { id: group.id, paths: [imageFile] });
      const result = await send('Read the large code in the attached image. Reply only with the code. Do not call tools.', [members[0].id], 'parallel', attachments);
      assert.match(result.messages.at(-1).text, /CAMELLIA\s+VISION\s+47/i);
      assert.equal(result.deliveries.at(-1).tools?.length || 0, 0);
      console.log(JSON.stringify({ result: 'PASS native image input recognized code from pixels without tools', engine, connection: profile.connection, model: profile.model, dataDir, faults }));
      return;
    }
    if (toolCheck) {
      assert.ok(online || onlineApi, 'Tool smoke requires an explicitly selected real connection');
      const inputFile = path.join(dataDir, 'source.txt'); fs.writeFileSync(inputFile, 'TOOL_INPUT_A7');
      const { attachments } = await service.call('import-attachments', { id: group.id, paths: [inputFile] });
      fs.unlinkSync(inputFile);
      const instruction = 'Use native tools to read the attached text file at ' + attachments[0].path
        + '. Then create discussion-result.txt in your current working directory with exactly TOOL_RESULT_A7. Read it back. Reply briefly with the input code and a Markdown link to the created file. This is an authorized test in a disposable directory.';
      const first = await send(instruction, [members[0].id], 'parallel', attachments);
      assert.equal(fs.readFileSync(path.join(first.cwd, 'discussion-result.txt'), 'utf8').trim(), 'TOOL_RESULT_A7');
      assert.match(first.messages.at(-1).text, /TOOL_INPUT_A7/);
      assert.ok(first.deliveries.at(-1).tools?.some(tool => tool.status === 'completed'), 'Actual tool results must be saved');
      const second = await send('Use native file tools to read discussion-result.txt created by the previous member. Reply only with its exact contents.', [members[1].id]);
      assert.match(second.messages.at(-1).text, /TOOL_RESULT_A7/);
      assert.ok(second.deliveries.at(-1).tools?.some(tool => tool.status === 'completed'));
      assert.equal(service.scheduler.runs.size, 0);
      if (engine === 'antigravity' && online) assert.ok(approvals > 0, 'The native write must pass through a real pending group approval');
      console.log(JSON.stringify({ result: 'PASS real native tools, permission routing, created artifact, second member reads file, and drained processes', engine,
        model: profile.model, dataDir, approvals, toolCount: second.deliveries.reduce((n, d) => n + (d.tools?.length || 0), 0), faults }));
      return;
    }
    const first = await send('Remember VISIBLE_A7 for this discussion. Reply only VISIBLE_A7.', members.map(p => p.id), 'serial');
    assert.equal((await service.call('catalog')).bindings[0].capability.available, true);
    assert.equal(first.participants[0].contextWindow, profile.contextWindow);
    console.log('PASS first send: verified connection reused, old member metadata repaired, real answer saved');
    assert.notEqual(first.participants[0].session.nativeId, first.participants[1].session.nativeId);
    const ordinaryHistory = engine === 'codex' ? codex.history : engine === 'antigravity' ? antigravity.history : null;
    for (const member of first.participants) if (ordinaryHistory) assert.ok(!ordinaryHistory.find(member.session.nativeId), 'group transcripts must not enter ordinary history');
    const second = await send('Repeat the VISIBLE code from my preceding message, with no other text.', [members[0].id]);
    assert.match(second.messages.at(-1).text, /VISIBLE_A7/);
    console.log('PASS coordinator: independent members, serial replies, native continuation and saved public answers');
    if (!online && !onlineApi) {
      await send('Reply briefly to the whole group in parallel.', members.map(p => p.id));
      console.log('PASS real native parallel dispatch with independent member storage');
    }
    const count = requests;
    await service.call('send', { id: group.id, requestId: randomUUID(), text: online || onlineApi ? 'Write a very long numbered list of the integers from 1 to 3000, one number per line.' : 'HOLD_FOR_STOP', participantIds: [members[0].id] });
    const start = Date.now();
    while (!service.manager.get(group.id).deliveries.some(d => d.status === 'running') || !online && !onlineApi && requests === count) {
      if (Date.now() - start > 30000) throw new Error('Stop test did not reach the model');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (engine === 'antigravity' && !onlineApi) {
      // A RUNNING group must not block ordinary SDK resume.
      const cwd = path.join(dataDir, 'ordinary-work'); fs.mkdirSync(cwd);
      let ordinaryId;
      const opts = { conversationId: randomUUID(), cwd, settings: { connection: profile.connection, model: profile.model, permissionMode: 'default' } };
      for (let attempt = 0; attempt < 2; attempt++) {
        const session = antigravity.ensureSession({ ...opts, sessionId: ordinaryId });
        await (session.ready = session.open()); await session.prepareNativeStorage();
        if (ordinaryId) assert.equal(session.sessionId, ordinaryId); ordinaryId = session.sessionId;
        await antigravity.sessions.release(opts);
      }
      assert.equal(production.ordinaryStorageSeparate({ nativeId: ordinaryId, owners: [{ nativeStorage: {
        connection: profile.connection, storageDir: antigravity.nativeStorageDirectory(ordinaryId), conversationId: '0'.repeat(32) } }] }), false);
      console.log('PASS ordinary Antigravity continuation remains separate; a shared storage path is refused');
    }
    await service.call('stop', { id: group.id, participantId: members[0].id });
    assert.equal(service.scheduler.runs.size, 0); assert.equal(codex.sessions.sessions.size, 0);
    assert.equal(antigravity.sessions.sessions.size, 0);
    assert.ok(!service.manager.get(group.id).deliveries.some(d => ['preparing', 'running', 'stopping'].includes(d.status)));
    console.log('PASS stop: native processes drained, native pool released, terminal state saved');
    console.log(JSON.stringify({ online: online || Boolean(onlineApi), engine, model: profile.model, dataDir, messages: second.messages.length, localRequests: requests, faults }));
  } catch (error) { error.message += '\nTest data: ' + dataDir + '\n' + logs.slice(-15).join('\n'); throw error;
  } finally {
    await remoteGateway?.stop();
    await service?.shutdown(); await codex.shutdown(); await antigravity.shutdown(); await router?.stop();
    if (online) fs.rmSync(path.join(dataDir, 'codex/subscription/auth.json'), { force: true });
    if (online && engine === 'kimi') fs.rmSync(path.join(dataDir, 'kimi-subscription/credentials/kimi-code.json'), { force: true });
    if (online && engine === 'antigravity') fs.rmSync(path.join(dataDir, 'antigravity/google-account.json'), { force: true });
    if (onlineApi) fs.rmSync(path.join(dataDir, 'router.json'), { force: true });
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
