'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StorageCleanup, PROTECTION_MS } = require('../src/main/storage-cleanup');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');

function setup(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-storage-test-'));
  const dataDir = path.join(root, 'app');
  fs.mkdirSync(dataDir);
  let now = Date.now(), references = [], liveOwners = [];
  const conversations = { items: new Map() };
  const histories = [{ root: path.join(root, 'native-history') }];
  const cleaner = new StorageCleanup({ dataDir, histories, conversations, references: async () => references, liveOwners: () => liveOwners, now: () => now });
  const maxVisited = cleaner.maxVisited;
  context.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('camellia-storage-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  function write(relative, text = 'retained data') {
    const file = path.join(dataDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, new Date(now - PROTECTION_MS * 2), new Date(now - PROTECTION_MS * 2));
    return file;
  }
  function attachment(text) { return write(`clipboard-attachments/pasted-text-123-${randomUUID()}.txt`, text); }
  function conversation(id, record = {}, rows = []) {
    write(`conversations/${id}.json`, JSON.stringify({ id, origin: 'codex', ...record }));
    write(`conversations/${id}.jsonl`, rows.map(row => JSON.stringify(row)).join('\n'));
  }
  return { root, dataDir, cleaner, histories, conversations, write, attachment, conversation,
    refs: value => { references = value; }, owners: value => { liveOwners = value; }, advance: value => { now += value; },
    budget: value => { cleaner.maxVisited = value; }, restoreBudget: () => { cleaner.maxVisited = maxVisited; } };
}

function remoteAttachment(h, folder = 'device-attachments') {
  return h.write(`remote/${folder}/${randomUUID().replaceAll('-', '').repeat(2)}.${folder === 'mobile-images' ? 'jpg' : 'txt'}`, 'remote bytes');
}

test('space preview includes only owned remote and group attachments and shows reclaimed bytes', async t => {
  const h = setup(t), remote = remoteAttachment(h), legacy = remoteAttachment(h, 'mobile-images');
  const group = randomUUID(), asset = randomUUID(), grouped = h.write(`discussions/assets/${group}/${asset}/notes.txt`, 'group bytes');
  const unknown = h.write('remote/device-attachments/user-file.txt');
  const unknownGroup = h.write(`discussions/assets/${group}/user-folder/keep.txt`);
  h.advance(PROTECTION_MS * 2);
  const preview = await h.cleaner.scan();
  assert.equal(preview.candidates.filter(entry => entry.category === 'Unused remote attachments').length, 2);
  assert.equal(preview.candidates.filter(entry => entry.category === 'Unused discussion attachments').length, 1);
  const result = await h.cleaner.clean(preview.token);
  assert.equal(result.files, 3); assert.equal(result.bytes, 35); assert.deepEqual(result.errors, []);
  for (const file of [remote, legacy, grouped]) assert.equal(fs.existsSync(file), false);
  for (const file of [unknown, unknownGroup]) assert.ok(fs.existsSync(file));
});

test('remote attachments retain paused and failed disk queues, archive, fork, native and draft references', async t => {
  const h = setup(t), retained = Array.from({ length: 7 }, () => remoteAttachment(h)), orphan = remoteAttachment(h);
  h.write('remote/message-queue.json', JSON.stringify(retained.slice(0, 2).map((file, i) => ({ state: i ? 'failed' : 'paused', payload: { attachments: [{ path: file }] } }))));
  h.conversation('archived', { archived: true }, [{ role: 'user', attachments: [{ path: retained[2] }] }]);
  h.conversation('fork', {}, [{ role: 'user', attachments: [{ path: retained[3] }] }]);
  const native = path.join(h.histories[0].root, 'workspace', 'history.jsonl');
  fs.mkdirSync(path.dirname(native), { recursive: true }); fs.writeFileSync(native, JSON.stringify({ text: retained[4] }) + '\n');
  h.refs([{ draft: { attachments: [{ path: retained[5] }] } }, { pending: [{ path: retained[6] }] }]);
  const result = await h.cleaner.sweepAttachments();
  assert.equal(result.files, 1); assert.deepEqual(result.errors, []);
  assert.equal(fs.existsSync(orphan), false);
  for (const file of retained) assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(native));
});

test('automatic cleanup only removes attachment copies and leaves other eligible storage for manual review', async t => {
  const h = setup(t), remote = remoteAttachment(h), clipboard = h.attachment(), history = h.write('conversations/orphan.jsonl');
  const preview = await h.cleaner.scan(), token = preview.token;
  assert.equal((await h.cleaner.sweepAttachments()).files, 1);
  assert.equal(h.cleaner.preview.token, token);
  assert.equal(fs.existsSync(remote), false);
  assert.ok(fs.existsSync(clipboard)); assert.ok(fs.existsSync(history));
  assert.equal((await h.cleaner.clean(token)).files, 2);
});

test('no old remote files avoids reading history; file age schedules a single later sweep', async t => {
  const h = setup(t);
  h.write('conversations/broken.json', '{torn');
  assert.equal((await h.cleaner.sweepAttachments()).files, 0);
  const remote = remoteAttachment(h);
  fs.utimesSync(remote, new Date(), new Date());
  const first = await h.cleaner.sweepAttachments();
  assert.equal(first.files, 0); assert.ok(first.nextSweepAt > Date.now());
  h.advance(PROTECTION_MS + 1000);
  await assert.rejects(h.cleaner.sweepAttachments(), /JSON/);
  assert.ok(fs.existsSync(remote));
});

test('active sends defer cleanup before querying drafts or reading history', async t => {
  const h = setup(t), remote = remoteAttachment(h);
  h.cleaner.isActive = () => true;
  h.cleaner.references = async () => { throw new Error('Should not read active drafts'); };
  assert.equal((await h.cleaner.sweepAttachments()).deferred, true);
  assert.ok(fs.existsSync(remote));
});

