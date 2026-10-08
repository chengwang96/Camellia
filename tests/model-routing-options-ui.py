"""Model routing switches through real IPC, with isolated settings and credentials."""
import json
import os
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
ui_root = Path(os.environ.get('CAMELLIA_UI_ROOT', repo))
driver_root = Path(os.environ.get('CAMELLIA_DRIVER_ROOT', repo))
artifacts = repo / 'artifacts/model-routing-options-20261007'
driver = subprocess.Popen(['node', str(driver_root / 'tests/claude-ui-driver.cjs')],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, encoding='utf-8')
fail_next_save = False


def rpc(method, payload=None):
    global fail_next_save
    if method == 'apiRouterSaveConfig' and fail_next_save:
        fail_next_save = False
        return {'result': {'ok': False, 'error': 'Test settings write failed'}}
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError(driver.stderr.read())
    result = json.loads(line)
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result


bridge = """(() => {
  window.dshDesktop = new Proxy({}, { get: (_, method) => method.startsWith('on')
    ? () => () => {} : async payload => (await window.testRpc(method, payload)).result });
})();"""


def wait_routing(page, concurrent, failover):
    page.wait_for_function("""async expected => {
      const state = await window.dshDesktop.apiRouterGetState();
      return state.routing?.multiKeyConcurrency === expected[0]
        && state.routing?.multiKeyFailover === expected[1];
    }""", arg=[concurrent, failover])


try:
    rpc('apiRouterSaveConfig', {'port': rpc('freePort')['result'], 'providers': [{
        'id': 'pool', 'name': 'Pool', 'type': 'custom', 'baseUrl': 'http://127.0.0.1:19099/v1',
        'models': [{'id': 'gpt-6-astra', 'upstream': 'gpt-6-astra'}],
        'keys': [{'id': 'key-one', 'key': 'test-only-key-one'}, {'id': 'key-two', 'key': 'test-only-key-two'}],
    }]})
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 920})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((ui_root / 'src/renderer/settings/api-settings.html').as_uri() + '?page=models')
        page.wait_for_load_state('networkidle')
        concurrent = page.locator('#multiKeyConcurrency')
        failover = page.locator('#multiKeyFailover')
        expect(concurrent).to_be_visible()
        expect(concurrent).to_be_enabled()
        expect(concurrent).to_be_checked()
        expect(failover).to_be_checked()
        concurrent.uncheck()
        wait_routing(page, False, True)
        failover.uncheck()
        wait_routing(page, False, False)

        # A provider edit shares autosave with these preferences.
        page.locator('[data-view="providers"]').click()
        page.locator('[data-select="pool"]').first.click()
        page.locator('#pName').fill('Renamed pool')
        page.locator('#pName').blur()
        page.wait_for_function("""async () => {
          const state = await window.dshDesktop.apiRouterGetState();
          return state.providers[0].name === 'Renamed pool';
        }""")
        page.locator('[data-view="models"]').click()
        page.reload()
        page.wait_for_load_state('networkidle')
        expect(concurrent).not_to_be_checked()
        expect(failover).not_to_be_checked()

        # Failed writes keep the user's selected values for a later retry.
        fail_next_save = True
        failover.check()
        expect(page.locator('#status')).to_have_text('Test settings write failed')
        expect(failover).to_be_checked()
        wait_routing(page, False, False)
        concurrent.check()
        wait_routing(page, True, True)
        assert page.evaluate('flushSave().then(() => !isDirty() && !lastSaveError)')
        concurrent.uncheck()
        failover.uncheck()
        wait_routing(page, False, False)
        assert page.evaluate('flushSave().then(() => !isDirty() && !lastSaveError)')

        page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
        expect(page.get_by_role('switch', name='多 Key 并发', exact=True)).to_be_visible()
        expect(page.get_by_role('switch', name='多 Key 自动切换', exact=True)).to_be_visible()
        artifacts.mkdir(parents=True, exist_ok=True)
        suffix = 'installed' if ui_root != repo else 'source'
        page.screenshot(path=str(artifacts / ('routing-options-' + suffix + '.png')), full_page=True)
        page.set_viewport_size({'width': 620, 'height': 920})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(artifacts / ('routing-options-' + suffix + '-narrow.png')), full_page=True)
        assert errors == [], errors
        browser.close()
    print('PASS routing options UI: defaults, independent saves, provider edits, reload, failed-save retry and Chinese labels')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
