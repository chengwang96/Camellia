'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { removeTree } = require('./test-fs.cjs');
const { createVisualizeStore, MAX_STORED_BYTES, MAX_STATE_BYTES,
  MAX_CARDS_PER_CONVERSATION } = require('../src/engines/visualize-store');
const { embedWorkspaceImages, embedWorkspaceVideos, embedWorkspaceData } = require('../src/engines/visualize-assets');

test('visualize store persists cards and rejects unsafe document shapes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-'));
  t.after(() => removeTree(root));
  const store = createVisualizeStore({ dir: root });
  const card = store.create('conversation-1', {
    title: 'Parameter explorer',
    summary: 'A small simulator',
    mode: 'wide',
    fragment: '<div id="app">Hello</div><script>document.body.dataset.ready="1"</script>',
  });
  assert.match(card.cardId, /^[0-9a-f-]{36}$/);
  assert.equal(card.mode, 'wide');
  const loaded = store.get('conversation-1', card.cardId);
  assert.equal(loaded.layoutVersion, 2);
  assert.equal(loaded.title, 'Parameter explorer');
  assert.match(loaded.html, /Hello/);
  const updated = store.update('conversation-1', card.cardId, {
    oldStr: 'Hello', newStr: 'Updated', summary: 'Changed result', style: 'paper',
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.layoutVersion, 2);
  assert.equal(updated.summary, 'Changed result');
  assert.equal(updated.style, 'paper');
  assert.match(store.get('conversation-1', card.cardId).html, /Updated/);
  assert.throws(() => store.update('conversation-1', card.cardId, {
    oldStr: 'missing', newStr: 'nope',
  }), /match exactly once/);
  await assert.rejects(async () => store.get('conversation-2', card.cardId), /not found/);
  assert.throws(() => store.create('conversation-1', {
    title: 'Unsafe', fragment: '<html><body>bad</body></html>',
  }), /must not contain/);
  assert.throws(() => store.create('conversation-1', {
    title: 'Large', fragment: 'x'.repeat(MAX_STORED_BYTES + 1),
  }), /exceeds/);
  await store.remove('conversation-1');
  assert.equal(fs.existsSync(path.join(root, 'conversation-1')), false);
});

test('visualize workspace images are embedded only from the conversation workspace', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-images-'));
  t.after(() => removeTree(root));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(root, 'figure.png'), png);
  fs.writeFileSync(path.join(root, 'note.txt'), 'not an image');
  const embedded = embedWorkspaceImages('<img data-viz-src="figure.png" alt="Result">', root);
  assert.match(embedded.fragment, /data:image\/png;base64,/);
  assert.equal(embedded.assets[0].path, 'figure.png');
  assert.throws(() => embedWorkspaceImages('<img data-viz-src="../outside.png">', root), /inside|not found/i);
  assert.throws(() => embedWorkspaceImages('<img data-viz-src="note.txt">', root), /Unsupported|match its extension/i);
  assert.throws(() => embedWorkspaceImages('<img data-viz-src="https://example.com/a.png">', root), /workspace path/);
});

test('visualize patches keep replacement dollar sequences literal', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-patch-'));
  t.after(() => removeTree(root));
  const store = createVisualizeStore({ dir: root });
  const card = store.create('conversation-1', { title: 'Patch', fragment: '<div>before</div>' });
  const replacement = '$& $$ $` $\'';
  store.update('conversation-1', card.cardId, { oldStr: 'before', newStr: replacement });
  assert.equal(store.get('conversation-1', card.cardId).html, '<div>' + replacement + '</div>');
});

test('visualize full replacements accept embedded media above the raw fragment limit', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-update-media-'));
  t.after(() => removeTree(root));
  const store = createVisualizeStore({ dir: path.join(root, 'cards') });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(160000),
  ]);
  fs.writeFileSync(path.join(root, 'figure.png'), png);
  const card = store.create('conversation-1', { title: 'Image', fragment: '<div>Original</div>' });
  const embedded = embedWorkspaceImages('<img data-viz-src="figure.png" alt="Result">', root);
  assert.ok(Buffer.byteLength(embedded.fragment) > 200000);
  store.update('conversation-1', card.cardId, { fragment: embedded.fragment });
  assert.equal(store.get('conversation-1', card.cardId).html, embedded.fragment);
  assert.throws(() => store.update('conversation-1', card.cardId, {
    fragment: 'x'.repeat(MAX_STORED_BYTES + 1),
  }), /exceeds/);
});