test('decoded large group messages and frozen native inputs retain attachment references stored only in payload files', async t => {
  const h = setup(t), manager = new DiscussionManager({ dir: path.join(h.dataDir, 'discussions') });
  const group = manager.create({ cwd: h.root });
  const member = manager.addMember(group.id, { name: 'Member', engine: 'codex', connection: 'api', model: 'fixture' });
  const messageFile = remoteAttachment(h), inputFile = remoteAttachment(h), orphan = remoteAttachment(h);
  const request = manager.enqueue(group.id, { requestId: 'stored-text', text: 'x'.repeat(17000) + messageFile, participantIds: [member.id] });
  const delivery = manager.prepare(group.id, request.deliveryIds[0]);
  manager.saveInput(group.id, delivery.id, delivery.generation, { prompt: 'y'.repeat(17000) + inputFile, inputThroughSeq: delivery.inputThroughSeq });
  const raw = fs.readFileSync(manager.store.file(group.id), 'utf8');
  assert.equal(raw.includes(path.basename(messageFile)), false); assert.equal(raw.includes(path.basename(inputFile)), false);
  assert.equal((await h.cleaner.sweepAttachments()).files, 1);
  for (const file of [messageFile, inputFile]) assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(orphan), false);
});

test('a group draft retains its copied asset after reload even without a posted message', async t => {
  const h = setup(t), group = randomUUID(), asset = randomUUID();
  const file = h.write(`discussions/assets/${group}/${asset}/photo.jpg`), orphan = h.write(`discussions/assets/${group}/${randomUUID()}/notes.txt`);
  h.advance(PROTECTION_MS * 2);
  h.refs([{ savedDraft: JSON.stringify({ attachments: [{ id: asset, path: file }] }) }]);
  assert.equal((await h.cleaner.sweepAttachments()).files, 1);
  assert.ok(fs.existsSync(file)); assert.equal(fs.existsSync(orphan), false);
});

test('queue changes during verification stop an automatic sweep before deleting files', async t => {
  const h = setup(t), remote = remoteAttachment(h), queue = h.write('remote/message-queue.json', '[]');
  const verify = h.cleaner.verify.bind(h.cleaner);
  h.cleaner.verify = records => {
    if (records.some(record => record.file === queue)) fs.writeFileSync(queue, JSON.stringify([{ payload: { attachments: [{ path: remote }] } }]));
    verify(records);
  };
  await assert.rejects(h.cleaner.sweepAttachments(), /changed/);
  assert.ok(fs.existsSync(remote));
});

test('mutating a live draft array during manual revalidation cannot authorize removal', async t => {
  const h = setup(t), remote = remoteAttachment(h), refs = [];
  h.refs(refs);
  const preview = await h.cleaner.scan(), inventory = h.cleaner.inventory.bind(h.cleaner);
  h.cleaner.inventory = async (...args) => {
    const result = await inventory(...args); refs.push({ attachments: [{ path: remote }] }); return result;
  };
  await assert.rejects(h.cleaner.clean(preview.token), /changed/);
  assert.ok(fs.existsSync(remote));
});

test('hardlinked remote files are excluded from cleanup', async t => {
  const h = setup(t), remote = remoteAttachment(h), external = path.join(h.root, 'external.txt');
  fs.linkSync(remote, external);
  assert.equal((await h.cleaner.sweepAttachments()).files, 0);
  assert.ok(fs.existsSync(remote)); assert.ok(fs.existsSync(external));
});

test('only unreferenced old Codex snapshots are eligible; archived homes keep their cache links', async context => {
  const h = setup(context), used = 'a'.repeat(64), unused = 'b'.repeat(64);
  h.write(`codex/plugin-caches/${used}/plugins/manifest.json`, 'used');
  h.write(`codex/plugin-caches/${unused}/plugins/manifest.json`, 'unused');
  const link = path.join(h.dataDir, 'codex/api/conversations/archived/.tmp');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(h.dataDir, 'codex/plugin-caches', used), link, process.platform === 'win32' ? 'junction' : 'dir');
  h.conversations.items.set('archived', { id: 'archived', archived: true });
  h.advance(PROTECTION_MS * 2);
  const preview = await h.cleaner.scan(), caches = preview.candidates.filter(entry => entry.category === 'Unused Codex plugin caches');
  assert.deepEqual(caches.map(entry => entry.path), [path.join('codex/plugin-caches', unused)]);
  const result = await h.cleaner.clean(preview.token);
  assert.equal(result.errors.length, 0);
  assert.ok(fs.existsSync(path.join(h.dataDir, 'codex/plugin-caches', used)));
  assert.equal(fs.existsSync(path.join(h.dataDir, 'codex/plugin-caches', unused)), false);
  assert.ok(fs.existsSync(link));
});

test('a cache newly referenced after preview is retained on confirmation', async context => {
  const h = setup(context), digest = 'c'.repeat(64);
  const file = h.write(`codex/plugin-caches/${digest}/plugins/manifest.json`, 'keep');
  h.write('codex/api/conversations/owner/session.json', '{}');
  h.conversations.items.set('owner', { id: 'owner' });
  h.advance(PROTECTION_MS * 2);
  const preview = await h.cleaner.scan();
  assert.ok(preview.candidates.some(entry => entry.category === 'Unused Codex plugin caches'));
  fs.symlinkSync(path.join(h.dataDir, 'codex/plugin-caches', digest), path.join(h.dataDir, 'codex/api/conversations/owner/.tmp'), process.platform === 'win32' ? 'junction' : 'dir');
  await h.cleaner.clean(preview.token);
  assert.ok(fs.existsSync(file));
});

