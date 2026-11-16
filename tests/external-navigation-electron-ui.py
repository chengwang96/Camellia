import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.request import urlopen

import fitz
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
root = Path(tempfile.mkdtemp(prefix='camellia-navigation-')).resolve()
artifacts = repo / 'dist/ui-preview/external-navigation'
artifacts.mkdir(parents=True, exist_ok=True)
target = 'https://s.taobao.com/search?q=TCT40-16T'
pdf = fitz.open()
for number in range(2):
    page = pdf.new_page(width=612, height=792)
    page.insert_text((40, 55), f'Camellia PDF external-link regression, page {number + 1}', fontsize=16)
    area = fitz.Rect(40, 180, 572, 680)
    page.draw_rect(area, color=(0.1, 0.4, 0.6), fill=(0.9, 0.95, 0.98))
    page.insert_text((70, 350), 'Click this area to open the product in a browser', fontsize=14)
    page.insert_link({'kind': fitz.LINK_URI, 'from': area, 'uri': target})
pdf.save(root / 'links.pdf')
pdf.close()
renderer = (repo / 'src/renderer/shared/file-preview-panel.js').as_uri()
(root / 'host.html').write_text('''<!doctype html><meta charset="utf-8"><title>Camellia PDF navigation test</title>
<style>body{margin:0;font:14px sans-serif}header{height:44px;padding:8px;box-sizing:border-box}a{margin-right:24px}
#fileViewer{height:840px}#fileViewerBody{height:780px}iframe{width:100%;height:100%;border:0}#fileViewerMeta{font-size:11px}</style>
<header><a id="same" href="https://example.com/same">Same-tab link</a>
<a id="blank" href="https://example.com/new" target="_blank">New-tab link</a>
<a id="anchor" href="#local">Local anchor</a><span id="local">App stays here</span></header>
<aside id="fileViewer"><div id="fileViewerTitle"></div><div id="fileViewerMeta"></div><span id="fileViewerType"></span>
<button id="fileViewerClose">Close</button><button id="fileViewerExternal">Open externally</button>
<button id="fileViewerReveal">Reveal</button><div id="fileViewerBody"></div></aside><div id="inputCard"></div>
<script>window.CamelliaI18n={t:value=>value};</script><script src="RENDERER"></script>
<script>window.preview=CamelliaFilePreview.create({fileViewer:document.getElementById('fileViewer'),
inputCard:document.getElementById('inputCard'),mdRender:value=>value,setStatus:console.error});
window.previewReady=preview.openFilePreview(PDF);</script>'''.replace('RENDERER', renderer).replace('PDF', json.dumps(str(root / 'links.pdf'))), encoding='utf-8')