test('visualize workspace videos are embedded with bounded local data URLs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-videos-'));
  t.after(() => removeTree(root));
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(8)]);
  fs.writeFileSync(path.join(root, 'clip.mp4'), mp4);
  fs.writeFileSync(path.join(root, 'fake.mp4'), 'not a video');
  const embedded = embedWorkspaceVideos(
    '<video data-viz-src="clip.mp4" controls playsinline></video>', root,
  );
  assert.match(embedded.fragment, /data:video\/mp4;base64,/);
  assert.match(embedded.fragment, /controls playsinline/);
  assert.equal(embedded.assets[0].path, 'clip.mp4');
  assert.equal(embedded.assets[0].mime, 'video/mp4');
  assert.throws(() => embedWorkspaceVideos('<video data-viz-src="../outside.mp4"></video>', root), /inside|not found/i);
  assert.throws(() => embedWorkspaceVideos('<video data-viz-src="fake.mp4"></video>', root), /match its extension/i);
});

test('visualize state persists across revisions and can be cleared', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-state-'));
  t.after(() => removeTree(root));
  const store = createVisualizeStore({ dir: root });
  const card = store.create('conversation-1', {
    title: 'Stateful card',
    fragment: '<div>Hello</div>',
  });
  assert.equal(store.get('conversation-1', card.cardId).state, null);
  assert.deepEqual(store.setState('conversation-1', card.cardId, {
    selected: 'coast',
    weights: { scenery: 42, ease: 30 },
  }).state, { selected: 'coast', weights: { scenery: 42, ease: 30 } });
  store.update('conversation-1', card.cardId, { oldStr: 'Hello', newStr: 'Updated' });
  assert.deepEqual(store.get('conversation-1', card.cardId).state, {
    selected: 'coast',
    weights: { scenery: 42, ease: 30 },
  });
  assert.throws(() => store.setState('conversation-1', card.cardId, {
    tooLarge: 'x'.repeat(MAX_STATE_BYTES),
  }), /exceeds/);
  assert.equal(store.setState('conversation-1', card.cardId, null, { clear: true }).state, null);
  assert.equal(store.get('conversation-1', card.cardId).state, null);
});

test('visualization network origins are HTTPS-only and approval resets when origins change', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-network-'));
  t.after(() => removeTree(root));
  const store = createVisualizeStore({ dir: root });
  assert.throws(() => store.create('conversation-1', {
    title: 'Unsafe network',
    fragment: '<div>Network</div>',
    networkOrigins: ['http://example.com'],
  }), /HTTPS/);
  const card = store.create('conversation-1', {
    title: 'Network card',
    fragment: '<div>Network</div>',
    networkOrigins: ['https://example.com/path', 'https://example.com', 'https://api.example.com'],
  });
  assert.deepEqual(card.networkOrigins, ['https://example.com', 'https://api.example.com']);
  assert.equal(card.networkApproved, false);
  assert.equal(store.setNetworkApproval('conversation-1', card.cardId, true).networkApproved, true);
  assert.equal(store.get('conversation-1', card.cardId).networkApproved, true);
  assert.equal(store.update('conversation-1', card.cardId, {
    networkOrigins: ['https://media.example.com'],
  }).networkApproved, false);
  assert.deepEqual(store.get('conversation-1', card.cardId).networkOrigins, ['https://media.example.com']);
});

