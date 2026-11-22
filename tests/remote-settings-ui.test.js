'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const file of ['settings/api-settings.html', 'remote/remote.html']) {
  test(`${file} keeps connection details collapsed and pairing progress accessible`, () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');
    const help = html.match(/<details class="mobile-help(?: device-help)?">([\s\S]*?)<\/details>/);
    assert.ok(help);
    assert.match(help[1], /<summary data-copy="connectionHelp">/);
    for (const key of ['network', 'footer', 'logout']) {
      assert.match(help[1], new RegExp(`data-copy="${key}"`));
    }
    assert.match(help[1], /id="(?:mobile-)?lifetime"/);
    const primary = html.replace(help[0], '');
    assert.match(html, /<button[^>]*data-copy="generate"/);
    assert.match(primary, /id="(?:mobile-)?networkState"[^>]*role="status"/);
    assert.match(primary, /id="(?:mobile-)?pairPending"[^>]*role="status"[^>]*hidden/);
    assert.match(primary, /id="(?:mobile-)?pair-success"[^>]*role="status"[^>]*hidden/);
    assert.match(primary, /data-copy="pairWaiting"/);
    assert.match(primary, /data-copy="pairSuccess"/);
    assert.doesNotMatch(primary, /data-copy="(?:network|footer|logout)"/);
    assert.match(primary, /id="(?:mobile-)?guardSection"[^>]*hidden/);
    assert.match(primary, /id="(?:mobile-)?guardToggle"[^>]*role="switch"/);
    assert.match(primary, /data-copy="guardHint"/);
    assert.match(primary, /id="(?:mobile-)?lanToggle"[^>]*role="switch"/);
    assert.match(primary, /id="(?:mobile-)?lanPin"[^>]*maxlength="6"/);
    assert.match(primary, /id="(?:mobile-)?lanAllowJoin"[^>]*role="switch"/);
  });
}

test('settings reserve their bottom inset outside the scroll range', () => {
  const settings = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.css'), 'utf8');
  assert.match(settings, /\.scroll-content \{ flex: 1; min-height: 0; overflow-y: auto; padding: 0 32px; \}/);
  assert.doesNotMatch(settings, /\.scroll-content[^}]*margin-bottom/);
  assert.doesNotMatch(settings, /padding: 0 32px 30px/);
  assert.match(settings, /#mobilePage \.mobile-page-actions:not\(:has\(> :not\(\[hidden\]\)\)\) \{ display: none; \}/);
  const surface = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/settings-surface.css'), 'utf8');
  assert.match(surface, /\.scroll-content \{ padding: 0 36px; scrollbar-width: none; \}/);
  assert.doesNotMatch(surface, /\.scroll-content[^}]*margin-bottom/);
  assert.doesNotMatch(surface, /\.scroll-content[^}]*padding-bottom/);
  assert.match(surface, /\.settings-main \.page > :nth-last-child\(1 of :not\(\[hidden\]\)\) \{ margin-bottom: 0; \}/);
  const remote = fs.readFileSync(path.join(__dirname, '../src/renderer/remote/remote.css'), 'utf8');
  assert.match(remote, /#error:empty \{ display: none; \}/);
  assert.match(remote, /main\.mobile-access \{ padding-bottom: 0; \}/);
  assert.match(remote, /main\.mobile-access > :last-child \{ margin-bottom: 0; \}/);
});

test('hidden accessible text stays inside the settings page', () => {
  const surface = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/settings-surface.css'), 'utf8');
  assert.match(surface, /\.page \{ position: relative; width: 100%; \}/);
  const devices = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/device-settings.css'), 'utf8');
  assert.match(devices, /\.device-settings \{ position: relative; display: grid; gap: 16px; min-width: 0; \}/);
  const remote = fs.readFileSync(path.join(__dirname, '../src/renderer/remote/remote.css'), 'utf8');
  assert.match(remote, /main\.mobile-access \{ position: relative; max-width: 900px; \}/);
});

test('authorized devices rename in place instead of opening a dialog', () => {
  const remote = fs.readFileSync(path.join(__dirname, '../src/renderer/remote/remote.js'), 'utf8');
  assert.doesNotMatch(remote, /dialog\.device-rename/);
  assert.match(remote, /function renameDevice\(entry, row, title, name\)/);
  assert.match(remote, /title\.replaceWith\(field\)/);
  const styles = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/device-settings.css'), 'utf8');
  assert.match(styles, /\.device-settings \.device-rename-field \{/);
  assert.doesNotMatch(styles, /dialog\.device-rename/);
});

test('the standalone mobile window exposes local-network controls without a second pairing form', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/remote/remote.html'), 'utf8');
  assert.match(html, /id="lanToggle"[^>]*role="switch"/);
  assert.match(html, /id="lanPin"[^>]*maxlength="6"/);
  assert.match(html, /id="lanSavePin"/);
  assert.match(html, /id="lanAllowJoin"[^>]*role="switch"/);
  assert.match(html, /data-copy="lanSecurity"/);
});