def wait(check, label, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError('Timed out: ' + label)

def read_json(file):
    try:
        return json.loads(file.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None

env = dict(os.environ, CAMELLIA_NAVIGATION_TEST_ROOT=str(root))
env.pop('ELECTRON_RUN_AS_NODE', None)
electron = subprocess.check_output(['node', '-p', "require('electron')"], cwd=repo, text=True).strip()
process = None
control = None
try:
    # This child is owned by the foreground test and always closed in finally;
    # no detached service, visible window or real browser tab is launched.
    with (root / 'electron.log').open('w', encoding='utf-8') as log:
        process = subprocess.Popen([electron, str(repo / 'tests/fixtures/external-navigation-host.cjs')], cwd=repo,
                                   env=env, stdout=log, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        ready = wait(lambda: read_json(root / 'ready.json'), 'Electron fixture readiness')
        control = ready['control']
        port_file = root / 'profile/DevToolsActivePort'
        wait(lambda: port_file.exists(), 'Electron DevTools port')
        port = port_file.read_text(encoding='utf-8').splitlines()[0]

        def request(route):
            with urlopen(control + route, timeout=15) as response:
                return json.load(response)

        def state():
            return request('/state')

        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp('http://127.0.0.1:' + port)
            context = browser.contexts[0]
            page = wait(lambda: next((p for p in context.pages if p.url.startswith((root / 'host.html').as_uri())), None), 'app page')
            page.wait_for_load_state('networkidle')
            expect(page.locator('#fileViewerBody iframe')).to_be_visible()
            page.evaluate('window.previewReady')
            # Discover the real Chromium PDF frame before acting on its contents.
            wait(lambda: any('chrome-extension://' in url for url in state()['frames']), 'native PDF viewer')
            page.screenshot(path=str(artifacts / 'before.png'))
            request('/pdf-prepare')
            wait(lambda: request('/pdf-state').get('page') == 1, 'PDF page two')
            pdf_before = request('/pdf-state')
            assert abs(pdf_before['zoom'] - 1.21) < .0001, pdf_before
            assert pdf_before['position']['y'] > 0, pdf_before
            initial = state()
            app_url = initial['url']
            # Cache the real DOM positions before navigating. Electron cancels
            # these navigations, but CDP can retain a scheduled-navigation marker
            # that makes Playwright's locator auto-wait hang after a valid click.
            controls = {name: page.locator('#' + name).bounding_box() for name in ['same', 'blank', 'anchor']}
            assert all(controls.values())
            # Electron's offscreen OOPIF PDF plugin does not receive pointer
            # events. Invoke its actual browser navigation delegate (the
            # annotation handler's final path), not a mocked Electron event.
            assert request('/pdf-navigate')['ok']
            wait(lambda: len(state()['opened']) == 1, 'native PDF external-link navigation')
            result = state()
            assert result['opened'][-1] == target, result
            assert result['url'] == app_url, result
            assert any(url.endswith('/links.pdf') for url in result['frames']), result
            assert any(url.startswith('chrome-extension://') for url in result['frames']), result
            assert page.evaluate('document.querySelector("#fileViewerTitle").textContent') == 'links.pdf'
            assert request('/pdf-state') == pdf_before, 'PDF page, scroll position or zoom changed'
            page.screenshot(path=str(artifacts / 'after-pdf-link.png'))

            for name, url in [('same', 'https://example.com/same'), ('blank', 'https://example.com/new')]:
                box = controls[name]
                page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
                wait(lambda: state()['opened'][-1] == url, name + ' external link')
                assert state()['url'] == app_url
            assert state()['opened'] == [target, 'https://example.com/same', 'https://example.com/new']
            assert len(context.pages) == 1
            box = controls['anchor']
            page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
            wait(lambda: state()['url'].endswith('#local'), 'in-page anchor')
            assert len(state()['opened']) == 3
            # App-owned page changes still work via the production loadFile path.
            assert request('/reload')['ok']
            page.wait_for_url('**?mode=reloaded')
            page.wait_for_load_state('networkidle')
            expect(page.locator('#fileViewerTitle')).to_have_text('links.pdf')
            assert state()['failures'] == [], state()['failures']
            summary = {'pass': True, 'opened': state()['opened'], 'appURL': state()['url'],
                       'nativePDFFilesRemainOpen': True, 'programmaticNavigation': True,
                       'pdfStatePreserved': pdf_before,
                       'navigationEvents': state()['navigations']}
            (artifacts / 'result.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
            print(json.dumps(summary))
            request('/quit')
            process.wait(timeout=10)
            assert process.returncode == 0
            browser.close()
except Exception:
    if control:
        try:
            with urlopen(control + '/state', timeout=3) as response:
                (artifacts / 'failure-state.json').write_text(json.dumps(json.load(response), indent=2), encoding='utf-8')
        except OSError:
            pass
    if (root / 'electron.log').exists():
        print((root / 'electron.log').read_text(encoding='utf-8', errors='replace')[-6000:])
    raise
finally:
    if process is not None and process.poll() is None:
        if control:
            try:
                with urlopen(control + '/quit', timeout=3) as response:
                    response.read()
            except OSError:
                pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    if (root / 'electron.log').exists():
        shutil.copyfile(root / 'electron.log', artifacts / 'electron.log')
    assert root.parent == Path(tempfile.gettempdir()).resolve()
    assert root.name.startswith('camellia-navigation-')
    shutil.rmtree(root, ignore_errors=True)
