"""Alias mapping and catalog selection through real IPC, using an isolated key pool."""
import json
import os
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
ui_root = Path(os.environ.get('CAMELLIA_UI_ROOT', repo))
driver_root = Path(os.environ.get('CAMELLIA_DRIVER_ROOT', repo))
artifacts = repo / 'artifacts/model-routing-fix-20261007'
driver = subprocess.Popen(['node', str(driver_root / 'tests/claude-ui-driver.cjs')],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, encoding='utf-8')


def rpc(method, payload=None):
    if method == 'providerModels':
        return {'result': {'ok': True, 'models': [
            {'id': 'company/fast-astra', 'upstream': 'company/GPTSpecial', 'protocol': 'auto', 'maxContext': 65536},
            {'id': 'gpt-6-astra', 'upstream': 'openai/openai/gpt-6-astra', 'protocol': 'auto'},
            {'id': 'gpt-6-astra', 'upstream': 'gpt-6-astra', 'protocol': 'auto'},
        ]}}
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


def wait_state(page, predicate):
    return page.evaluate("""async predicate => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const state = await window.dshDesktop.apiRouterGetState();
        if (eval(predicate)) return state;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Model mapping did not persist: ' + predicate);
    }""", predicate)


def provider(identity, model, upstream, key_count=1):
    return {'id': identity, 'name': identity, 'type': 'custom', 'baseUrl': 'http://127.0.0.1:19099/v1',
            'protocol': 'openai', 'enabled': True, 'priority': 0,
            'models': [{'id': model, 'upstream': upstream, 'contextWindow': 49152}],
            'keys': [{'id': identity + '-key-' + str(index), 'key': 'test-only-' + identity + str(index), 'enabled': True}
                     for index in range(key_count)]}


try:
    rpc('apiRouterSaveConfig', {'port': rpc('freePort')['result'], 'providers': [
        provider('Relay', 'openai/openai/GPT-6-Astra', 'openai/openai/GPT-6-Astra', 2),
        provider('Direct', 'gpt-6-astra', 'gpt-6-astra'),
        provider('Custom', 'company/fast-astra', 'company/GPTSpecial'),
    ]})
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 920})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((ui_root / 'src/renderer/settings/api-settings.html').as_uri() + '?page=providers')
        page.wait_for_load_state('networkidle')
        page.locator('[data-select="Relay"]').first.click()
        expect(page.locator('#modelChips')).to_contain_text('gpt-6-astra')
        expect(page.locator('#modelChips')).to_contain_text('Available keys: 3 / 3')
        expect(page.locator('#modelChips')).not_to_contain_text('openai/openai')
        page.locator('#backProviders').click()
        page.locator('[data-select="Custom"]').first.click()
        expect(page.locator('#modelAdvanced')).not_to_have_attribute('open', '')
        page.locator('#mapModels').click()
        expect(page.locator('#modelAdvanced')).to_have_attribute('open', '')
        expect(page.locator('#routingModelIds option[value="gpt-6-astra"]')).to_have_count(1)
        field = page.locator('input[data-model="0"][data-field="id"]')
        field.fill('gpt-6-astra')
        field.blur()
        state = wait_state(page, "state.providers.find(p => p.id === 'Custom').models[0].id === 'gpt-6-astra'")
        assert state['providers'][2]['models'][0]['upstream'] == 'company/GPTSpecial'
        assert state['models'] == ['gpt-6-astra']
        expect(page.locator('#modelChips')).to_contain_text('Available keys: 4 / 4')

        page.locator('#discoverModels').click()
        expect(page.locator('[data-catalog="company/GPTSpecial"]')).to_be_checked()
        page.locator('#modelSearch').fill('GPTSpecial')
        expect(page.locator('#catalogList .catalog-option')).to_have_count(1)
        page.locator('#modelSearch').fill('')
        page.locator('[data-catalog="openai/openai/gpt-6-astra"]').check()
        page.locator('[data-catalog="gpt-6-astra"]').check()
        page.locator('#applyModels').click()
        state = wait_state(page, "state.providers.find(p => p.id === 'Custom').models.length === 3")
        assert all(model['id'] == 'gpt-6-astra' for model in state['providers'][2]['models'])
        assert state['providers'][2]['models'][0]['contextWindow'] == 49152
        expect(page.locator('#modelChips .model-chip')).to_have_count(1)
        expect(page.locator('#modelChips')).to_contain_text('Available keys: 4 / 4')
        page.locator('#discoverModels').click()
        page.locator('[data-catalog="gpt-6-astra"]').uncheck()
        page.locator('#applyModels').click()
        wait_state(page, "state.providers.find(p => p.id === 'Custom').models.length === 2")

        page.reload()
        page.wait_for_load_state('networkidle')
        page.locator('[data-select="Custom"]').first.click()
        page.locator('#mapModels').click()
        expect(page.locator('input[data-model="0"][data-field="id"]')).to_have_value('gpt-6-astra')
        expect(page.locator('input[data-model="0"][data-field="upstream"]')).to_have_value('company/GPTSpecial')
        page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
        expect(page.locator('#mapModels')).to_have_text('映射模型别名')
        expect(page.locator('#modelChips')).to_contain_text('可用 Key：4 / 4')
        artifacts.mkdir(parents=True, exist_ok=True)
        suffix = 'installed' if ui_root != repo else 'source'
        page.screenshot(path=str(artifacts / ('model-routing-' + suffix + '.png')), full_page=True)
        page.set_viewport_size({'width': 620, 'height': 920})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(artifacts / ('model-routing-' + suffix + '-narrow.png')), full_page=True)
        assert errors == [], errors
        browser.close()
    print('PASS model routing UI: automatic names, shared key counts, manual mapping, catalog identity, persistence and Chinese labels')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
