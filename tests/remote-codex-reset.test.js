'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RemoteAccess } = require('../src/main/remote/access');
const { RemoteReadModel } = require('../src/main/remote/read-model');
const { RemoteCommands } = require('../src/main/remote/commands');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');
const { createResetCredits } = require('../src/engines/codex-reset-credits');
const { removeTree } = require('./test-fs.cjs');
const { BAD_PORTS } = require('./bad-ports.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-remote-reset-'));
  let config = { sharedMeta: { workspaces: [{ id: 'workspace', name: 'Work', path: root }] } };
  const f = { count: 2, charges: 0, calls: [], now: Date.now(), account: 'owner@example.test' };
  const providerRequests = new Map();
  const client = { request: async (method, params) => {
    f.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', email: f.account, planType: 'pro' } };
    if (method === 'account/rateLimits/read') {
      if (f.onRead) await f.onRead();
      if (f.failRead) throw new Error('Network error with private desktop path ' + root);
      return { accountId: f.account, rateLimits: { primary: { usedPercent: f.count === 2 ? 100 : 0 } },
        rateLimitResetCredits: f.unsupported ? null : { availableCount: f.count, credits: f.noDetails ? null : [
          { id: 'later', resetType: 'codexRateLimits', status: 'available', expiresAt: Math.floor(f.now / 1000) + 900 },
          { id: 'first', resetType: 'codexRateLimits', status: 'available', expiresAt: Math.floor(f.now / 1000) + 600 }] } };
    }
    assert.equal(method, 'account/rateLimitResetCredit/consume');
    if (!providerRequests.has(params.idempotencyKey)) {
      f.count--; f.charges++;
      providerRequests.set(params.idempotencyKey, { outcome: 'reset' });
    }
    if (f.loseReply) throw new Error('Connection closed after sending');
    return providerRequests.get(params.idempotencyKey);
  } };
  f.restartService = () => {
    f.service = createResetCredits({ file: path.join(root, 'reset.json'), getClient: async () => client,
      publish: patch => { f.lastQuota = patch; }, now: () => f.now });
  };
  f.restartService();
  f.selected = { connection: 'subscription', model: 'test', subscriptionId: 'owner' };
  const drivers = Object.fromEntries(ENGINES.map(engine => [engine, { settings: () => f.selected, ensure() { throw new Error('Reset must not start a conversation'); } }]));
  drivers.codex.subscriptionAccounts = () => ({ activeId: 'preferred', accounts: [
    { id: 'owner', signedIn: true, exhausted: true }, { id: 'preferred', signedIn: true }, { id: 'other', signedIn: true }] });
  drivers.codex.resetCredits = {
    preview: async ({ id }) => {
      f.previewAccount = id;
      return { ok: true, home: root, accounts: [{ secret: 'must-not-leak' }], preview: await f.service.preview() };
    },
    consume: async payload => {
      f.consumeAccount = payload.id;
      return { ok: true, home: root, ...await f.service.consume(payload) };
    },
  };
  f.manager = new SharedConversations({ dir: path.join(root, 'conversations'), loadConfig: () => config,
    saveConfig: patch => { config = { ...config, ...patch }; }, drivers });
  f.visible = f.manager.create('codex', 'workspace', 'Remote test');
  f.access = new RemoteAccess({ file: path.join(root, 'devices.json') });
  const invitation = f.access.invite(['workspace'], { allWorkspaces: true, includeUnassigned: true });
  const pending = f.access.request({ code: invitation.code, name: 'Phone' });
  f.access.approve(pending.id);
  f.credentials = f.access.claim(pending.id, pending.claim);
  f.device = f.access.authenticate(f.credentials.token);
  f.reader = new RemoteReadModel(f.manager);
  f.commands = new RemoteCommands({ file: path.join(root, 'commands.json'), access: f.access, reader: f.reader });
  f.gateway = new RemoteGateway({ access: f.access, reader: f.reader, commands: f.commands, validateHost: host => host === '127.0.0.1' });
  f.gateway.instanceId = randomUUID();
  f.payload = (action, values = {}) => ({ action, requestId: randomUUID(), instanceId: f.gateway.instanceId, ...values });
  f.run = payload => f.commands.execute(f.device, f.visible.id, payload, f.gateway.instanceId);
  f.preview = async () => (await f.run(f.payload('codex-reset-preview'))).resetPreview;
  f.consume = (preview, values = {}) => f.payload('codex-reset-consume', { accountId: preview.accountId,
    confirmationToken: preview.confirmationToken, confirmed: true, ...values });
  t.after(async () => {
    await f.gateway.stop(); f.manager.closeGoalTools(); f.manager.pauseGoals();
    assert.equal(path.dirname(root), os.tmpdir()); removeTree(root);
  });
  return f;
}

