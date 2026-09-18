"""Check the permission select renders Chinese labels when language is zh-CN."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')

def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError(driver.stderr.read())
    r = json.loads(line)
    if 'error' in r:
        raise RuntimeError(r['error'])
    return r

bridge = """(() => {
  const listeners = {};
  window.dshDesktop = new Proxy({}, { get: (_, method) => method.startsWith('on')
    ? fn => { listeners[method] = fn; }
    : async payload => (await window.testRpc(method, payload)).result
  });
})();"""

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 800})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri())
        page.wait_for_load_state('networkidle')
        before = page.locator('#selPermission option').all_text_contents()
        page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
        page.wait_for_timeout(200)
        after = page.locator('#selPermission option').all_text_contents()
        shown = page.locator('#selPermission').evaluate("el => el.selectedOptions[0].textContent")
        print('before:', before)
        print('after :', after)
        print('select shows:', shown)
        print('placeholder:', page.locator('#input').get_attribute('placeholder'))
        assert after == ['每步操作先问我', '常规自动，风险再问', '不再询问'], after
        assert not errors, errors
        print('PASS')
        browser.close()
finally:
    driver.kill()
