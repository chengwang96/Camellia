"""The network advisory renders as the shared styled dialog, in both languages,
without native prompts and without letting a proxy address become markup."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')


def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError(driver.stderr.read())
    response = json.loads(line)
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response['result']

bridge = """(() => {
  const listeners = {};
  window.dshDesktop = new Proxy({}, { get: (_, method) => method.startsWith('on')
    ? fn => { listeners[method] = fn; }
    : async () => ({ ok: true }) });
  window.__emitNetworkHealth = payload => listeners.onNetworkHealth?.(payload);
})();"""

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 900, 'height': 700})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: (_ for _ in ()).throw(AssertionError('native dialog used: ' + d.type)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/home/home.html').as_uri())
        page.wait_for_load_state('networkidle')

        expect(page.locator('dialog.network-notice')).to_have_count(0)
        page.evaluate("() => __emitNetworkHealth({ degraded: true, proxy: '<img src=x onerror=alert(1)>http://127.0.0.1:14128' })")
        notice = page.locator('dialog.network-notice')
        expect(notice).to_be_visible()
        expect(notice.locator('.notice-badge svg')).to_have_count(1)
        expect(notice.locator('h2')).to_have_text('System proxy unavailable')
        expect(notice.locator('#networkNoticeMode')).to_contain_text('Auto')
        # The address is rendered as text, so it can never become markup.
        expect(notice.locator('#networkNoticeProxy')).to_contain_text('<img src=x onerror=alert(1)>')
        assert page.locator('dialog.network-notice img').count() == 0
        expect(notice.locator('#networkNoticeOpen')).to_be_visible()
        expect(notice.locator('#networkNoticeClose')).to_have_text('Got it')

        # Chinese copy comes from the shared catalogue, not a hard-coded string.
        page.evaluate("() => window.CamelliaI18n.setLanguage('zh-CN')")
        expect(notice.locator('h2')).to_have_text('系统代理不可用')
        expect(notice.locator('#networkNoticeClose')).to_have_text('知道了')
        expect(notice.locator('#networkNoticeOpen')).to_have_text('打开网络设置')
        notice.locator('#networkNoticeClose').click()
        expect(notice).to_be_hidden()

        # The same proxy is not reported twice, but a new one still is.
        page.evaluate("() => __emitNetworkHealth({ degraded: true, proxy: '<img src=x onerror=alert(1)>http://127.0.0.1:14128' })")
        expect(notice).to_be_hidden()
        page.evaluate("() => __emitNetworkHealth({ degraded: true, proxy: 'http://127.0.0.1:9999' })")
        expect(notice).to_be_visible()
        expect(notice.locator('#networkNoticeProxy')).to_have_text('代理: http://127.0.0.1:9999')
        page.evaluate("() => __emitNetworkHealth({ degraded: false, proxy: 'http://127.0.0.1:9999' })")
        expect(notice).to_be_hidden()

        # A healthy proxy reports nothing.
        page.evaluate("() => __emitNetworkHealth({ degraded: false, proxy: 'http://127.0.0.1:7890' })")
        expect(notice).to_be_hidden()

        assert not errors, errors
        browser.close()
    print('PASS: network advisory renders the shared styled dialog, escapes the proxy address and follows the language')
finally:
    driver.terminate()
    driver.wait(timeout=5)

