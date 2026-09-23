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