test('a changed cache link during inventory invalidates the scan before deletion', async context => {
  const h = setup(context), first = 'd'.repeat(64), second = 'e'.repeat(64);
  for (const digest of [first, second]) h.write(`codex/plugin-caches/${digest}/plugins/manifest.json`, 'keep');
  const link = path.join(h.dataDir, 'codex/api/conversations/owner/.tmp');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(h.dataDir, 'codex/plugin-caches', first), link, process.platform === 'win32' ? 'junction' : 'dir');
  h.advance(PROTECTION_MS * 2);
  const verify = h.cleaner.verify.bind(h.cleaner);
  h.cleaner.verify = records => {
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(h.dataDir, 'codex/plugin-caches', second), link, process.platform === 'win32' ? 'junction' : 'dir');
    verify(records);
  };
  await assert.rejects(h.cleaner.scan(), /changed|change/);
  assert.ok(fs.existsSync(path.join(h.dataDir, 'codex/plugin-caches', first)));
});

test('plugin caches are protected while responses run or maintenance is interrupted', async context => {
  const h = setup(context), digest = 'f'.repeat(64);
  h.write(`codex/plugin-caches/${digest}/plugins/manifest.json`, 'keep'); h.advance(PROTECTION_MS * 2);
  h.cleaner.isActive = () => true;
  assert.equal((await h.cleaner.scan()).candidates.some(entry => entry.category === 'Unused Codex plugin caches'), false);
  h.cleaner.isActive = () => false;
  h.write('codex/.plugin-cache-operation.json', '{}');
  assert.equal((await h.cleaner.scan()).candidates.some(entry => entry.category === 'Unused Codex plugin caches'), false);
});

test('enumerating a large orphan plugin snapshot allows the settings event loop to run', async context => {
  const h = setup(context), digest = '9'.repeat(64);
  for (let index = 0; index < 512; index++) h.write(`codex/plugin-caches/${digest}/plugins/file-${index}.txt`, 'cache');
  h.advance(PROTECTION_MS * 2);
  let enumerating = false, ticks = 0;
  const stat = h.cleaner.safeStat.bind(h.cleaner);
  h.cleaner.safeStat = (file, root) => { if (file.includes(digest)) enumerating = true; return stat(file, root); };
  const timer = setInterval(() => { if (enumerating) ticks++; }, 1);
  try {
    const preview = await h.cleaner.scan();
    assert.ok(preview.candidates.some(entry => entry.category === 'Unused Codex plugin caches'));
    assert.ok(ticks > 0, 'The scanner must yield while walking cache files');
  } finally { clearInterval(timer); }
});

for (const directory of ['conversations', 'conversations/goals', 'conversations/tasks'])
  test('cleanup retains references when a quarantined record exists in ' + directory, async context => {
    const h = setup(context), attachment = h.attachment('original reference'), backup = h.write(directory + '/state.json.invalid-' + randomUUID(), '{broken data');
    await assert.rejects(h.cleaner.scan(), /Saved data requires recovery/);
    assert.ok(fs.existsSync(attachment)); assert.ok(fs.existsSync(backup));
  });

test('manual preview is read-only; confirmation removes only approved old managed files', async context => {
  const harness = setup(context);
  const attachment = harness.attachment('12345');
  const orphan = harness.write('conversations/deleted.jsonl', 'old log');
  const goal = harness.write('conversations/goals/deleted.json', '{}');
  const summary = harness.write(`conversations/handoffs/${randomUUID()}.md`, 'summary');
  const external = harness.write('workspace/keep.txt');
  const unknown = harness.write('clipboard-attachments/user-file.txt');
  const preview = await harness.cleaner.scan();
  assert.equal(preview.candidates.length, 4);
  for (const file of [attachment, orphan, goal, summary]) assert.ok(fs.existsSync(file));
  const result = await harness.cleaner.clean(preview.token);
  assert.equal(result.files, 4);
  assert.equal(result.bytes, 21);
  assert.deepEqual(result.errors, []);
  for (const file of [attachment, orphan, goal, summary]) assert.equal(fs.existsSync(file), false);
  for (const file of [external, unknown]) assert.ok(fs.existsSync(file));
  await assert.rejects(harness.cleaner.clean(preview.token), /Scan again/);
});

test('protects archived and fork references, compaction summaries, saved drafts and queued attachments', async context => {
  const harness = setup(context);
  const archived = harness.attachment(), fork = harness.attachment(), draft = harness.attachment(), queued = harness.attachment();
  const summary = harness.write(`conversations/handoffs/${randomUUID()}.md`);
  harness.conversation('archived', { segments: { codex: { compactFile: summary } } }, [{ attachments: [{ path: archived }] }]);
  harness.conversation('fork', {}, [{ attachments: [{ path: fork }] }]);
  harness.write('desktop-config.json', JSON.stringify({ sharedMeta: { archived: { archived: 123 } } }));
  harness.refs([{ attachments: [{ path: draft }] }, [{ attachments: [{ path: queued }] }]]);
  const preview = await harness.cleaner.scan();
  assert.equal(preview.candidates.length, 0);
});

test('conversation handoff pairs stay together while referenced and clean up when unused', async context => {
  const harness = setup(context);
  const keptStem = `conversation-${randomUUID()}`, orphanStem = `conversation-${randomUUID()}`;
  const keptFull = harness.write(`conversations/handoffs/${keptStem}.jsonl`, 'full saved history');
  const keptOverview = harness.write(`conversations/handoffs/${keptStem}.md`, `Full transcript: ${keptFull}`);
  const orphanFull = harness.write(`conversations/handoffs/${orphanStem}.jsonl`, 'unused full history');
  const orphanOverview = harness.write(`conversations/handoffs/${orphanStem}.md`, `Full transcript: ${orphanFull}`);
  harness.conversation('live', {}, [{ role: 'user', attachments: [{ path: keptOverview, fullPath: keptFull }] }]);
  const preview = await harness.cleaner.scan();
  assert.deepEqual(preview.candidates.map(entry => entry.path).sort(),
    [orphanOverview, orphanFull].map(file => path.relative(harness.dataDir, file)).sort());
  assert.equal((await harness.cleaner.clean(preview.token)).files, 2);
  for (const file of [keptOverview, keptFull]) assert.equal(fs.existsSync(file), true);
  for (const file of [orphanOverview, orphanFull]) assert.equal(fs.existsSync(file), false);
});

