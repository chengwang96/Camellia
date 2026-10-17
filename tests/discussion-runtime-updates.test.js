'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { DiscussionProduction } = require('../src/engines/discussions/production');
const { DiscussionService } = require('../src/engines/discussions/service');
const { DiscussionAdapterRegistry } = require('../src/engines/discussions/adapter-registry');
const { NativeSessionOwnership } = require('../src/engines/discussions/native-ownership');
const { removeTree } = require('./test-fs.cjs');

// Exercise production preparation, stream parsing, continuation and admission
// against a local pipe fixture. No installed account or model quota is used.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-update-'));
  t.after(() => removeTree(root));
  const binding = { engine: 'claude', connection: 'api', model: 'fixture', thinking: '', contextWindow: 32000,
    accountRef: JSON.stringify({ providerId: 'fixture', route: 'fixture' }) };
  const installed = { file: path.join(root, 'harness'), dir: root, version: '99.0.0-next.1' };
  fs.writeFileSync(installed.file, 'local pipe fixture');
  const native = new Map(), state = { starts: 0, stops: 0, routesClosed: 0, afterStop() {}, reply: code => code };
  const registry = new DiscussionAdapterRegistry({ ownership: new NativeSessionOwnership({ readOwners: () => [] }) });
  const production = new DiscussionProduction({ dataDir: root, registry, platform: 'win32',
    runtimes: () => ({ locate: engine => engine === 'claude' && !state.missing ? installed : null }),
    getCatalog: () => [{ binding }], getRouter: () => ({ createScope: () => ({ baseUrl: 'http://127.0.0.1:1',
      authToken: 'local-fixture', async close() { state.routesClosed++; } }) }) });
  production.jobs = { async prepare({ identity }) {
    return { spawn(_exe, args) {
      state.starts++;
      const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
      const proc = new EventEmitter();
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
      let closed = false;
      const close = () => { if (!closed) { closed = true; proc.emit('close', 0, null); } };
      proc.kill = close;
      proc.stdin = new Writable({ write(chunk, _encoding, done) {
        const message = JSON.parse(String(chunk));
        if (message.type === 'user') {
          const code = message.message.content[0].text.match(/DISCUSSION_[0-9a-f]+/)?.[0];
          if (code) native.set(id, code);
          queueMicrotask(() => proc.stdout.write(JSON.stringify({ type: 'result', subtype: 'success',
            session_id: id, result: state.reply(native.get(id)) }) + '\n'));
        }
        done();
      }, final(done) { done(); queueMicrotask(close); } });
      return proc;
    }, async stop() { state.stops++; state.afterStop(); return { ...identity, stopped: true }; } };
  } };
  const service = new DiscussionService({ dataDir: root, registry, production, platform: 'win32', getCatalog: () => [{ binding }] });
  t.after(() => service.shutdown());
  return { root, binding, installed, state, registry, production, service };
}

test('the member catalog offers installation only for a missing runtime and refreshes after installation', async t => {
  const h = fixture(t); h.state.missing = true;
  const { group } = await h.service.call('create', { title: 'Install before adding' });
  const missing = (await h.service.call('catalog')).bindings[0];
  assert.equal(missing.capability.canInstall, true);
  assert.equal(missing.capability.canVerify, false);
  assert.equal(missing.capability.supported, false);
  await assert.rejects(h.service.call('add-member', { id: group.id, bindingId: missing.id, name: 'Pending installation' }), /No harness runtime/);
  assert.equal(h.service.manager.get(group.id).participants.length, 0);
  h.state.missing = false;
  const installed = (await h.service.call('catalog')).bindings[0];
  assert.equal(installed.id, missing.id);
  assert.equal(installed.capability.canInstall, false);
  assert.equal(installed.capability.canVerify, true);
  assert.equal(h.state.starts, 0, 'Catalog refresh never installs a runtime or invokes a model');
  h.service.getCatalog = () => [];
  const empty = await h.service.call('catalog');
  assert.deepEqual(empty.bindings, []);
  assert.equal(empty.runtimes.length, 9);
  assert.equal(empty.runtimes.find(row => row.engine === 'dsh').canInstall, true, 'Installation remains available before models are configured');
  assert.equal(empty.runtimes.find(row => row.engine === 'claude').canInstall, false);
});

test('adding a member verifies a future harness; upgrades and path changes can be verified in the same app session', async t => {
  const h = fixture(t);
  const { group } = await h.service.call('create', { title: 'Runtime updates' });
  const { bindings } = await h.service.call('catalog');
  assert.equal(bindings[0].capability.canVerify, true);
  assert.equal(bindings[0].capability.available, false);
  const added = await h.service.call('add-member', { id: group.id, bindingId: bindings[0].id, name: 'Future harness' });
  const memberId = added.group.participants[0].id;
  await h.service.memberChecks.get(memberId)?.promise;
  const adapter = h.registry.get('claude');
  assert.equal(h.state.starts, 2);
  assert.equal(h.state.stops, 2);
  assert.equal(h.state.routesClosed, 2);
  assert.equal(h.service.capability(h.binding).available, true);
  for (const change of [
    () => { h.installed.version = '100.0.0'; },
    () => { h.installed.file = path.join(h.root, 'another-harness'); fs.writeFileSync(h.installed.file, 'same version, new path'); },
    () => { fs.appendFileSync(h.installed.file, 'replaced in place'); },
  ]) {
    const oldEvidence = adapter.evidence(h.binding), starts = h.state.starts;
    change();
    const loaded = (await h.service.call('load', { id: group.id })).group;
    assert.equal(loaded.participants[0].capability.available, false);
    assert.equal(loaded.participants[0].capability.canVerify, true);
    assert.equal(h.state.starts, starts, 'Reading a saved group never calls the model');
    assert.equal(h.registry.get('claude'), adapter);
    assert.throws(() => h.registry.admit(h.binding, oldEvidence), /Invalid discussion verification/);
    await h.service.call('verify-member', { id: group.id, participantId: memberId });
    assert.equal(h.service.capability(h.binding).available, true);
    assert.equal(h.state.starts, starts + 2);
    assert.equal(h.production.activities.size, 0);
  }
});

test('an incompatible reply fails real verification even when the installed version is accepted', async t => {
  const h = fixture(t);
  h.state.reply = () => 'incompatible protocol reply';
  await assert.rejects(h.production.verify(h.binding), /incompatible protocol reply/);
  assert.equal(h.registry.get('claude').evidence(h.binding), null);
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.stops, 1);
  assert.equal(h.production.activities.size, 0);
});

test('a runtime update between or after verification turns cannot admit stale evidence', async t => {
  for (const changedAfter of [1, 2]) {
    await t.test('after turn ' + changedAfter, async t => {
      const h = fixture(t);
      h.state.afterStop = () => { if (h.state.stops === changedAfter) h.installed.version = '100.0.0'; };
      await assert.rejects(h.production.verify(h.binding), /runtime changed during verification/);
      assert.equal(h.registry.get('claude').evidence(h.binding), null);
      assert.equal(h.state.starts, changedAfter);
      assert.equal(h.production.activities.size, 0);
      await h.production.verify(h.binding);
      assert.equal(h.service.capability(h.binding).available, true);
      assert.equal(h.state.starts, changedAfter + 2);
    });
  }
});