test('visualize workspace data binds JSON and CSV internally', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-data-'));
  t.after(() => removeTree(root));
  fs.writeFileSync(path.join(root, 'scores.csv'), 'city,score\nOsaka,8\nKyoto,9\n');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ version: 1, theme: 'paper' }));
  const fragment = '<script type="application/json" data-viz-data="scores.csv" data-viz-name="scores"></script>' +
    '<script type="application/json" data-viz-data="config.json" data-viz-name="config"></script>';
  const result = embedWorkspaceData(fragment, root);
  assert.deepEqual(result.assets.map(asset => [asset.name, asset.format]), [['scores', 'csv'], ['config', 'json']]);
  const values = Object.fromEntries([...result.fragment.matchAll(
    /<script type="application\/json" data-viz-name="([^"]+)">([\s\S]*?)<\/script>/g,
  )].map(match => [match[1], JSON.parse(match[2])]));
  assert.deepEqual(values.scores[0], { city: 'Osaka', score: '8' });
  assert.deepEqual(values.config, { version: 1, theme: 'paper' });
  assert.throws(() => embedWorkspaceData(
    '<script type="application/json" data-viz-data="../outside.csv"></script>', root,
  ), /inside|not found/i);
});

test('visualize result detection accepts only successful cards', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/chat/visualize-card.js'), 'utf8'),
    { window, JSON, String, Number, Math, console, TextEncoder });
  const parse = window.CamelliaVisualize.parse;
  assert.deepEqual(parse(JSON.stringify({ ok: true, visualize: { cardId: 'card-1', title: 'Dashboard' } })),
    { cardId: 'card-1', title: 'Dashboard' });
  assert.equal(parse(JSON.stringify({ ok: false, error: 'no' })), null);
  assert.equal(parse('not json'), null);
  assert.equal(parse(JSON.stringify({ ok: true, visualize: { title: 'missing id' } })), null);
  const result = { ok: true, visualize: { cardId: 'card-2', title: 'Envelope' } };
  const mcp = { content: [{ type: 'text', text: JSON.stringify(result) }] };
  assert.deepEqual(parse(JSON.stringify(mcp)), result.visualize);
  assert.deepEqual(parse({ type: 'gui:tool', output: JSON.stringify(mcp) }), result.visualize);
});

test('a conversation stops accepting cards at the per-conversation cap', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-cap-'));
  t.after(() => removeTree(root));
  const store = createVisualizeStore({ dir: root });
  for (let index = 0; index < MAX_CARDS_PER_CONVERSATION; index++)
    store.create('conversation-1', { title: 'Card ' + index, fragment: '<div>' + index + '</div>' });
  assert.equal(store.cards('conversation-1').length, MAX_CARDS_PER_CONVERSATION);
  assert.throws(() => store.create('conversation-1', {
    title: 'One too many', fragment: '<div>overflow</div>',
  }), /already has/);
});

test('the card index tracks revisions and drops deleted entries', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-index-'));
  t.after(() => removeTree(root));
  const store = createVisualizeStore({ dir: root });
  const first = store.create('conversation-1', { title: 'Indexed', createdAt: 1000, fragment: '<div>one</div>' });
  assert.deepEqual(store.cards('conversation-1').map(card => card.cardId), [first.cardId]);
  const second = store.create('conversation-1', { title: 'Indexed', createdAt: 2000, fragment: '<div>other</div>' });
  store.update('conversation-1', first.cardId, { oldStr: 'one', newStr: 'two', updatedAt: 3000 });
  store.update('conversation-1', first.cardId, { title: 'Renamed', updatedAt: 4000 });
  const indexPath = path.join(root, 'conversation-1', 'index.json');
  const oldIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  oldIndex.version = 1;
  for (const card of oldIndex.cards) delete card.createdAt;
  fs.writeFileSync(indexPath, JSON.stringify(oldIndex));
  const rebuilt = new Map(store.cards('conversation-1').map(card => [card.cardId, card]));
  assert.equal(rebuilt.size, 2);
  assert.equal(rebuilt.get(first.cardId).revision, 3);
  assert.equal(rebuilt.get(first.cardId).createdAt, 1000);
  assert.equal(rebuilt.get(second.cardId).createdAt, 2000);
  assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).version, 2);
  const indexed = store.cards('conversation-1', { includeRevisions: true });
  assert.deepEqual(indexed.find(card => card.cardId === first.cardId).revisions.map(card => card.revision), [2, 1]);
  assert.deepEqual(indexed.find(card => card.cardId === second.cardId).revisions, []);
  const older = store.getRevision('conversation-1', first.cardId, 2);
  assert.equal(older.title, 'Indexed');
  assert.equal(older.updatedAt, 3000);
  assert.equal(older.html, '<div>two</div>');
  assert.equal(store.getRevision('conversation-1', first.cardId, 1).html, '<div>one</div>');
  assert.equal(store.get('conversation-1', first.cardId).title, 'Renamed');
  assert.throws(() => store.getRevision('conversation-1', first.cardId, 77), /unavailable/);
  store.removeCard('conversation-1', first.cardId);
  assert.deepEqual(store.cards('conversation-1').map(card => card.cardId), [second.cardId]);
  assert.equal(fs.existsSync(path.join(root, 'conversation-1', first.cardId + '.html')), false);
  assert.equal(fs.existsSync(path.join(root, 'conversation-1', first.cardId + '.revisions')), false);
});

