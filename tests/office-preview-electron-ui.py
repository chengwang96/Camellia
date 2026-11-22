"""Real Electron/Worker Threads Office preview and editing without Word automation."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo_root = Path(__file__).resolve().parents[1]


def port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


if sys.platform == 'win32':
    executable = repo_root / 'node_modules/electron/dist/electron.exe'
elif sys.platform == 'darwin':
    executable = repo_root / 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
else:
    executable = repo_root / 'node_modules/electron/dist/electron'

with tempfile.TemporaryDirectory(prefix='camellia-office-electron-', ignore_cleanup_errors=True) as temporary:
    root = Path(temporary)
    app = root / 'app'
    home = root / 'home'
    app.mkdir()
    home.mkdir()
    (app / 'desktop-config.json').write_text(json.dumps({
        'port': 0, 'autoRefreshBalances': False, 'language': 'en', 'mode': 'home',
    }), encoding='utf-8')
    document = root / 'Worker preview.docx'
    body = ('<w:document xmlns:w="word"><w:body>'
            '<w:p><w:r><w:t>First</w:t></w:r></w:p>'
            '<w:p><w:r><w:t>Second</w:t></w:r></w:p>'
            '</w:body></w:document>')
    with zipfile.ZipFile(document, 'w') as archive:
        archive.writestr('word/document.xml', body)

    debug, control = port(), port()
    environment = {**os.environ, 'DISCUSSION_UI_TEST_ROOT': str(root),
                   'DISCUSSION_UI_NAVIGATION': '1', 'DISCUSSION_UI_CONTROL_PORT': str(control),
                   'DSH_HOME': str(root / 'dsh'), 'HOME': str(home),
                   'USERPROFILE': str(home), 'KIMI_CODE_HOME': str(home / '.kimi-code')}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    errors = []
    with (root / 'electron.log').open('w', encoding='utf-8') as log:
        process = subprocess.Popen([str(executable), str(repo_root / 'tests/discussion-ui-driver.cjs'),
                                    f'--remote-debugging-port={debug}'], cwd=repo_root, env=environment,
                                   stdout=log, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                assert process.poll() is None, (root / 'electron.log').read_text(encoding='utf-8')
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{debug}/json/version', timeout=.5)
                    break
                except OSError:
                    time.sleep(.15)
            else:
                raise AssertionError('Electron debugging endpoint did not start')
            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{debug}')
                context = browser.contexts[0]
                page = context.pages[0] if context.pages else context.wait_for_event('page', timeout=30000)
                page.on('pageerror', lambda error: errors.append(error.stack or str(error)))
                page.set_viewport_size({'width': 1280, 'height': 900})
                page.goto((repo_root / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
                page.wait_for_function('uiReady')
                page.evaluate('path => openFilePreview(path)', str(document))
                preview = page.locator('body > .app > #fileViewer')
                expect(preview.locator('iframe.file-preview-office-document')).to_be_visible(timeout=30000)
                preview.get_by_role('button', name='Edit', exact=True).click()
                blocks = preview.locator('.file-preview-word-block textarea')
                expect(blocks).to_have_count(2)
                expect(blocks.nth(0)).to_have_value('First')
                expect(blocks.nth(1)).to_have_value('Second')
                blocks.nth(0).fill('Edited by worker')
                preview.get_by_role('button', name='Save', exact=True).click()
                expect(preview.locator('.file-preview-editor-status')).to_have_text('Saved', timeout=30000)
                preview.locator('.file-preview-editor-actions').get_by_role('button', name='Preview', exact=True).click()
                expect(preview.locator('iframe.file-preview-office-document')).to_be_visible(timeout=30000)
                with zipfile.ZipFile(document) as archive:
                    saved = archive.read('word/document.xml').decode('utf-8')
                assert 'Edited by worker' in saved
                assert 'Second' in saved
                assert not errors, errors
                urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
                assert process.wait(timeout=15) == 0
                browser.close()
        finally:
            if process.poll() is None:
                try:
                    urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
                    process.wait(timeout=15)
                except (OSError, subprocess.TimeoutExpired):
                    process.kill()
                    process.wait(timeout=5)
            log.flush()
            if process.returncode not in (0, None):
                print((root / 'electron.log').read_text(encoding='utf-8'), file=sys.stderr)

print('PASS: real Electron Office worker preview and editing')
