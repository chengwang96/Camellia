"""Actual Electron/main/preload with an isolated profile; no model requests."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
output = repo / 'dist/ui-preview'
output.mkdir(parents=True, exist_ok=True)
source = r'''# Desktop formula verification

Inline $E=mc^2$ and \(\alpha+\beta\).

$$\text{price: \$5} + \frac{1}{2}$$

> \[
> \begin{aligned}
> a &= b \\
> c &= d
> \end{aligned}
> \]

\[\begin{pmatrix}1&0\\[2pt]0&1\end{pmatrix}\]

| Equation | Value |
| --- | --- |
| \(\lvert x\rvert\) | $x^2$ |

    $$literal$$
'''


def port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


if sys.platform == 'win32':
    executable = repo / 'node_modules/electron/dist/electron.exe'
elif sys.platform == 'darwin':
    executable = repo / 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
else:
    executable = repo / 'node_modules/electron/dist/electron'

metrics, errors, failed_resources = [], [], []
with tempfile.TemporaryDirectory(prefix='desktop-math-', ignore_cleanup_errors=True) as temporary:
    root = Path(temporary)
    (root / 'app').mkdir()
    (root / 'home').mkdir()
    (root / 'app/desktop-config.json').write_text(json.dumps({
        'port': 0, 'autoRefreshBalances': False, 'language': 'en', 'mode': 'home',
    }), encoding='utf-8')
    debug, control = port(), port()
    environment = {**os.environ, 'DISCUSSION_UI_TEST_ROOT': str(root),
                   'DISCUSSION_UI_NAVIGATION': '1', 'DISCUSSION_UI_CONTROL_PORT': str(control),
                   'DSH_HOME': str(root / 'dsh'), 'HOME': str(root / 'home'),
                   'USERPROFILE': str(root / 'home'), 'KIMI_CODE_HOME': str(root / 'home/.kimi-code')}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    with (root / 'electron.log').open('w', encoding='utf-8') as log:
        process = subprocess.Popen([str(executable), str(repo / 'tests/discussion-ui-driver.cjs'),
                                    f'--remote-debugging-port={debug}'], cwd=repo, env=environment,
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
                expect(page.locator('#openDiscussions')).to_be_visible(timeout=30000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('requestfailed', lambda request: failed_resources.append(request.url)
                        if 'katex' in request.url.lower() or 'markdown-math' in request.url else None)
                page.set_viewport_size({'width': 1440, 'height': 1100})
                page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
                page.wait_for_function('uiReady')
                for theme in ['light', 'dark']:
                    page.emulate_media(color_scheme=theme)
                    for surface in ['chat', 'preview', 'discussion']:
                        result = page.evaluate('''({surface, text}) => {
                            chat.replaceChildren();
                            const turn = document.createElement('div'); turn.className = 'turn';
                            const area = document.createElement('div'); area.className = 'md'; turn.append(area); chat.append(turn);
                            if (surface === 'chat') area.innerHTML = mdRender(text);
                            else if (surface === 'preview') area.innerHTML = CamelliaMarkdownPreview.render(text);
                            else area.append(CamelliaMarkdown.render(document, text));
                            return {math:area.querySelectorAll('.katex').length, display:area.querySelectorAll('.katex-display').length,
                                errors:area.querySelectorAll('.katex-error').length, code:[...area.querySelectorAll('pre code')].map(node=>node.textContent),
                                annotations:[...area.querySelectorAll('annotation')].map(node=>node.textContent)};
                        }''', {'surface': surface, 'text': source})
                        assert result['math'] == 7 and result['display'] == 3 and result['errors'] == 0, result
                        assert any(value.strip() == '$$literal$$' for value in result['code']), result
                        assert all('>' not in value and '<br>' not in value for value in result['annotations']), result
                        fonts = page.evaluate('''async () => {
                            await document.fonts.ready;
                            return [...document.fonts].filter(font => font.family.startsWith('KaTeX')).map(font => ({family:font.family,status:font.status}));
                        }''')
                        assert any(font['status'] == 'loaded' for font in fonts) and not any(font['status'] == 'error' for font in fonts)
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                        page.screenshot(path=str(output / f'desktop-math-{sys.platform}-{surface}-{theme}.png'), animations='disabled')
                        metrics.append({'theme': theme, 'surface': surface, **result, 'fonts': fonts})
                assert not errors and not failed_resources, (errors, failed_resources)
                browser.close()
        finally:
            try:
                urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
                process.wait(timeout=15)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=5)
            log.flush()
            (output / f'desktop-math-{sys.platform}-electron.log').write_text((root / 'electron.log').read_text(encoding='utf-8'), encoding='utf-8')
(output / f'desktop-math-{sys.platform}-metrics.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Electron {sys.platform}: {len(metrics)} light/dark surface checks and local KaTeX fonts passed.')
