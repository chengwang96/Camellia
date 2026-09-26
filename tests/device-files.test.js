'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { storeAttachments, decodeAttachments, MAX_TOTAL } = require('../src/main/remote/attachments');
const { readAttachment, createAttachmentTray, downloadName, saveDownload } = require('../src/main/remote/device-files');
const { removeTree } = require('./test-fs.cjs');

function directory(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-files-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  context.after(() => removeTree(root)); return root;
}
const attachment = (name = 'file.txt', text = 'payload') => ({ name, data: Buffer.from(text).toString('base64'), isImage: false });
function response(data, length = Buffer.byteLength(data)) {
  const stream = Readable.from([Buffer.from(data)]);
  stream.statusCode = 200; stream.headers = { 'content-length': String(length) }; return stream;
}

test('server attachment store validates all files first and writes only generated paths', context => {
  const root = directory(context), target = path.join(root, 'uploads');
  assert.throws(() => storeAttachments({ directory: target, deviceId: 'gui', requestId: 'request', entries: [attachment(), attachment('../escape')] }), /name/);
  assert.equal(fs.existsSync(target), false);
  const files = storeAttachments({ directory: target, deviceId: 'gui', requestId: 'request', entries: [attachment('notes.txt'), attachment('empty', '')] });
  assert.equal(files.length, 2);
  assert.equal(path.dirname(files[0].path), target);
  assert.match(path.basename(files[0].path), /^[a-f0-9]{64}\.txt$/);
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'payload');
  assert.equal(files[0].name, 'notes.txt');
  assert.throws(() => storeAttachments({ directory: target, deviceId: 'gui', requestId: 'request', entries: [attachment()] }), /EEXIST/);
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'payload');
});

test('attachment schema rejects raw paths, invalid base64, fake images and aggregate oversize', () => {
  for (const entry of [{ ...attachment(), path: '/private' }, { ...attachment(), data: 'YQ=' }, { ...attachment(), isImage: true }, attachment('bad\x1bname'), attachment('bad\\name')]) {
    assert.throws(() => decodeAttachments([entry]));
  }
  const data = Buffer.alloc(MAX_TOTAL / 2 + 1).toString('base64');
  assert.throws(() => decodeAttachments([{ ...attachment(), data }, { ...attachment(), data }]), /limit/);
  assert.throws(() => decodeAttachments(Array(10).fill(attachment())), /1 to 9/);
});

test('desktop attachment picker reads bounded files and converts images in main process', async context => {
  const root = directory(context), file = path.join(root, 'notes.txt'); fs.writeFileSync(file, 'text');
  const selected = await readAttachment(file, null);
  assert.deepEqual(selected, { name: 'notes.txt', data: Buffer.from('text').toString('base64'), size: 4, isImage: false });
  assert.equal(Object.hasOwn(selected, 'path'), false);
  const imageFile = path.join(root, 'photo.png'); fs.writeFileSync(imageFile, 'placeholder');
  let resized = false;
  const converted = await readAttachment(imageFile, { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 4096, height: 2048 }), resize: size => {
    assert.equal(size.width, 2048); resized = true; return { toJPEG: () => Buffer.from([255, 216, 255, 217]) };
  } }) });
  assert.equal(resized, true); assert.equal(converted.isImage, true); assert.equal(converted.name, 'photo.jpg');
  const huge = path.join(root, 'huge'); fs.writeFileSync(huge, ''); fs.truncateSync(huge, MAX_TOTAL + 1);
  await assert.rejects(readAttachment(huge, null), /8 MiB/);
});

test('attachment tray binds opaque tokens to a device and conversation and expires them', () => {
  let now = 0;
  const tray = createAttachmentTray({ now: () => now });
  const [file] = tray.add('server', 'chat', [{ ...attachment(), size: 7 }]);
  assert.equal(Object.hasOwn(file, 'data'), false);
  assert.equal(tray.resolve('server', 'chat', [file.id])[0].data, attachment().data);
  assert.throws(() => tray.resolve('other', 'chat', [file.id]), /another/);
  assert.throws(() => tray.resolve('server', 'other-chat', [file.id]), /another/);
  assert.throws(() => tray.resolve('server', 'chat', [file.id, file.id]), /1 to 9/);
  now = 31 * 60_000;
  assert.throws(() => tray.resolve('server', 'chat', [file.id]), /expired/);
});

test('download writes atomically and leaves previous destination intact on mismatch or cancellation', async context => {
  const root = directory(context), file = path.join(root, 'result.txt'); fs.writeFileSync(file, 'old');
  await assert.rejects(saveDownload({ file, response: response('short', 9), expectedSize: 9 }), /incomplete/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  await assert.rejects(saveDownload({ file, response: response('too long', 1), expectedSize: 1 }), /exceeded/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(saveDownload({ file, response: response('new'), expectedSize: 3, signal: abort.signal }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(root), ['result.txt']);
  assert.equal((await saveDownload({ file, response: response('new'), expectedSize: 3 })).size, 3);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(root), ['result.txt']);
  await saveDownload({ file, response: response(''), expectedSize: 0 });
  assert.equal(fs.statSync(file).size, 0);
});

test('in-flight download cancellation closes the response and removes partial files', async context => {
  const root = directory(context), file = path.join(root, 'out'); fs.writeFileSync(file, 'keep');
  const stream = new Readable({ read() {} }); stream.statusCode = 200; stream.headers = { 'content-length': '100' };
  const abort = new AbortController();
  const saving = saveDownload({ file, response: stream, expectedSize: 100, signal: abort.signal, onProgress: () => abort.abort() });
  stream.push(Buffer.from('partial'));
  await assert.rejects(saving);
  assert.equal(stream.destroyed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(root), ['out']);
});

test('download rejects server size/status changes and sanitizes suggested filenames', async context => {
  const root = directory(context), file = path.join(root, 'out');
  await assert.rejects(saveDownload({ file, response: response('a'), expectedSize: 2 }), /changed/);
  const denied = response('a'); denied.statusCode = 403;
  await assert.rejects(saveDownload({ file, response: denied, expectedSize: 1 }), /unavailable/);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(downloadName('../../report\x1b.txt'), '.._.._report_.txt');
  assert.equal(downloadName('CON.txt'), 'artifact');
  assert.equal(downloadName(''), 'artifact');
});
