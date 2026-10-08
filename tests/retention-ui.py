"""Verify backup retention through the real Electron settings UI on synthetic data."""
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]


def port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


with tempfile.TemporaryDirectory(prefix='retention-ui-', ignore_cleanup_errors=True) as temporary:
    root = Path(temporary)
    (root / 'app').mkdir()
    (root / 'home').mkdir()
    (root / 'app/desktop-config.json').write_text(json.dumps({'mode': 'home', 'port': 0, 'autoRefreshBalances': False, 'language': 'en'}), encoding='utf8')
    # Use the production completion writer, including filesystem timestamps.
    seed = r"""
    const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
    const { completeBackup } = require('./src/main/backup-retention');
    const root = process.argv[1], dataDir = path.join(root, 'app'), dirs = [];
    for (const age of [1, 2, 3, 40, 50]) {
      const time = Date.now() - age * 86400000, name = new Date(time).toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
      const directory = path.join(dataDir, 'migration-backups', name), file = path.join(directory, 'app/desktop-config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ previous: age }));
      if (age !== 50) completeBackup({ directory, header: { id: randomUUID(), createdAt: time }, begins: [{ rel: 'app/desktop-config.json' }] }, 'committed', time);
      fs.utimesSync(directory, time / 1000, time / 1000); dirs.push(directory);
    }
    fs.writeFileSync(path.join(root, 'fixture-dirs.json'), JSON.stringify(dirs));
    """
    subprocess.run(['node', '-e', seed, str(root)], cwd=repo, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    directories = [Path(value) for value in json.loads((root / 'fixture-dirs.json').read_text())]
    archive = root / 'app/user-export.zip'
    archive.write_text('User-owned export', encoding='utf8')
    original = root / 'app/desktop-config.json.workbench.bak'
    original.write_text('Original configuration', encoding='utf8')
    debug, control = port(), port()
    environment = {**os.environ, 'DISCUSSION_UI_TEST_ROOT': str(root), 'DISCUSSION_UI_NAVIGATION': '1',
                   'DISCUSSION_UI_CONTROL_PORT': str(control), 'DSH_HOME': str(root / 'dsh'), 'HOME': str(root / 'home'),
                   'USERPROFILE': str(root / 'home'), 'KIMI_CODE_HOME': str(root / 'home/.kimi-code')}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    output = open(root / 'electron.log', 'w', encoding='utf8')
    process = subprocess.Popen([str(repo / 'node_modules/electron/dist/electron.exe'), str(repo / 'tests/discussion-ui-driver.cjs'),
                                f'--remote-debugging-port={debug}'], cwd=repo, env=environment, stdout=output, stderr=output,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    errors = []
    try:
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError((root / 'electron.log').read_text(encoding='utf8'))
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{debug}/json/version', timeout=.5)
                break
            except OSError:
                time.sleep(.15)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{debug}')
            page = browser.contexts[0].pages[0]
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri())
            page.wait_for_load_state('networkidle')
            page.locator('[data-view=data]').click()
            expect(page.locator('#scanStorage')).to_be_enabled()
            page.locator('#scanStorage').click()
            expect(page.locator('#storageSummary')).to_contain_text('5 backups')
            expect(page.locator('#storageSummary')).to_contain_text('stored')
            expect(page.locator('#storageSummary')).to_contain_text('reclaimable')
            expect(page.locator('#storageSummary')).to_contain_text('Old import backups')
            expect(page.locator('#storageSummary')).to_contain_text('Legacy import backups')
            preview = page.evaluate('() => window.dshDesktop.storageScan()')
            assert preview['ok'] and preview['backups']['count'] == 5, preview
            assert preview['backups']['bytes'] > preview['backups']['reclaimableBytes'] > 0
            assert len(preview['candidates']) == 2, preview
            # Rescan through the page so its confirmation holds the latest token.
            page.evaluate("() => window.CamelliaI18n.setLanguage('zh-CN')")
            page.locator('#scanStorage').click()
            expect(page.locator('#storageSummary')).to_contain_text('5 份备份')
            expect(page.locator('#storageSummary')).to_contain_text('可回收')
            expect(page.locator('#storageSummary')).to_contain_text('过期的导入备份')
            screenshot = repo / 'dist/test-results/retention-ui-20261007.png'
            screenshot.parent.mkdir(parents=True, exist_ok=True)
            page.locator('#storageSection').screenshot(path=str(screenshot))
            page.locator('#cleanStorage').click()
            expect(page.locator('#cleanStorageDialog')).to_be_visible()
            page.locator('#confirmCleanStorage').click()
            expect(page.locator('#storageStatus')).to_contain_text('已删除')
            assert not directories[3].exists() and not directories[4].exists()
            assert all(directory.exists() for directory in directories[:3])
            assert archive.exists() and original.exists()
            # Add an expired point; restarting the idle timer must prune it without a manual scan.
            subprocess.run(['node', '-e', seed.replace('[1, 2, 3, 40, 50]', '[45]'), str(root)], cwd=repo, check=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
            idle = Path(json.loads((root / 'fixture-dirs.json').read_text())[0])
            page.evaluate('() => window.dshDesktop.storageReferencesChanged()')
            deadline = time.monotonic() + 40
            while idle.exists() and time.monotonic() < deadline:
                page.wait_for_timeout(200)
            assert not idle.exists(), 'Idle backup retention did not expire the old recovery point'
            assert all(directory.exists() for directory in directories[:3])
            assert not errors, errors
            print('PASS: real settings summary in English/Chinese, manual legacy/expired cleanup, newest protection and automatic idle retention')
            browser.close()
    finally:
        try:
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
            process.wait(timeout=15)
        except Exception:
            process.kill()
            process.wait(timeout=5)
        output.close()
