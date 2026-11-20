"""Automatic persistence for every provider control through real desktop IPC."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/desktop-ui-driver.cjs')],
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
      throw new Error('Automatic save did not reach: ' + predicate);
    }""", predicate)


def fill(page, selector, value):
    page.locator(selector).fill(value)
    page.locator(selector).blur()


try:
    port = rpc('freePort')['result']
    upstream = rpc('startTestUpstream')['result']
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=providers')
        page.wait_for_load_state('networkidle')
        expect(page.locator('#providers')).to_contain_text('Add your first provider')
        fill(page, '#port', str(port))
        wait_state(page, f'state.port === {port}')
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('custom')
        page.locator('#confirmAdd').click()
        fill(page, '#pUrl', upstream + '/v1')
        wait_state(page, 'state.providers.length === 1 && state.providers[0].keys.length === 0')
        page.locator('[data-field=key]').fill('first-isolated-key')
        wait_state(page, 'state.providers[0].keys.length === 1')
        expect(page.locator('[data-field=key]')).to_have_value('')
        page.locator('#pName').fill('Typed without leaving the field')
        wait_state(page, "state.providers[0].name === 'Typed without leaving the field'")
        fill(page, '[data-field=name]', 'Primary key')
        wait_state(page, "state.providers[0].keys[0].name === 'Primary key'")
        page.locator('#pPriority').select_option('1')
        wait_state(page, 'state.providers[0].priority === 1')
        page.locator('#pProtocol').select_option('dual')
        fill(page, '#pAUrl', upstream + '/anthropic')
        wait_state(page, f"state.providers[0].protocol === 'dual' && state.providers[0].anthropicBaseUrl === '{upstream}/anthropic'")
        page.locator('#pEnabled').uncheck()
        wait_state(page, 'state.providers[0].enabled === false')
        page.locator('#pEnabled').check()
        wait_state(page, 'state.providers[0].enabled === true')
        page.locator('[data-field=enabled]').uncheck()
        wait_state(page, 'state.providers[0].keys[0].enabled === false')
        page.locator('[data-field=enabled]').check()
        wait_state(page, 'state.providers[0].keys[0].enabled === true')
        page.locator('#modelAdvanced > summary').click()
        page.locator('#addModel').click()
        fill(page, '[data-model="0"][data-field=id]', 'model-test')
        fill(page, '[data-model="0"][data-field=upstream]', 'model-test')
        wait_state(page, "state.providers[0].models[0]?.id === 'model-test'")
        page.locator('[data-model="0"][data-field=protocol]').select_option('openai')
        fill(page, '[data-model="0"][data-field=contextWindow]', '65536')
        wait_state(page, "state.providers[0].models[0].protocol === 'openai' && state.providers[0].models[0].contextWindow === 65536")

        page.locator('#addKey').click()
        page.locator('#addModel').click()
        fill(page, '#pName', 'Saved beside empty rows')
        state = wait_state(page, "state.providers[0].name === 'Saved beside empty rows'")
        assert len(state['providers'][0]['keys']) == 1
        assert len(state['providers'][0]['models']) == 1
        expect(page.locator('#keyRows .key-card')).to_have_count(2)
        expect(page.locator('#modelRows tr')).to_have_count(2)
        page.locator('#verifyModel').select_option('model-test')
        page.locator('#verifyNow').click()
        expect(page.locator('#status')).to_contain_text('Validation succeeded for model-test')
        page.locator('#discoverModels').click()
        expect(page.locator('#modelDialog')).to_be_visible()
        page.locator('#modelDialog .dialog-head button').click()
        page.locator('[data-remove-key="1"]').click()
        page.locator('#modelRows [data-remove-model="1"]').click()
        fill(page, '[data-model="0"][data-field=id]', '')
        fill(page, '#pName', 'Saved beside an incomplete mapping')
        state = wait_state(page, "state.providers[0].name === 'Saved beside an incomplete mapping'")
        assert state['providers'][0]['models'][0]['id'] == 'model-test'
        result = page.evaluate('window.flushApiSettings()')
        assert result['ok'] is False
        expect(page.locator('#status')).to_contain_text('Complete the API URL')
        fill(page, '[data-model="0"][data-field=id]', 'model-test')
        assert page.evaluate('window.flushApiSettings()')['ok'] is True

        page.locator('#showImport').click()
        page.locator('#bulkKeys').fill('second-isolated-key\nthird-isolated-key')
        page.locator('#importKeys').click()
        state = wait_state(page, 'state.providers[0].keys.length === 3')
        key_ids = [key['id'] for key in state['providers'][0]['keys']]
        page.locator('[data-up-key="2"]').click()
        wait_state(page, f"state.providers[0].keys[1].id === '{key_ids[2]}'")
        page.locator('[data-down-key="1"]').click()
        wait_state(page, f"state.providers[0].keys[2].id === '{key_ids[2]}'")
        page.locator('[data-remove-key="2"]').click()
        wait_state(page, 'state.providers[0].keys.length === 2')
        fill(page, '#port', '1')
        expect(page.locator('#status')).to_contain_text('Router port must be between')
        assert page.evaluate('window.flushApiSettings()')['ok'] is False
        fill(page, '#port', str(port))
        wait_state(page, f'state.port === {port}')
        page.wait_for_function('!isDirty()')
        page.locator('#pName').fill('Saved when changing pages')
        page.locator('[data-view=general]').click()
        wait_state(page, "state.providers[0].name === 'Saved when changing pages'")
        page.locator('[data-view=providers]').click()
        page.locator('#backProviders').click()
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('custom')
        page.locator('#confirmAdd').click()
        fill(page, '#pUrl', upstream + '/v1')
        fill(page, '[data-field=key]', 'another-isolated-key')
        wait_state(page, 'state.providers.length === 2 && state.providers[1].keys.length === 1')
        page.locator('#backProviders').click()
        page.locator('[data-up="1"]').click()
        wait_state(page, "state.providers[1].name === 'Saved when changing pages'")
        page.locator('[data-down="0"]').click()
        wait_state(page, "state.providers[0].name === 'Saved when changing pages'")
        page.locator('#providers button[data-select]').last.click()
        page.locator('#deleteProvider').click()
        wait_state(page, 'state.providers.length === 1')
        page.reload(wait_until='networkidle')
        page.locator('#providers button[data-select]').first.click()
        expect(page.locator('#pName')).to_have_value('Saved when changing pages')
        expect(page.locator('#keyRows .key-card')).to_have_count(2)
        expect(page.locator('#pPriority')).to_have_value('1')
        expect(page.locator('#pProtocol')).to_have_value('dual')
        assert page.locator('#keyRows input[type=password]').evaluate_all('inputs => inputs.every(input => !input.value)')
        expect(page.locator('#keyRows .key-card.expanded')).to_have_count(0)
        disclosure = page.locator('[data-toggle-key]').first
        expect(disclosure).to_have_attribute('aria-expanded', 'false')
        expect(page.locator('.key-details').first).to_be_hidden()
        disclosure.click()
        expect(disclosure).to_have_attribute('aria-expanded', 'true')
        expect(page.locator('.key-details').first).to_be_visible()
        expect(page.locator('#keyRows .key-card.expanded')).to_have_count(1)
        expect(page.locator('[data-key-usage]').first).to_be_visible()
        disclosure.click()
        expect(page.locator('.key-details').first).to_be_hidden()
        disclosure.click()
        routing_help = page.locator('#providerRoutingHelp')
        routing_summary = page.locator('#providerRoutingToggle')
        closed_summary = routing_summary.evaluate('''summary => {
          const bounds = summary.getBoundingClientRect();
          return {right: bounds.right, top: bounds.top};
        }''')
        routing_summary.click()
        expect(routing_summary).to_have_attribute('aria-expanded', 'true')
        expect(routing_help).to_be_visible()
        opened_summary = routing_summary.evaluate('''summary => {
          const bounds = summary.getBoundingClientRect();
          return {right: bounds.right, top: bounds.top};
        }''')
        assert abs(opened_summary['right'] - closed_summary['right']) < 1, (closed_summary, opened_summary)
        assert abs(opened_summary['top'] - closed_summary['top']) < 1, (closed_summary, opened_summary)
        for language in ['en', 'zh-CN']:
            page.evaluate('language => CamelliaI18n.setLanguage(language)', language)
            expect(disclosure.locator('span')).to_have_text('Details' if language == 'en' else '详情')
            expect(disclosure).to_have_attribute('aria-expanded', 'true')
            placeholder = page.locator('[data-field=key]').first.get_attribute('placeholder')
            assert ('Leave blank to keep' if language == 'en' else '留空保留') in placeholder
            for width in [1100, 760, 560, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 900})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (language, width)
                assert page.locator('#keyRows').evaluate('list => list.scrollWidth <= list.clientWidth'), (language, width)
                routing_layout = page.locator('.provider-options').evaluate('''options => {
                  const container = options.getBoundingClientRect();
                  const summary = options.querySelector('#providerRoutingToggle').getBoundingClientRect();
                  const note = options.querySelector('#providerRoutingHelp > p').getBoundingClientRect();
                  return {left: container.left, right: container.right,
                    summaryRight: summary.right, noteLeft: note.left, noteRight: note.right};
                }''')
                assert abs(routing_layout['summaryRight'] - routing_layout['right']) < 1, (language, width, routing_layout)
                assert abs(routing_layout['noteLeft'] - routing_layout['left']) < 1, (language, width, routing_layout)
                assert routing_layout['noteRight'] <= routing_layout['right'] + 1, (language, width, routing_layout)
        assert not errors, errors
        browser.close()
    print('PASS API autosave: fields, toggles, protocols, mappings, imports, reordering, empty rows, failures, navigation and reload')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
