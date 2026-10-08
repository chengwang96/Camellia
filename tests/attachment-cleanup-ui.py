"""Real Electron draft collection and cleanup using isolated, synthetic data."""
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


with tempfile.TemporaryDirectory(prefix='attachment-cleanup-ui-', ignore_cleanup_errors=True) as temporary:
    root = Path(temporary)
    (root / 'app').mkdir()
    (root / 'home').mkdir()
    (root / 'app/desktop-config.json').write_text(json.dumps({'mode': 'home', 'port': 0, 'autoRefreshBalances': False, 'language': 'en'}), encoding='utf8')
    debug, control = port(), port()
    environment = {**os.environ, 'DISCUSSION_UI_TEST_ROOT': str(root), 'DISCUSSION_UI_NAVIGATION': '1', 'DISCUSSION_UI_RICH': '1',
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
            expect(page.locator('#openDiscussions')).to_be_visible(timeout=30000)
            page.wait_for_load_state('networkidle')
            page.locator('#openDiscussions').click()
            page.wait_for_function("() => document.querySelector('#discussionSurface')?.shadowRoot?.getElementById('firstGroup')?.onclick != null")
            page.locator('#firstGroup').click()
            page.locator('#title').fill('Cleanup draft fixture')
            page.locator('#createForm button[type=submit]').click()
            expect(page.locator('#groupTitle')).to_have_text('Cleanup draft fixture')
            original = root / 'evidence.txt'
            original.write_text('Preserved group draft', encoding='utf8')
            page.evaluate("""path => { const data = new DataTransfer(); data.setData('application/x-camellia-attachment-path', path);
              document.querySelector('#discussionSurface').shadowRoot.querySelector('#inputCard').dispatchEvent(new DragEvent('drop', {bubbles:true, dataTransfer:data})); }""", str(original))
            expect(page.locator('#attachRow .attchip')).to_have_count(1)
            draft = page.evaluate("() => { const key = Object.keys(localStorage).find(key => key.startsWith('camellia:discussion:draft:')); return {key, value: localStorage.getItem(key)}; }")
            copied = Path(json.loads(draft['value'])['attachments'][0]['path'])
            old = time.time() - 3 * 86400
            queued = root / 'app/remote/device-attachments' / ('c' * 64 + '.txt')
            queued.parent.mkdir(parents=True, exist_ok=True)
            queued.write_text('Another conversation local queue', encoding='utf8')
            os.utime(queued, (old, old))
            page.evaluate("file => localStorage.setItem('camellia-chat-queue:closed-conversation', JSON.stringify([{text:'Queued', attachments:[{path:file}]}]))", str(queued))
            os.utime(copied, (old, old))
            os.utime(copied.parent, (old, old))
            page.evaluate('key => localStorage.removeItem(key)', draft['key'])
            references = page.evaluate('() => window.CamelliaDiscussions.references()')
            assert str(copied) in json.dumps(references, ensure_ascii=False).replace('\\\\', '\\')
            preview = page.evaluate('() => window.dshDesktop.storageScan()')
            assert preview['ok'], preview
            assert not any(copied.parent.name in row['path'] for row in preview['candidates']), preview
            assert not any(queued.name in row['path'] for row in preview['candidates']), preview
            page.evaluate('draft => localStorage.setItem(draft.key, draft.value)', draft)
            page.reload()
            expect(page.locator('#attachRow .attchip')).to_have_count(1)
            assert page.evaluate('() => window.dshDesktop.storageScan()')['ok']
            page.goto((repo / 'src/renderer/discussions/discussions.html').as_uri())
            page.wait_for_load_state('networkidle')
            expect(page.locator('#attachRow .attchip')).to_have_count(1)
            orphan = root / 'app/remote/device-attachments' / ('a' * 64 + '.txt')
            orphan.parent.mkdir(parents=True, exist_ok=True)
            orphan.write_text('Unused remote copy', encoding='utf8')
            os.utime(orphan, (old, old))
            preview = page.evaluate('() => window.dshDesktop.storageScan()')
            assert preview['ok'], preview
            assert not any(copied.parent.name in row['path'] for row in preview['candidates']), preview
            assert any(orphan.name in row['path'] for row in preview['candidates']), preview
            result = page.evaluate('token => window.dshDesktop.storageClean(token)', preview['token'])
            assert result['ok'] and not result['errors'], result
            assert not orphan.exists() and copied.exists()
            assert queued.exists()
            page.locator('#attachRow .attchip-x').click()
            expect(page.locator('#attachRow .attchip')).to_have_count(0)
            deadline = time.monotonic() + 40
            while copied.exists() and time.monotonic() < deadline:
                page.wait_for_timeout(200)
            assert not copied.exists(), 'Removing a draft attachment must schedule an automatic idle pass'
            assert queued.exists() and original.exists()
            assert not errors, errors
            print('PASS: embedded/standalone drafts, inactive local queue, manual IPC and automatic cleanup after draft removal')
            browser.close()
    finally:
        try:
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
            process.wait(timeout=15)
        except Exception:
            process.kill()
            process.wait(timeout=5)
        output.close()
