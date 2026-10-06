"""QClaw automatic credentials through real desktop IPC and a loopback gateway."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, encoding='utf-8')


def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError(driver.stderr.read())
    response = json.loads(line)
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response


bridge = """(() => {
  let onRouter = () => {}, onInsights = () => {};
  window.testEmitRouter = state => onRouter(state);
  window.testCall = async (method, payload) => {
    const response = await window.testRpc(method, payload);
    for (const event of response.events || []) {
      if (event.channel === 'dsh:api-router-state') onRouter(event.data);
      if (event.channel === 'dsh:provider-insights') onInsights(event.data);
    }
    return response.result;
  };
  window.dshDesktop = new Proxy({}, { get: (_, method) =>
    method === 'onApiRouterState' ? callback => onRouter = callback :
    method === 'onProviderInsights' ? callback => onInsights = callback :
    method.startsWith('on') ? () => () => {} : payload => window.testCall(method, payload)
  });
})();"""


try:
    rpc('startTestUpstream')
    rpc('configureTestQclaw', {'enabled': False})
    port = rpc('freePort')['result']
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=providers')
        page.wait_for_load_state('networkidle')
        page.locator('#port').fill(str(port))
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('qclaw')
        page.locator('#confirmAdd').click()
        expect(page.locator('#addKey')).to_be_hidden()
        expect(page.locator('#showImport')).to_be_hidden()
        expect(page.locator('#keyRows input')).to_have_count(0)
        page.locator('#verifyModel').select_option('openclaw/main')
        page.locator('#verifyNow').click()
        expect(page.locator('#status')).to_contain_text('QClaw gateway was not found')
        page.locator('#discoverModels').click()
        expect(page.locator('#status')).to_contain_text('QClaw gateway was not found')
        expect(page.locator('#status')).not_to_contain_text('Save this key first')
        expect(page.locator('#modelDialog')).to_be_hidden()
        rpc('configureTestQclaw')
        page.evaluate("async () => window.testEmitRouter(await window.testCall('apiRouterGetState'))")
        page.locator('#verifyNow').click()
        expect(page.locator('#status')).to_contain_text('Validation succeeded for openclaw/main')
        expect(page.locator('[data-key-card="qclaw-auto"]')).to_have_count(1)
        expect(page.locator('[data-badge="qclaw-auto"]')).to_have_text('Model verified')
        page.locator('#discoverModels').click()
        expect(page.locator('#modelDialog')).to_be_visible()
        expect(page.locator('#catalogList input')).to_have_count(2)
        page.locator('#modelDialog .dialog-head button').click()
        page.locator('[data-verify="qclaw-auto"]').click()
        expect(page.locator('#status')).to_contain_text('Validation succeeded for openclaw/main')
        page.locator('#pName').fill('QClaw renamed')
        page.locator('#pName').blur()
        page.wait_for_function('!isDirty()')
        expect(page.locator('[data-key-card="qclaw-auto"]')).to_have_count(1)
        state = page.evaluate("window.testCall('apiRouterGetState')")
        assert [key['id'] for key in state['providers'][0]['keys']] == ['qclaw-auto']
        assert 'test-qclaw-token' not in page.locator('body').inner_text()
        screenshot_dir = repo / 'dist/ui-preview'
        screenshot_dir.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot_dir / 'settings-qclaw.png'), full_page=True)
        page.set_viewport_size({'width': 560, 'height': 900})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(screenshot_dir / 'settings-qclaw-compact.png'), full_page=True)
        page.set_viewport_size({'width': 1100, 'height': 900})

        rpc('configureTestQclaw', {'token': 'rotated-qclaw-token'})
        page.evaluate("async () => window.testEmitRouter(await window.testCall('apiRouterGetState'))")
        page.locator('#verifyNow').click()
        expect(page.locator('#status')).to_contain_text('Validation succeeded for openclaw/main')
        page.locator('#discoverModels').click()
        expect(page.locator('#modelDialog')).to_be_visible()
        page.locator('#modelDialog .dialog-head button').click()
        assert 'rotated-qclaw-token' not in page.locator('body').inner_text()

        rpc('configureTestQclaw', {'token': 'restarted-qclaw-token'})
        page.evaluate("async () => window.testEmitRouter(await window.testCall('apiRouterGetState'))")
        expect(page.locator('[data-key-card="qclaw-auto"]')).to_have_count(1)
        page.locator('#verifyNow').click()
        expect(page.locator('#status')).to_contain_text('Validation succeeded for openclaw/main')
        page.reload(wait_until='networkidle')
        page.locator('#providers button[data-select]').first.click()
        expect(page.locator('#pName')).to_have_value('QClaw renamed')
        expect(page.locator('[data-key-card="qclaw-auto"]')).to_have_count(1)
        expect(page.locator('#keyRows input')).to_have_count(0)
        page.locator('#verifyModel').select_option('openclaw/main')
        page.locator('#verifyNow').click()
        expect(page.locator('#status')).to_contain_text('Validation succeeded for openclaw/main')
        assert not errors, errors
        browser.close()
    print('PASS QClaw: automatic key, catalog, verification, edits, rotation, unavailable gateway, restart and reload')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
