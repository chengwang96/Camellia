"""Model chips and catalog selection persist without restoring preset defaults."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, encoding='utf-8')


def rpc(method, payload=None):
    if method == 'providerModels':
        return {'result': {'ok': True, 'models': [
            {'id': model, 'upstream': model, 'protocol': 'auto'}
            for model in ['mimo-v2.6-pro', 'mimo-v2.6-flash']]}}
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
  window.dshDesktop = new Proxy({}, { get: (_, method) => method.startsWith('on')
    ? () => () => {} : async payload => (await window.testRpc(method, payload)).result });
})();"""

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=providers')
        page.wait_for_load_state('networkidle')
        page.locator('.router-options > summary').click()
        page.locator('#port').fill(str(rpc('freePort')['result']))

        for provider_type in ['mimo', 'mimo-token-plan-cn']:
            page.locator('#addProvider').click()
            page.locator('#preset').select_option(provider_type)
            page.locator('#confirmAdd').click()
            page.get_by_role('textbox', name='API Key 1', exact=True).fill('test-only-key')
            expect(page.locator('#modelAdvanced')).not_to_have_attribute('open', '')
            page.get_by_role('button', name='Remove model mimo-v2.6-flash', exact=True).click()
            expect(page.locator('#modelChips .model-chip')).to_have_count(1)
            expect(page.locator('#modelChips')).not_to_contain_text('mimo-v2.6-flash')
            page.locator('#save').click()
            expect(page.locator('#status')).to_contain_text('Saved')
            page.locator('#refresh').click()
            expect(page.locator('#save')).to_be_disabled()
            state = rpc('apiRouterGetState')['result']
            provider = next(item for item in state['providers'] if item['type'] == provider_type)
            assert [model['id'] for model in provider['models']] == ['mimo-v2.6-pro']
            page.locator('#backProviders').click()

        page.locator('[data-select]').first.click()
        page.locator('#modelAdvanced > summary').click()
        page.locator('input[data-model="0"][data-field="contextWindow"]').fill('65536')
        page.locator('#addModel').click()
        page.locator('input[data-model="1"][data-field="id"]').fill('manual-model')
        page.locator('input[data-model="1"][data-field="upstream"]').fill('vendor/manual')
        page.locator('#discoverModels').click()
        pro = page.locator('[data-catalog="mimo-v2.6-pro"]')
        flash = page.locator('[data-catalog="mimo-v2.6-flash"]')
        expect(pro).to_be_enabled()
        expect(pro).to_be_checked()
        pro.uncheck()
        page.locator('#modelDialog .dialog-head button').click()
        expect(page.locator('#modelChips')).to_contain_text('mimo-v2.6-pro')
        page.locator('#discoverModels').click()
        expect(pro).to_be_checked()
        flash.check()
        page.locator('#applyModels').click()
        expect(page.locator('input[data-model="0"][data-field="contextWindow"]')).to_have_value('65536')
        page.locator('#discoverModels').click()
        flash.uncheck()
        page.locator('#modelSearch').fill('pro')
        page.locator('#applyModels').click()
        expect(page.locator('#modelChips')).not_to_contain_text('mimo-v2.6-flash')
        expect(page.locator('#modelChips')).to_contain_text('manual-model')
        page.locator('#save').click()
        expect(page.locator('#status')).to_contain_text('Saved')
        state = rpc('apiRouterGetState')['result']
        models = next(item for item in state['providers'] if item['type'] == 'mimo')['models']
        assert [model['id'] for model in models] == ['mimo-v2.6-pro', 'manual-model'], models
        assert models[0]['contextWindow'] == 65536
        page.get_by_role('button', name='Remove model mimo-v2.6-pro', exact=True).click()
        page.get_by_role('button', name='Remove model manual-model', exact=True).click()
        page.locator('#save').click()
        expect(page.locator('#status')).to_contain_text('Saved')
        state = rpc('apiRouterGetState')['result']
        assert next(item for item in state['providers'] if item['type'] == 'mimo')['models'] == []
        assert errors == [], errors
        browser.close()
    print('PASS model removal: chips, catalog, cancellation, search, metadata and persistence')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
