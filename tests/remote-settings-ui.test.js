'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const file of ['settings/api-settings.html', 'remote/remote.html']) {
  test(`${file} keeps connection details collapsed and pairing warning visible`, () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');
    const help = html.match(/<details class="mobile-help">([\s\S]*?)<\/details>/);
    assert.ok(help);
    assert.match(help[1], /<summary data-copy="connectionHelp">/);
    for (const key of ['network', 'footer', 'logout']) {
      assert.match(help[1], new RegExp(`data-copy="${key}"`));
    }
    assert.match(help[1], /id="(?:mobile-)?lifetime"/);
    const primary = html.replace(help[0], '');
    assert.match(primary, /<p[^>]*data-copy="scope"/);
    assert.match(primary, /<button[^>]*data-copy="generate"/);
    assert.match(primary, /id="(?:mobile-)?networkState"[^>]*role="status"/);
    assert.doesNotMatch(primary, /data-copy="(?:network|footer|logout)"/);
  });
}

test('settings navigation offers CLI devices directly below mobile access', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.html'), 'utf8');
  const nav = /<nav[\s\S]*?<\/nav>/.exec(html)[0];
  const order = [...nav.matchAll(/data-view="([a-z]+)"/g)].map(match => match[1]);
  assert.equal(order.at(-2), 'mobile');
  assert.equal(order.at(-1), 'devices');
  assert.match(nav, /<button data-view="devices" data-i18n>/);
  assert.match(html, /<section id="devicesPage" class="page" hidden>[\s\S]*?<div id="cliDevicesRoot"><\/div>/);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/devices\/devices\.css">/);
  assert.match(html, /<script src="\.\.\/devices\/devices-view\.js"><\/script>/);
  assert.match(html, /<script src="\.\.\/devices\/devices\.js"><\/script>/);
  const script = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.js'), 'utf8');
  assert.match(script, /devices: \["CLI devices"/);
  assert.match(script, /window\.cliDevicesUI\?\.setVisible\(next === 'devices'\)/);
  assert.match(script, /view === 'devices' \? window\.cliDevicesUI\?\.refresh\(\)/);
  assert.doesNotMatch(script, /showCliDevices|devicesSurface|openCliDevices\(\)/);
  const messages = fs.readFileSync(path.join(__dirname, '../src/shared/i18n-messages.js'), 'utf8');
  assert.match(messages, /"CLI devices": "CLI 设备"/);
});

test('the CLI devices page is ordinary DOM with prefixed ids and scoped styles', () => {
  const view = fs.readFileSync(path.join(__dirname, '../src/renderer/devices/devices-view.js'), 'utf8');
  assert.match(view, /const TEMPLATE = prefix =>/);
  assert.match(view, /host\.innerHTML = TEMPLATE\(embedded \? 'cli-' : ''\)/);
  assert.match(view, /id="\$\{prefix\}device"/);
  assert.match(view, /for="\$\{prefix\}prompt"/);
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/devices/devices.css'), 'utf8');
  for (const rule of css.split('\n').filter(line => line.includes('{'))) {
    if (/^@media/.test(rule.trim())) continue;
    assert.match(rule.trim(), /^\.cli-devices|^body\.cli-devices-standalone/, rule);
  }
  assert.doesNotMatch(css, /^body \{[^}]*grid-template/m);
  const page = fs.readFileSync(path.join(__dirname, '../src/renderer/devices/devices.html'), 'utf8');
  assert.match(page, /<div id="cliDevicesRoot"><\/div>/);
  assert.doesNotMatch(page, /id="device"/);
  const script = fs.readFileSync(path.join(__dirname, '../src/renderer/devices/devices.js'), 'utf8');
  assert.match(script, /const bridge = window\.camelliaDevices \|\| window\.dshDesktop\?\.camelliaDevices/);
  assert.match(script, /if \(embedded\) window\.cliDevicesUI = \{/);
  assert.doesNotMatch(script, /document\.querySelectorAll\('\[data-copy\]'\)/);
  // Classic scripts share one global scope in the settings document, so this file
  // must not declare anything at top level besides its IIFE.
  // Checkouts may use either line ending, so match both without assuming one.
  assert.match(script, /^'use strict';\r?\n\r?\n\/\/[\s\S]*?\(function \(\) \{\r?\n/);
  assert.match(script, /\r?\n\}\)\(\);\r?\n$/);
  assert.equal([...script.matchAll(/^\(function \(\) \{/gm)].length, 1);
});

test('CLI devices panel shares the mobile-access Tailscale identity and offers no duplicate disconnect', () => {
  const view = fs.readFileSync(path.join(__dirname, '../src/renderer/devices/devices-view.js'), 'utf8');
  assert.doesNotMatch(view, /networkStop/);
  assert.match(view, /data-copy="networkHint">[^<]*手机访问[^<]*登录一次/);
  const script = fs.readFileSync(path.join(__dirname, '../src/renderer/devices/devices.js'), 'utf8');
  assert.doesNotMatch(script, /network-stop/);
  const remote = fs.readFileSync(path.join(__dirname, '../src/renderer/remote/remote.js'), 'utf8');
  assert.match(remote, /CLI device connections will both disconnect/);
  assert.match(remote, /手机访问和 CLI 设备会同时断开/);
});
