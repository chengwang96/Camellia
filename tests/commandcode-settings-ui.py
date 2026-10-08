"""Command Code endpoint normalization and verification through real desktop IPC."""
import json
import subprocess
from pathlib import Path
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
    result = json.loads(line)
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result


bridge = """(() => {
  let hold = null;
  window.testHoldSave = () => {
    window.testSaveStarted = false;
    hold = new Promise(resolve => { window.testReleaseSave = resolve; });
  };
  window.dshDesktop = new Proxy({}, { get: (_, method) => method.startsWith('on')
    ? () => () => {} : async payload => {
      if (method === 'apiRouterSaveConfig' && hold) {
        const waiting = hold; hold = null; window.testSaveStarted = true; await waiting;
      }
      return (await window.testRpc(method, payload)).result;
    } });
})();"""


def fill(page, selector, value):
    page.locator(selector).fill(value)
    page.locator(selector).blur()


try:
    port = rpc('freePort')['result']
    upstream = rpc('startTestUpstream')['result']
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1040, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri())
        page.wait_for_load_state('networkidle')
        page.locator('[data-view=providers]').click()
        fill(page, '#port', str(port))
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('commandcode')
        page.locator('#confirmAdd').click()
        page.locator('#connectionAdvanced > summary').click()
        base = 'https://api.commandcode.ai/provider/v1'
        for suffix in ['/chat/completions', '/responses', '/models/']:
            fill(page, '#pUrl', base + suffix)
            expect(page.locator('#pUrl')).to_have_value(base)
            assert rpc('apiRouterGetState')['result']['providers'][0]['baseUrl'] == base
        page.locator('#pProtocol').select_option('dual')
        fill(page, '#pAUrl', base + '/messages')
        expect(page.locator('#pAUrl')).to_have_value(base)

        # A save returning the normalized URL must preserve a newer edit.
        page.evaluate('window.testHoldSave()')
        fill(page, '#pUrl', base + '/chat/completions')
        page.wait_for_function('() => window.testSaveStarted')
        replacement = upstream + '/command/v1'
        fill(page, '#pUrl', replacement)
        page.evaluate('window.testReleaseSave()')
        page.wait_for_function("() => !isDirty() && !saving")
        expect(page.locator('#pUrl')).to_have_value(replacement)
        assert rpc('apiRouterGetState')['result']['providers'][0]['baseUrl'] == replacement

        page.locator('#pProtocol').select_option('openai')
        fill(page, '[data-field=key]', 'test-command-account')
        page.locator('#verifyModel').select_option('deepseek-v4.1-flash')
        page.locator('#verifyNow').click()
        expect(page.locator('#status')).to_contain_text('Validation succeeded for deepseek-v4.1-flash')
        provider = rpc('apiRouterGetState')['result']['providers'][0]
        assert [model['upstream'] for model in provider['models']] == [
            'deepseek/deepseek-v4.1-flash', 'moonshotai/Kimi-K3', 'zai-org/GLM-5.3',
            'moonshotai/Kimi-K2.6', 'moonshotai/Kimi-K2.5']
        page.reload(wait_until='networkidle')
        page.locator('[data-view=providers]').click()
        page.locator('#providers button[data-select]').first.click()
        expect(page.locator('#keyRows')).to_contain_text('Model verified')
        assert not errors, errors
        browser.close()
    print('PASS Command Code: complete URLs, autosave race, exact upstream IDs, model verification and reload')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=5)
