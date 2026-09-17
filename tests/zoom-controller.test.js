'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createZoomController, readLegacyZoom } = require('../src/main/zoom-controller');
const { readJson, writeJson } = require('../src/shared/json-store');

function content() {
  let level = 0;
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, getZoomLevel: () => level, setZoomLevel: next => { level = next; } });
}
test('keyboard and wheel persist one zoom level across pages, windows and controller restarts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-zoom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'desktop.json');
  writeJson(file, { mode: 'claude', theme: 'dark' });
  const options = { loadConfig: () => readJson(file, {}), saveConfig: patch => writeJson(file, { ...readJson(file, {}), ...patch }), legacyLevel: 1.5 };
  const zoom = createZoomController(options), main = content(), settings = content();
  zoom.attach(main); zoom.attach(settings);
  let prevented = 0;
  main.emit('before-input-event', { preventDefault: () => prevented++ }, { type: 'keyDown', control: true, shift: true, key: '+' });
  assert.equal(prevented, 1); assert.equal(main.getZoomLevel(), 2); assert.equal(settings.getZoomLevel(), 2);
  main.setZoomLevel(0); main.emit('did-navigate'); assert.equal(main.getZoomLevel(), 2);
  zoom.adjust(-1); assert.equal(readJson(file).zoomLevel, 1.5);
  assert.equal(readJson(file).theme, 'dark');
  const restarted = createZoomController({ ...options, legacyLevel: 3 });
  const reopened = content(); restarted.attach(reopened); assert.equal(reopened.getZoomLevel(), 1.5);
  reopened.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', meta: true, key: '0' });
  assert.equal(readJson(file).zoomLevel, 0);
});
test('an attached surface can keep a fixed zoom offset across zoom changes and navigation', () => {
  const zoom = createZoomController({ loadConfig: () => ({}), saveConfig: () => {} });
  const host = content(), embedded = content();
  zoom.attach(host); zoom.attach(embedded, -1);
  assert.equal(embedded.getZoomLevel(), -1);
  assert.equal(host.getZoomLevel(), 0);
  zoom.set(1.5);
  assert.equal(embedded.getZoomLevel(), 0.5);
  embedded.setZoomLevel(3); embedded.emit('dom-ready');
  assert.equal(embedded.getZoomLevel(), 0.5);
  assert.equal(zoom.factorAt(-1), 1.2 ** 0.5);
  zoom.set(-100);
  assert.equal(embedded.getZoomLevel(), zoom.level, 'Offsets clamp at the minimum zoom level');
});

test('legacy migration uses only the selected page and never rewrites Chromium preferences', t => {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-zoom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Preferences');
  writeJson(file, { partition: { per_host_zoom_levels: { partition: { 'file:///selected': 1.5, 'file:///other': 4, 'bad': '2' } } } });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(readLegacyZoom(file, ['missing', 'file:///selected']), 1.5);
  assert.equal(readLegacyZoom(file, ['bad', 'unrelated']), undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('unmodified typing is ignored and invalid values cannot poison the saved scale', () => {
  let saved = {};
  const zoom = createZoomController({ loadConfig: () => ({ zoomLevel: 'invalid' }), saveConfig: patch => { saved = patch; } });
  const wc = content(); zoom.attach(wc);
  const event = { preventDefault() { throw new Error('Must not consume typing'); } };
  wc.emit('before-input-event', event, { type: 'keyDown', key: '+' });
  wc.emit('before-input-event', event, { type: 'keyDown', control: true, alt: true, key: '+' });
  wc.emit('before-input-event', event, { type: 'keyUp', control: true, key: '+' });
  assert.equal(zoom.level, 0);
  assert.throws(() => zoom.set(NaN), /Invalid/); assert.throws(() => zoom.adjust(0), /Invalid/);
  zoom.set(100); assert.ok(Math.abs(zoom.factor - 3) < 0.000001);
  zoom.set(-100); assert.ok(Math.abs(zoom.factor - 0.5) < 0.000001);
  assert.ok(Number.isFinite(saved.zoomLevel));
});