test('protects references in native history and nested referenced handoffs without deleting native history', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  const historyDir = path.join(harness.histories[0].root, 'project');
  fs.mkdirSync(historyDir, { recursive: true });
  const native = path.join(historyDir, 'native.jsonl');
  fs.writeFileSync(native, JSON.stringify({ text: attachment }) + '\n');
  const nested = harness.write(`conversations/handoffs/${randomUUID()}.md`);
  const summary = harness.write(`conversations/handoffs/${randomUUID()}.md`, nested);
  harness.conversation('live', { retiredSegments: [{ compactFile: summary }] });
  assert.equal((await harness.cleaner.scan()).candidates.length, 0);
  assert.ok(fs.existsSync(native));
});

test('discussion snapshots retain removed and retired histories, summaries and attachments', async context => {
  const h = setup(context), manager = new DiscussionManager({ dir: path.join(h.dataDir, 'discussions') });
  const group = manager.create({ cwd: h.root }), member = manager.addMember(group.id, { name: 'Member', engine: 'codex', connection: 'api', model: 'fixture' });
  const attachment = h.attachment(), summary = h.write(`conversations/handoffs/${randomUUID()}.md`);
  manager.enqueue(group.id, { requestId: 'ref', text: attachment });
  manager.store.update(group.id, state => Object.assign(state.participants[0].session, { nativeId: 'retired-native', summaryRef: summary }));
  const current = manager.configureMember(group.id, member.id, { model: 'second' });
  manager.removeMember(group.id, member.id);
  const oldEngine = h.write(`codex/api/conversations/${member.session.runtimeId}/state.txt`);
  const newEngine = h.write(`codex/api/conversations/${current.session.runtimeId}/state.txt`);
  const nativeEngine = h.write('kimi-code/conversations/retired-native/state.txt');
  const orphan = h.write('codex/api/conversations/orphan/state.txt');
  const snapshot = manager.store.file(group.id), retainedSnapshot = snapshot.slice(0, -5) + '.JSON';
  fs.renameSync(snapshot, retainedSnapshot);
  h.advance(PROTECTION_MS * 2);
  const preview = await h.cleaner.scan(); assert.equal(preview.candidates.length, 1);
  assert.equal((await h.cleaner.clean(preview.token)).files, 1);
  for (const file of [attachment, summary, oldEngine, newEngine, nativeEngine, retainedSnapshot]) assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(orphan), false);
});

test('append-only launch records, locks and seals remain protected even without a discussion snapshot', async context => {
  const h = setup(context), journal = new WindowsJobJournal({ dir: path.join(h.dataDir, 'discussions/windows-jobs') });
  const identity = { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 };
  const record = journal.reserve(identity); fs.writeFileSync(record.sealFile, 'sealed\n');
  const native = h.write(`codex/api/conversations/${identity.runtimeId}/state.txt`), orphan = h.attachment();
  h.advance(PROTECTION_MS * 2);
  const preview = await h.cleaner.scan(); assert.equal(preview.candidates.length, 1);
  assert.equal((await h.cleaner.clean(preview.token)).files, 1);
  for (const file of [native, record.lockFile, record.sealFile, journal.paths(identity).recordFile]) assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(orphan), false);
});

test('discussion storage identities retain native assets after their bridge is retired and removed', async context => {
  const h = setup(context), manager = new DiscussionManager({ dir: path.join(h.dataDir, 'discussions') });
  const group = manager.create({ cwd: h.root }), member = manager.addMember(group.id, { name: 'Member', engine: 'antigravity', connection: 'api', model: 'fixture' });
  const conversationId = randomUUID().replaceAll('-', ''), nativeId = randomUUID();
  const storageDir = path.join(h.dataDir, 'antigravity/sessions', nativeId, 'native');
  manager.store.update(group.id, state => Object.assign(state.participants[0].session,
    { nativeId, nativeStorage: { connection: 'api', storageDir, conversationId } }));
  manager.configureMember(group.id, member.id, { model: 'next' }); manager.removeMember(group.id, member.id);
  const native = h.write(`antigravity/sessions/${nativeId}/native/${conversationId}.db`);
  const related = h.write(`conversations/goals/${conversationId}.json`, '{}');
  const orphan = h.write('codex/api/conversations/orphan/state.txt'); h.advance(PROTECTION_MS * 2);
  const preview = await h.cleaner.scan();
  assert.ok(preview.candidates.some(row => row.path.includes('orphan')));
  await h.cleaner.clean(preview.token);
  assert.ok(fs.existsSync(native)); assert.ok(fs.existsSync(related)); assert.equal(fs.existsSync(orphan), false);
});

test('corrupt discussion and partial launch records stop cleanup before deleting unrelated candidates', async context => {
  const h = setup(context), orphan = h.attachment(), id = randomUUID();
  const file = h.write(`discussions/${id}.json`, '{torn');
  await assert.rejects(h.cleaner.scan(), /JSON/); assert.ok(fs.existsSync(orphan));
  fs.unlinkSync(file);
  const unknown = h.write('discussions/damaged-name.json', '{}');
  await assert.rejects(h.cleaner.scan(), /record name/); fs.unlinkSync(unknown);
  const identity = { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 };
  const journal = new WindowsJobJournal({ dir: path.join(h.dataDir, 'discussions/windows-jobs') });
  const record = journal.reserve(identity);
  fs.unlinkSync(record.lockFile);
  await assert.rejects(h.cleaner.scan(), /Invalid job journal/); assert.ok(fs.existsSync(orphan));
  fs.unlinkSync(journal.paths(identity).recordFile);
  await assert.rejects(h.cleaner.scan(), /Job launch record/); assert.ok(fs.existsSync(orphan));
});