test('gateway advertises reset credits only for full control with a supporting desktop', async t => {
  const f = fixture(t);
  assert.ok(f.gateway.connectionInfo(f.device).capabilities.includes('codex-reset-credits'));
  assert.ok(!f.gateway.connectionInfo({ ...f.device, permission: 'read' }).capabilities.includes('codex-reset-credits'));
  assert.ok(!f.gateway.connectionInfo({ ...f.device, allWorkspaces: false }).capabilities.includes('codex-reset-credits'));
  delete f.manager.drivers.codex.resetCredits;
  assert.ok(!f.gateway.connectionInfo(f.device).capabilities.includes('codex-reset-credits'));
  assert.equal((await f.run(f.payload('codex-reset-preview'))).ok, false);
});

test('phone preview reads its bound exhausted account without starting a turn or exposing native paths', async t => {
  const f = fixture(t), preview = await f.preview();
  assert.equal(f.previewAccount, 'owner');
  assert.equal(preview.account.email, 'owner@example.test');
  assert.equal(preview.credits.availableCount, 2);
  assert.equal(preview.creditId, 'first');
  assert.equal(f.charges, 0);
  assert.equal(f.manager.busy(f.visible.id), false);
  const record = JSON.stringify(f.commands.entries);
  assert.ok(!record.includes(f.manager.dir));
  assert.ok(!record.includes('must-not-leak'));
  assert.equal(f.manager.drivers.codex.subscriptionAccounts().activeId, 'preferred');
});

