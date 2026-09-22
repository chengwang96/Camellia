'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StorageCleanup, PROTECTION_MS } = require('../src/main/storage-cleanup');

function setup(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-storage-test-'));
  const dataDir = path.join(root, 'app');
  fs.mkdirSync(dataDir);
  let now = Date.now(), references = [], liveOwners = [];
  const conversations = { items: new Map() };
  const histories = [{ root: path.join(root, 'native-history') }];
  const cleaner = new StorageCleanup({ dataDir, histories, conversations, references: async () => references, liveOwners: () => liveOwners, now: () => now });
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
    refs: value => { references = value; }, owners: value => { liveOwners = value; }, advance: value => { now += value; } };
}

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