test('a discussion created after preview protects its previously orphaned runtime directory', async context => {
  const h = setup(context), runtimeId = randomUUID(), file = h.write(`codex/api/conversations/${runtimeId}/state.txt`);
  h.advance(PROTECTION_MS * 2);
  const preview = await h.cleaner.scan(); assert.equal(preview.candidates.length, 1);
  const manager = new DiscussionManager({ dir: path.join(h.dataDir, 'discussions') }), group = manager.create({ cwd: h.root });
  manager.addMember(group.id, { name: 'Member', engine: 'codex', connection: 'api', model: 'fixture' });
  manager.store.update(group.id, state => { state.participants[0].session.runtimeId = runtimeId; });
  assert.equal((await h.cleaner.clean(preview.token)).files, 0); assert.ok(fs.existsSync(file));
});

test('a discussion directory appearing during final reference collection invalidates an empty scan', async context => {
  const h = setup(context), file = h.attachment(), preview = await h.cleaner.scan();
  let reads = 0;
  h.cleaner.references = async () => {
    if (++reads === 2) {
      const manager = new DiscussionManager({ dir: path.join(h.dataDir, 'discussions') }), group = manager.create({ cwd: h.root });
      manager.enqueue(group.id, { requestId: 'new', text: file });
    }
    return [];
  };
  await assert.rejects(h.cleaner.clean(preview.token), /Reference files changed/); assert.ok(fs.existsSync(file));
});

test('new files and recently modified files have a 24-hour protection window', async context => {
  const harness = setup(context);
  const file = harness.attachment();
  fs.utimesSync(file, new Date(), new Date());
  assert.equal((await harness.cleaner.scan()).candidates.length, 0);
  harness.advance(PROTECTION_MS * 2);
  assert.equal((await harness.cleaner.scan()).candidates.length, 1);
});

test('confirmation rechecks references and excludes newly created candidates', async context => {
  const harness = setup(context);
  const protectedLater = harness.attachment(), removed = harness.attachment();
  const preview = await harness.cleaner.scan();
  const addedLater = harness.attachment();
  harness.refs([{ path: protectedLater }]);
  const result = await harness.cleaner.clean(preview.token);
  assert.equal(result.files, 1);
  assert.equal(result.skipped, 1);
  assert.ok(fs.existsSync(protectedLater)); assert.ok(fs.existsSync(addedLater));
  assert.equal(fs.existsSync(removed), false);
});

test('a restored conversation protects an orphan log between preview and confirmation', async context => {
  const harness = setup(context);
  const file = harness.write('conversations/restored.jsonl', '{}\n');
  const preview = await harness.cleaner.scan();
  harness.conversation('restored');
  const result = await harness.cleaner.clean(preview.token);
  assert.equal(result.files, 0);
  assert.ok(fs.existsSync(file));
});

test('modified candidates are not removed even when their modification time is backdated', async context => {
  const harness = setup(context);
  const file = harness.attachment();
  const preview = await harness.cleaner.scan();
  fs.appendFileSync(file, 'changed');
  const before = new Date(Date.now() - PROTECTION_MS * 2);
  fs.utimesSync(file, before, before);
  assert.equal((await harness.cleaner.clean(preview.token)).files, 0);
  assert.ok(fs.existsSync(file));
});

test('per-conversation engine directories require absent owners and no live process', async context => {
  const harness = setup(context);
  const removed = harness.write('codex/api/conversations/deleted/sessions/rollout.jsonl');
  const alive = harness.write('kimi-code/conversations/alive/state.json');
  const live = harness.write('dsh-chat/conversations/process/state.json');
  const subscription = harness.write('codex/subscription/conversations/deleted/keep.txt');
  harness.conversation('alive'); harness.owners(['process']);
  harness.advance(PROTECTION_MS * 2);
  const preview = await harness.cleaner.scan();
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].category, 'Unused engine directories');
  const result = await harness.cleaner.clean(preview.token);
  assert.equal(result.files, 1);
  assert.equal(fs.existsSync(removed), false);
  assert.equal(fs.existsSync(path.join(harness.dataDir, 'codex/api/conversations/deleted')), false);
  for (const file of [alive, live, subscription]) assert.ok(fs.existsSync(file));
});

test('active cleanup removes orphan records and engine directories but protects shared files and live owners', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  const summary = harness.write(`conversations/handoffs/${randomUUID()}.md`);
  const orphan = harness.write('conversations/removed.jsonl', '{}\n');
  const unusedEngine = harness.write('codex/api/conversations/deleted/state.txt');
  const liveEngine = harness.write('codex/api/conversations/alive/state.txt');
  const liveLog = harness.write('conversations/alive.jsonl', '{}\n');
  harness.owners(['alive']);
  harness.cleaner.isActive = () => true;
  harness.advance(PROTECTION_MS * 2);
  const preview = await harness.cleaner.scan();
  assert.equal(preview.active, true);
  assert.equal(preview.candidates.length, 2);
  assert.equal((await harness.cleaner.clean(preview.token)).files, 2);
  for (const file of [attachment, summary, liveEngine, liveLog]) assert.ok(fs.existsSync(file));
  for (const file of [orphan, unusedEngine]) assert.equal(fs.existsSync(file), false);
  harness.cleaner.isActive = () => false;
  assert.equal((await harness.cleaner.scan()).candidates.length, 2);
});