test('HTTP reset requires confirmation and duplicate deliveries cannot spend another credit', async t => {
  const f = fixture(t);
  for (;;) {
    await f.gateway.start('127.0.0.1', 0);
    if (!BAD_PORTS.has(f.gateway.server.address().port)) break;
    await f.gateway.stop();
  }
  const send = async payload => {
    const response = await fetch(f.gateway.url + `/v1/conversations/${f.visible.id}/commands`, {
      method: 'POST', headers: { Authorization: `Bearer ${f.credentials.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, ...await response.json() };
  };
  const { resetPreview: preview } = await send(f.payload('codex-reset-preview'));
  assert.equal((await send(f.consume(preview, { confirmed: false }))).ok, false);
  assert.equal((await send(f.consume(preview, { accountId: 'preferred' }))).ok, false);
  assert.equal(f.charges, 0);
  const consume = f.consume(preview);
  const first = await send(consume), duplicate = await send(consume);
  assert.equal(first.outcome, 'reset'); assert.equal(duplicate.outcome, 'reset');
  assert.equal(f.consumeAccount, 'owner'); assert.equal(f.charges, 1); assert.equal(f.count, 1);
  assert.equal((await send(f.consume(preview))).outcome, 'reset');
  assert.equal(f.charges, 1);
  assert.equal(f.calls.filter(call => call.method.endsWith('/consume')).length, 1);
  assert.equal(f.lastQuota.rateLimits.codex.primary.usedPercent, 0);
  assert.equal((await send({ ...consume, confirmed: false })).status, 409);
});

test('changed conversation, account identity, and expired confirmations cannot use a card', async t => {
  const f = fixture(t), preview = await f.preview();
  f.selected.subscriptionId = 'other';
  assert.equal((await f.run(f.consume(preview))).ok, false);
  f.selected.subscriptionId = 'owner'; f.account = 'replacement@example.test';
  assert.equal((await f.run(f.consume(preview))).ok, false);
  f.account = 'owner@example.test'; const fresh = await f.preview();
  f.now += 5 * 60_000 + 1;
  assert.equal((await f.run(f.consume(fresh))).ok, false);
  f.visible.engineSettings.codex.connection = 'api';
  assert.equal((await f.run(f.payload('codex-reset-preview'))).ok, false);
  f.visible.engineSettings.codex.connection = 'subscription'; f.visible.currentEngine = 'kimi';
  assert.equal((await f.run(f.consume(fresh))).ok, false);
  assert.equal(f.charges, 0);
});

test('lost consume replies recover the same provider request after reopening and desktop restart', async t => {
  const f = fixture(t), preview = await f.preview();
  f.loseReply = true;
  const lost = await f.run(f.consume(preview));
  assert.equal(lost.ok, false); assert.match(lost.error, /same request/); assert.equal(f.charges, 1);
  f.restartService(); f.loseReply = false;
  const retry = await f.preview();
  assert.equal(retry.retry, true); assert.equal(retry.confirmationToken, preview.confirmationToken);
  assert.equal((await f.run(f.consume(retry))).outcome, 'reset');
  assert.equal(f.charges, 1);
  const calls = f.calls.filter(call => call.method.endsWith('/consume'));
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].params, calls[1].params);
});

test('restricted or revoked devices cannot preview, consume, or read previous reset receipts', async t => {
  const f = fixture(t), previewPayload = f.payload('codex-reset-preview');
  await f.run(previewPayload);
  f.access.setScope(f.device.id, ['workspace'], { allWorkspaces: false });
  await assert.rejects(f.run(f.payload('codex-reset-preview')), /Full-device/);
  assert.throws(() => f.commands.receipt(f.device, previewPayload.requestId), /Full-device/);
  f.access.revoke(f.device.id);
  await assert.rejects(f.run(f.payload('codex-reset-preview')), /Control permission/);
  assert.equal(f.charges, 0);
});

test('a crash before saving a remote receipt reconciles the original token without using a second card', async t => {
  for (const ambiguous of [false, true]) await t.test(ambiguous ? 'lost provider reply' : 'known provider result', async t => {
    const f = fixture(t), preview = await f.preview(), original = f.consume(preview);
    f.loseReply = ambiguous;
    await f.run(original);
    const entry = f.commands.entries.find(entry => entry.key.endsWith(original.requestId));
    delete entry.result; f.commands.save();
    f.restartService(); f.loseReply = false;
    f.commands = new RemoteCommands({ file: f.commands.file, access: f.access, reader: f.reader });
    assert.throws(() => f.commands.receipt(f.device, original.requestId), error => error.status === 404);
    f.gateway.instanceId = randomUUID();
    assert.equal((await f.run(original)).outcome, 'reset', 'previous-instance commands recover only with the original fingerprint');
    assert.equal(f.charges, 1);
    assert.equal(f.calls.filter(call => call.method.endsWith('/consume')).length, ambiguous ? 2 : 1);
  });
});

test('revocation or account switch during the native identity check prevents consumption', async t => {
  for (const change of ['revoke', 'account']) await t.test(change, async t => {
    const f = fixture(t), preview = await f.preview();
    f.onRead = async () => {
      f.onRead = null;
      if (change === 'revoke') f.access.revoke(f.device.id);
      else f.selected.subscriptionId = 'other';
    };
    assert.equal((await f.run(f.consume(preview))).ok, false);
    assert.equal(f.charges, 0);
    assert.equal(f.calls.filter(call => call.method.endsWith('/consume')).length, 0);
  });
});

test('unknown and empty credit data stay unavailable while count-only responses can reset', async t => {
  const f = fixture(t);
  f.unsupported = true; assert.equal((await f.preview()).confirmationToken, null);
  f.unsupported = false; f.count = 0; assert.equal((await f.preview()).confirmationToken, null);
  f.count = 2; f.noDetails = true;
  const preview = await f.preview();
  assert.equal(preview.credits.credits, null); assert.ok(preview.confirmationToken);
  assert.equal((await f.run(f.consume(preview))).outcome, 'reset');
  assert.ok(!Object.hasOwn(f.calls.find(call => call.method.endsWith('/consume')).params, 'creditId'));
  f.failRead = true;
  const failure = await f.run(f.payload('codex-reset-preview'));
  assert.equal(failure.ok, false); assert.ok(!failure.error.includes(f.manager.dir));
});
