'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { storeAttachmentsAsync, storeImagesAsync } = require('../src/main/remote/attachments');
const { removeTree } = require('./test-fs.cjs');

test('asynchronous attachment storage preserves bytes, metadata and per-file names', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-remote-async-'));
  t.after(() => removeTree(root));
  const directory = path.join(root, 'device-attachments');
  const files = await storeAttachmentsAsync({ directory, deviceId: 'device', requestId: 'request', entries: [
    { name: 'first.txt', data: Buffer.from('first 中文').toString('base64'), isImage: false },
    { name: 'second.md', data: Buffer.from('second 🙂').toString('base64'), isImage: false },
  ] });
  assert.deepEqual(files.map(file => file.name), ['first.txt', 'second.md']);
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'first 中文');
  assert.equal(fs.readFileSync(files[1].path, 'utf8'), 'second 🙂');

  const jpeg = Buffer.from([255, 216, 255, 217]);
  const images = await storeImagesAsync({ directory: path.join(root, 'mobile-images'), deviceId: 'device', requestId: 'images',
    images: [jpeg.toString('base64'), jpeg.toString('base64')] });
  assert.deepEqual(images.map(file => file.name), ['mobile-image-1.jpg', 'mobile-image-2.jpg']);
  for (const image of images) assert.deepEqual(fs.readFileSync(image.path), jpeg);
});

test('asynchronous attachment validation leaves no partial image write', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-remote-async-error-'));
  t.after(() => removeTree(root));
  const directory = path.join(root, 'mobile-images');
  const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
  await assert.rejects(storeImagesAsync({ directory, deviceId: 'device', requestId: 'invalid', images: [jpeg, Buffer.from('not a JPEG').toString('base64')] }), /JPEG image required/);
  assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], []);
});