test('activity starting during reference collection protects shared candidates approved while idle', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  const summary = harness.write(`conversations/handoffs/${randomUUID()}.md`);
  const orphan = harness.write('conversations/removed.jsonl', '{}\n');
  const preview = await harness.cleaner.scan();
  harness.cleaner.references = async () => {
    harness.cleaner.isActive = () => true;
    return [];
  };
  const result = await harness.cleaner.clean(preview.token);
  assert.equal(result.files, 1);
  assert.equal(result.skipped, 2);
  assert.ok(fs.existsSync(attachment));
  assert.ok(fs.existsSync(summary));
  assert.equal(fs.existsSync(orphan), false);
});

test('renderer activity protects shared files even without a running backend session', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  harness.refs({ references: [], active: true });
  const preview = await harness.cleaner.scan();
  assert.equal(preview.active, true);
  assert.equal(preview.candidates.length, 0);
  assert.ok(fs.existsSync(attachment));
});

test('a live owner appearing during reference collection protects a previously approved directory', async context => {
  const harness = setup(context);
  const file = harness.write('codex/api/conversations/restored/state.txt');
  harness.advance(PROTECTION_MS * 2);
  const preview = await harness.cleaner.scan();
  assert.equal(preview.candidates.length, 1);
  harness.cleaner.references = async () => {
    harness.owners(['restored']);
    return { references: [], active: true };
  };
  assert.equal((await harness.cleaner.clean(preview.token)).files, 0);
  assert.ok(fs.existsSync(file));
});

test('reference files modified during verification stop deletion', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  harness.conversation('live', {}, [{ text: 'existing reference data' }]);
  const transcript = path.join(harness.dataDir, 'conversations/live.jsonl');
  const preview = await harness.cleaner.scan();
  const readSync = fs.readSync;
  const transcriptInode = fs.statSync(transcript).ino;
  let changed = false;
  context.mock.method(fs, 'readSync', (...args) => {
    const bytes = readSync(...args);
    if (!changed && fs.fstatSync(args[0]).ino === transcriptInode) {
      changed = true;
      fs.appendFileSync(transcript, '{"text":"new reference"}\n');
    }
    return bytes;
  });
  await assert.rejects(harness.cleaner.clean(preview.token), /Reference files changed/);
  assert.ok(fs.existsSync(attachment));
});

test('unreadable or damaged ownership data fails closed before any deletion', async context => {
  const harness = setup(context);
  const file = harness.attachment();
  const preview = await harness.cleaner.scan();
  harness.write('conversations/broken.json', '{');
  await assert.rejects(harness.cleaner.clean(preview.token));
  assert.ok(fs.existsSync(file));
  await assert.rejects(harness.cleaner.scan());
});

test('a directory referenced as a workspace remains intact', async context => {
  const harness = setup(context);
  const file = harness.write('codex/api/conversations/deleted/work/file.txt');
  harness.conversation('live', { cwd: path.dirname(file) });
  harness.advance(PROTECTION_MS * 2);
  assert.equal((await harness.cleaner.scan()).candidates.length, 0);
  assert.ok(fs.existsSync(file));
});

test('damaged retained transcript and unavailable drafts block scanning', async context => {
  const harness = setup(context);
  harness.conversation('live');
  harness.write('conversations/live.jsonl', '{broken');
  await assert.rejects(harness.cleaner.scan());
  harness.cleaner.references = async () => { throw new Error('draft unavailable'); };
  await assert.rejects(harness.cleaner.scan(), /draft unavailable/);
});

test('junctions and linked files cannot redirect cleanup outside managed storage', async context => {
  const harness = setup(context);
  const external = path.join(harness.root, 'external');
  fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'keep.txt'), 'keep');
  fs.mkdirSync(path.join(harness.dataDir, 'codex/api/conversations'), { recursive: true });
  fs.symlinkSync(external, path.join(harness.dataDir, 'codex/api/conversations/deleted'), process.platform === 'win32' ? 'junction' : 'dir');
  harness.advance(PROTECTION_MS * 2);
  const preview = await harness.cleaner.scan();
  assert.equal(preview.candidates.length, 0);
  assert.ok(fs.existsSync(path.join(external, 'keep.txt')));
  assert.throws(() => harness.cleaner.safeStat(external), /Unsafe/);
});

test('a linked shared plugin cache is not counted or removed as conversation state', async context => {
  const harness = setup(context);
  const shared = path.join(harness.dataDir, 'codex/api/.tmp');
  fs.mkdirSync(path.join(shared, 'plugins', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'plugins', 'demo', 'plugin.json'), '{}');
  for (const id of ['one', 'two']) {
    const home = path.join(harness.dataDir, `codex/api/conversations/${id}`);
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(shared, path.join(home, '.tmp'), process.platform === 'win32' ? 'junction' : 'dir');
    harness.write(`codex/api/conversations/${id}/sessions/rollout.jsonl`, '{}');
  }
  harness.advance(PROTECTION_MS * 2);
  const preview = await harness.cleaner.scan();
  assert.equal(preview.candidates.length, 2);
  assert.equal((await harness.cleaner.clean(preview.token)).files, 2);
  for (const id of ['one', 'two']) assert.equal(fs.existsSync(path.join(harness.dataDir, `codex/api/conversations/${id}`)), false);
  assert.equal(fs.existsSync(path.join(shared, 'plugins', 'demo', 'plugin.json')), true);
  assert.equal((await harness.cleaner.scan()).candidates.length, 0);
});