test('an external edit to a card file is reported instead of hidden', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-external-'));
  t.after(() => removeTree(root));
  const store = createVisualizeStore({ dir: root });
  const card = store.create('conversation-1', { title: 'Guarded', fragment: '<div>original</div>' });
  assert.equal(store.get('conversation-1', card.cardId).externalEdit, false);
  fs.writeFileSync(path.join(root, 'conversation-1', card.cardId + '.html'), '<div>edited outside</div>');
  assert.equal(store.get('conversation-1', card.cardId).externalEdit, true);
  store.update('conversation-1', card.cardId, { oldStr: 'edited outside', newStr: 'restored' });
  assert.equal(store.get('conversation-1', card.cardId).externalEdit, false);
  assert.deepEqual(store.cards('conversation-1', { includeRevisions: true })[0].revisions, []);
});

test('deleting one card frees its slot and leaves the others intact', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-delete-'));
  t.after(() => removeTree(root));
  const store = createVisualizeStore({ dir: root });
  const kept = store.create('conversation-1', { title: 'Keep', fragment: '<div>keep</div>' });
  const removed = store.create('conversation-1', { title: 'Remove', fragment: '<div>remove</div>' });
  store.setState('conversation-1', removed.cardId, { page: 4 });
  const result = store.removeCard('conversation-1', removed.cardId);
  assert.deepEqual(result, { ok: true, cardId: removed.cardId });
  assert.deepEqual(store.cards('conversation-1').map(card => card.cardId), [kept.cardId]);
  for (const suffix of ['.html', '.json', '.state.json'])
    assert.equal(fs.existsSync(path.join(root, 'conversation-1', removed.cardId + suffix)), false, suffix);
  assert.equal(store.get('conversation-1', kept.cardId).title, 'Keep');
  assert.throws(() => store.get('conversation-1', removed.cardId), /not found/);
});

test('visualize document exposes persistent state and structured actions', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/chat/visualize-card.js'), 'utf8'),
    { window, JSON, String, Number, Math, console, TextEncoder });
  const documentHtml = window.CamelliaVisualize.documentFor(
    { cardId: 'card-1', style: 'paper' }, '<div id="app">Hello</div>', 'light', { selected: 'coast' },
  );
  assert.match(documentHtml, /window\.camelliaVisualize/);
  assert.match(documentHtml, /"selected":"coast"/);
  assert.match(documentHtml, /camellia-visualize-action/);
  assert.match(documentHtml, /camellia-visualize-state/);
  const networkHtml = window.CamelliaVisualize.documentFor({
    cardId: 'card-2', style: 'paper',
    networkOrigins: ['https://media.example.com'], networkApproved: true,
  }, '<div>Network</div>', 'light', {});
  assert.match(networkHtml, /media-src[^;]*https:\/\/media\.example\.com/);
  assert.match(networkHtml, /networkAllowed=true/);
  assert.match(networkHtml, /camellia-visualize-network-request/);
});
