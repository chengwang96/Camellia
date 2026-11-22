'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');
const { wordBridgeAvailable, readDocSnapshot, exactDocParagraphs, saveDocEdit, convertDocToDocx, clearConvertedDocuments } = require('../src/main/doc-edit');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('legacy Word probing, conversion and editing wait asynchronously and preserve the save contract',
  { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-doc-async-'));
  t.after(() => { clearConvertedDocuments(); removeTree(root); });
  const file = path.join(root, 'legacy.doc');
  fs.writeFileSync(file, 'original document');
  const calls = [];
  let releaseProbe;
  t.mock.method(childProcess, 'execFile', (executable, args, options, callback) => {
    assert.equal(options.windowsHide, true);
    if (args[1] === 'import win32com.client') {
      releaseProbe = () => callback(null, '', '');
      return;
    }
    const request = JSON.parse(fs.readFileSync(args[3], 'utf8'));
    calls.push(request);
    setTimeout(() => {
      let copy = request.convert;
      if (copy) fs.writeFileSync(copy, 'converted document');
      else {
        copy = path.join(root, 'edited.doc');
        fs.writeFileSync(copy, 'edited document');
      }
      callback(null, JSON.stringify({ ok: true, copy, path: request.path,
        paragraphs: [{ text: 'First', editable: true }, { text: 'Second', editable: true }] }) + '\n', '');
    }, 25);
  });

  let availableSettled = false;
  const available = wordBridgeAvailable().then(value => { availableSettled = true; return value; });
  for (let index = 0; index < 40 && !releaseProbe; index++) await delay(5);
  assert.equal(availableSettled, false);
  assert.equal(typeof releaseProbe, 'function');
  releaseProbe();
  assert.equal(await available, true);

  const snapshot = await readDocSnapshot(file);
  let conversionSettled = false;
  const converting = convertDocToDocx(file).then(value => { conversionSettled = true; return value; });
  await delay(5);
  assert.equal(conversionSettled, false);
  const converted = await converting;
  assert.equal(fs.readFileSync(converted, 'utf8'), 'converted document');
  assert.deepEqual(await exactDocParagraphs(snapshot), ['First', 'Second']);

  const result = await saveDocEdit(snapshot, [{ index: 0, text: 'Changed' }]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'edited document');
  assert.deepEqual(result.paragraphs, ['Changed', 'Second']);
  assert.deepEqual(result.snapshot.paragraphs, ['Changed', 'Second']);
  assert.equal(result.snapshot.wordParagraphs, null);
  assert.equal(calls.filter(call => call.readOnly).length, 1);
  assert.equal(calls.some(call => call.convert), true);
  assert.equal(calls.some(call => call.edits.length === 1 && call.edits[0].text === 'Changed'), true);
});

test('concurrent conversion shares one Word task for the same file revision', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-doc-single-flight-'));
  t.after(() => { clearConvertedDocuments(); removeTree(root); });
  const file = path.join(root, 'shared.doc');
  fs.writeFileSync(file, 'shared source');
  let conversions = 0;
  t.mock.method(childProcess, 'execFile', (executable, args, options, callback) => {
    if (args[1] === 'import win32com.client') { callback(null, '', ''); return; }
    conversions++;
    const request = JSON.parse(fs.readFileSync(args[3], 'utf8'));
    setTimeout(() => {
      fs.writeFileSync(request.convert, 'shared conversion');
      callback(null, JSON.stringify({ ok: true, path: request.convert }), '');
    }, 30);
  });
  const [first, second] = await Promise.all([convertDocToDocx(file), convertDocToDocx(file)]);
  assert.equal(first, second);
  assert.equal(conversions, 1);
  assert.equal(fs.readFileSync(first, 'utf8'), 'shared conversion');
});

test('cancelling the last preview waiter aborts the Word process', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-doc-cancel-'));
  t.after(() => { clearConvertedDocuments(); removeTree(root); });
  const file = path.join(root, 'cancel.doc');
  fs.writeFileSync(file, 'cancel source');
  let processSignal;
  t.mock.method(childProcess, 'execFile', (executable, args, options, callback) => {
    if (args[1] === 'import win32com.client') { callback(null, '', ''); return; }
    processSignal = options.signal;
    options.signal.addEventListener('abort', () => {
      const error = new Error('cancelled'); error.name = 'AbortError'; error.code = 'ABORT_ERR';
      callback(error, '', '');
    }, { once: true });
  });
  const controller = new AbortController();
  const pending = convertDocToDocx(file, { signal: controller.signal });
  for (let index = 0; index < 100 && !processSignal; index++) await delay(5);
  assert.ok(processSignal);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(processSignal.aborted, true);
});