test('a real per-conversation plugin cache is skipped instead of exhausting the scan budget', async context => {
  const harness = setup(context);
  for (const id of ['unused', 'live']) {
    for (let index = 0; index < 40; index++) harness.write(`codex/api/conversations/${id}/.tmp/plugins/copy-${index}.txt`, 'cache');
    harness.write(`codex/api/conversations/${id}/sessions/rollout.jsonl`, '{}');
  }
  harness.owners(['live']);
  harness.advance(PROTECTION_MS * 2);
  const cleaner = harness.cleaner;
  harness.budget(50);
  const preview = await cleaner.scan();
  harness.restoreBudget();
  assert.equal(preview.candidates.length, 0);
  await cleaner.clean(preview.token);
  assert.equal(fs.existsSync(path.join(harness.dataDir, 'codex/api/conversations/unused/sessions/rollout.jsonl')), true);
  assert.ok(fs.existsSync(path.join(harness.dataDir, 'codex/api/conversations/live/.tmp/plugins/copy-0.txt')));
});

test('a directory replaced by a junction after scanning cannot be deleted', async context => {
  const harness = setup(context);
  const original = path.join(harness.dataDir, 'codex/api/conversations/deleted');
  harness.write('codex/api/conversations/deleted/file.txt');
  harness.advance(PROTECTION_MS * 2);
  const preview = await harness.cleaner.scan();
  fs.renameSync(original, path.join(harness.root, 'saved'));
  const external = path.join(harness.root, 'outside'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'file.txt'), 'outside');
  fs.symlinkSync(external, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await harness.cleaner.clean(preview.token)).files, 0);
  assert.ok(fs.existsSync(path.join(external, 'file.txt')));
});

test('hard-linked attachments are retained', async context => {
  const harness = setup(context);
  const file = harness.attachment();
  fs.linkSync(file, path.join(harness.root, 'external-copy'));
  assert.equal((await harness.cleaner.scan()).candidates.length, 0);
});

test('recent files inside an old plugin cache protect the entire conversation directory', async context => {
  const harness = setup(context);
  const file = harness.write('codex/api/conversations/unused/.tmp/plugins/recent.txt');
  harness.advance(PROTECTION_MS * 2);
  fs.utimesSync(file, new Date(Date.now() + PROTECTION_MS * 2), new Date(Date.now() + PROTECTION_MS * 2));
  assert.equal((await harness.cleaner.scan()).candidates.length, 0);
  assert.ok(fs.existsSync(file));
});

test('unknown links fail closed while DSH dependency junctions are not traversed', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  const external = path.join(harness.root, 'dependency');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'reference.txt'), attachment);
  const modules = path.join(harness.dataDir, 'dsh-chat/conversations/live/profiles/node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.symlinkSync(external, path.join(modules, 'package'), process.platform === 'win32' ? 'junction' : 'dir');
  harness.owners(['live']);
  assert.equal((await harness.cleaner.scan()).candidates.length, 1);
  fs.symlinkSync(external, path.join(harness.dataDir, 'dsh-chat/conversations/live/history-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await harness.cleaner.scan()).candidates.length, 0);
  assert.ok(fs.existsSync(attachment));
});

test('scan yields to the event loop and supports cancellation without retaining a preview', async context => {
  const harness = setup(context), controller = new AbortController();
  harness.cleaner.signal = controller.signal;
  harness.write('codex/api/conversations/live/history.txt', 'history');
  setImmediate(() => controller.abort(new Error('fixture cancel')));
  await assert.rejects(harness.cleaner.scan(), /fixture cancel/);
  assert.equal(harness.cleaner.running, false);
  assert.equal(harness.cleaner.preview, null);
});

test('confirmation rejects new reference files created while collecting the final draft snapshot', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  harness.conversation('live');
  const preview = await harness.cleaner.scan();
  let calls = 0;
  harness.cleaner.references = async () => {
    if (++calls === 2) harness.conversation('created', {}, [{ path: attachment }]);
    return [];
  };
  await assert.rejects(harness.cleaner.clean(preview.token), /Reference files changed/);
  assert.ok(fs.existsSync(attachment));
});

test('expired previews release their retained inventory without requiring another click', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = setup(context);
  harness.attachment();
  await harness.cleaner.scan();
  assert.ok(harness.cleaner.preview);
  context.mock.timers.tick(30 * 60 * 1000);
  assert.equal(harness.cleaner.preview, null);
});

test('invalid, expired and concurrently executing requests do not delete files', async context => {
  const harness = setup(context);
  const file = harness.attachment();
  const preview = await harness.cleaner.scan();
  await assert.rejects(harness.cleaner.clean('../outside'), /Scan again/);
  const fresh = await harness.cleaner.scan();
  harness.advance(31 * 60 * 1000);
  await assert.rejects(harness.cleaner.clean(fresh.token), /Scan again/);
  let release;
  harness.cleaner.references = () => new Promise(resolve => { release = resolve; });
  const pending = harness.cleaner.scan();
  await assert.rejects(harness.cleaner.scan(), /already running/);
  await assert.rejects(harness.cleaner.clean(preview.token), /already running/);
  release([]); await pending;
  assert.ok(fs.existsSync(file));
});

test('partial unlink failures are reported without claiming unrecovered bytes', async context => {
  const harness = setup(context);
  const failed = harness.attachment('123'), removed = harness.attachment('12');
  const preview = await harness.cleaner.scan();
  const unlink = fs.unlinkSync;
  context.mock.method(fs, 'unlinkSync', file => { if (file === failed) throw new Error('Access denied'); return unlink(file); });
  const result = await harness.cleaner.clean(preview.token);
  assert.equal(result.files, 1); assert.equal(result.bytes, 2); assert.equal(result.errors.length, 1);
  assert.ok(fs.existsSync(failed)); assert.equal(fs.existsSync(removed), false);
});

test('retained orphan logs, goals, summaries and native state protect referenced attachments', async context => {
  const harness = setup(context);
  const files = Array.from({ length: 4 }, () => harness.attachment());
  const log = harness.write('conversations/orphan.jsonl', JSON.stringify({ attachments: [files[0]] }));
  harness.write('conversations/goals/orphan.json', JSON.stringify({ text: files[1] }));
  harness.write(`conversations/handoffs/${randomUUID()}.md`, files[2]);
  harness.write('codex/api/conversations/orphan/state.json', JSON.stringify({ attachments: [files[3]] }));
  fs.utimesSync(log, new Date(), new Date());
  const preview = await harness.cleaner.scan();
  assert.ok(preview.candidates.every(entry => entry.category !== 'Unused pasted attachments'));
  await harness.cleaner.clean(preview.token);
  for (const file of files) assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(log));
});

test('attachments referenced by deleted remnants become eligible on the next manual scan', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  harness.write('conversations/orphan.jsonl', JSON.stringify({ path: attachment }));
  const preview = await harness.cleaner.scan();
  assert.equal(preview.candidates.length, 1);
  assert.equal((await harness.cleaner.clean(preview.token)).files, 1);
  assert.ok(fs.existsSync(attachment));
  assert.equal((await harness.cleaner.scan()).candidates[0].path, path.relative(harness.dataDir, attachment));
});

test('missing expected transcript fails closed', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  harness.write('conversations/live.json', JSON.stringify({ id: 'live', seq: 4 }));
  await assert.rejects(harness.cleaner.scan(), /reference file is missing/);
  assert.ok(fs.existsSync(attachment));
});

test('history larger than 256 MiB is scanned in bounded reads and still protects references near the end', async context => {
  const harness = setup(context);
  const retained = harness.attachment(), unused = harness.attachment();
  harness.conversation('large');
  const file = path.join(harness.dataDir, 'conversations/large.jsonl');
  const descriptor = fs.openSync(file, 'w');
  const row = Buffer.from(JSON.stringify({ text: 'x'.repeat(64 * 1024) }) + '\n');
  try {
    for (let index = 0; index < 4112; index += 1) fs.writeSync(descriptor, row);
    fs.writeSync(descriptor, JSON.stringify({ path: retained }));
  } finally { fs.closeSync(descriptor); }
  assert.ok(fs.statSync(file).size > 256 * 1024 * 1024);
  const readFile = fs.readFileSync;
  context.mock.method(fs, 'readFileSync', (target, ...args) => {
    assert.notEqual(target, file, 'large histories must not be read into memory in full');
    return readFile(target, ...args);
  });
  const preview = await harness.cleaner.scan();
  assert.deepEqual(preview.candidates.map(entry => entry.path), [path.relative(harness.dataDir, unused)]);
  assert.equal((await harness.cleaner.clean(preview.token)).files, 1);
  assert.ok(fs.existsSync(retained));
  assert.ok(fs.existsSync(file));
});

test('raw references crossing UTF-8 and escaped path chunk boundaries remain protected', async context => {
  const harness = setup(context);
  const attachment = harness.write(`clipboard-attachments/pasted-text-123-${randomUUID()}.txt`);
  const escapedFile = harness.write('codex/api/conversations/escaped/中文/data.txt');
  const unicodeFile = harness.write('codex/api/conversations/unicode/中文/data.txt');
  const relative = path.relative(harness.dataDir, path.dirname(unicodeFile)).replace(/\\/g, '/');
  const escaped = path.relative(harness.dataDir, path.dirname(escapedFile)).replace(/\\/g, '/').replace(/\//g, '\\\\');
  const boundary = 64 * 1024;
  harness.write('codex/api/conversations/live/paths.txt', ' '.repeat(boundary - escaped.indexOf('\\') - 1) + escaped);
  harness.write('codex/api/conversations/live/utf8.txt', ' '.repeat(boundary - Buffer.byteLength(relative.slice(0, relative.indexOf('中'))) - 1) + relative);
  const name = path.basename(attachment);
  harness.write('codex/api/conversations/live/attachment.txt', ' '.repeat(boundary - 15) + name);
  harness.owners(['live']);
  harness.advance(PROTECTION_MS * 2);
  assert.equal((await harness.cleaner.scan()).candidates.length, 0);
});

test('escaped JSON references are decoded across blocks and final records without newlines', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  harness.conversation('live');
  const escaped = path.basename(attachment).replace(/p/g, '\\u0070');
  harness.write('conversations/live.jsonl', ' '.repeat(64 * 1024 - 4) + '{"path":"' + escaped + '"}');
  assert.equal((await harness.cleaner.scan()).candidates.length, 0);
});

test('malformed records late in a streamed transcript stop confirmation without deletion', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  harness.conversation('live');
  const preview = await harness.cleaner.scan();
  harness.write('conversations/live.jsonl', ('{"text":"ok"}\n').repeat(10000) + '{broken');
  await assert.rejects(harness.cleaner.clean(preview.token), SyntaxError);
  assert.ok(fs.existsSync(attachment));
  assert.equal(harness.cleaner.preview, null);
});

test('an oversized individual JSON record fails closed instead of buffering unbounded data', async context => {
  const harness = setup(context);
  const attachment = harness.attachment();
  harness.conversation('live');
  const preview = await harness.cleaner.scan();
  const file = path.join(harness.dataDir, 'conversations/live.jsonl');
  const descriptor = fs.openSync(file, 'w');
  try {
    fs.writeSync(descriptor, '{"text":"');
    const block = Buffer.alloc(1024 * 1024, 'x');
    for (let index = 0; index < 33; index += 1) fs.writeSync(descriptor, block);
    fs.writeSync(descriptor, '"}');
  } finally { fs.closeSync(descriptor); }
  await assert.rejects(harness.cleaner.clean(preview.token), /reference JSON record is too large/);
  assert.ok(fs.existsSync(attachment));
});
