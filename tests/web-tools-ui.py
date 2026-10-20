"""Real settings page and desktop IPC, with fixture keys and no paid calls."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
output = repo / 'artifacts/deepseek-web-tools'
output.mkdir(parents=True, exist_ok=True)
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
    return response

bridge = """(() => {
  let router = () => {};
  window.testCall = async (method, payload) => {
    if (method === 'apiRouterSaveConfig' && window.failWebSave) return {ok:false,error:'Fixture save failure'};
    const response = await window.testRpc(method, payload);
    for (const event of response.events || []) if (event.channel === 'dsh:api-router-state') router(event.data);
    return response.result;
  };
  window.dshDesktop = new Proxy({}, { get: (_, method) => method === 'onApiRouterState' ? callback => { router = callback; }
    : method.startsWith('on') ? () => () => {}
    : ['remoteControl', 'discussion'].includes(method) ? (action, payload) => window.testCall(method, {action,payload})
    : payload => window.testCall(method, payload) });
})();"""

def wait_saved(page, source):
    page.wait_for_function("""async source => {
      const state = await window.dshDesktop.apiRouterGetState();
      return state.webTools?.provider === source && !saving && !isDirty();
    }""", arg=source)

def provider(id, url='https://api.deepseek.com/v1', enabled=True):
    return {'id': id, 'name': 'DeepSeek ' + id, 'type': 'deepseek', 'baseUrl': url, 'enabled': enabled,
            'models': [], 'keys': [{'id': id + '-key', 'key': 'fixture-private-' + id, 'enabled': True}]}

try:
    rpc('workbenchSaveSettings', {'autoRefreshBalances': False})
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1120, 'height': 840}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        url = (repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=models'
        page.goto(url)
        page.wait_for_load_state('networkidle')
        source = page.locator('#webToolsProvider')
        expect(source).to_be_enabled()
        expect(source).to_have_value('native')
        expect(source.locator('option')).to_have_count(1)
        expect(page.locator('#webToolsAddApi')).to_be_visible()
        page.locator('#webToolsAddApi').click()
        expect(page.locator('#addDialog')).to_be_visible()
        expect(page.locator('#preset')).to_have_value('deepseek')
        page.keyboard.press('Escape')

        state = rpc('apiRouterGetState')['result']
        state['providers'] = [provider('official'), provider('second'), provider('relay', 'https://relay.example/v1'), provider('disabled', enabled=False)]
        assert rpc('apiRouterSaveConfig', state)['result']['ok']
        page.goto(url)
        page.wait_for_load_state('networkidle')
        expect(source).to_be_enabled()
        expect(source.locator('option')).to_have_count(3)
        source.select_option('deepseek:official')
        wait_saved(page, 'deepseek')
        expect(page.locator('#webToolsPrice')).to_be_visible()
        assert rpc('apiRouterGetState')['result']['webTools']['providerId'] == 'official'
        assert 'fixture-private' not in page.content()
        page.reload()
        page.wait_for_load_state('networkidle')
        expect(source).to_have_value('deepseek:official')

        for language in ['en', 'zh-CN']:
            page.evaluate('language => CamelliaI18n.setLanguage(language)', language)
            for theme in ['light', 'dark']:
                page.emulate_media(color_scheme=theme)
                for width in [1120, 550]:
                    page.set_viewport_size({'width': width, 'height': 840})
                    page.locator('#webToolsSection').scroll_into_view_if_needed()
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (language, theme, width)
                    box = source.bounding_box()
                    assert box['x'] >= 0 and box['x'] + box['width'] <= width
                    page.screenshot(path=str(output / f'{language}-{theme}-{width}.png'))

        page.evaluate('window.failWebSave = true')
        source.select_option('native')
        expect(page.locator('#status')).to_contain_text('Fixture save failure')
        assert rpc('apiRouterGetState')['result']['webTools']['provider'] == 'deepseek'
        page.evaluate('window.failWebSave = false; flushSave()')
        wait_saved(page, 'native')
        expect(page.locator('#webToolsPrice')).to_be_hidden()
        source.select_option('deepseek:second')
        wait_saved(page, 'deepseek')
        state = rpc('apiRouterGetState')['result']
        assert state['webTools']['providerId'] == 'second'
        state['providers'][1]['enabled'] = False
        assert rpc('apiRouterSaveConfig', state)['result']['ok']
        page.reload()
        page.wait_for_load_state('networkidle')
        expect(source).to_have_value('deepseek:second')
        expect(source.locator('option:checked')).to_be_disabled()
        expect(page.locator('#webToolsAddApi')).to_be_visible()
        source.select_option('native')
        wait_saved(page, 'native')
        assert not errors, errors
        browser.close()
    (output / 'verification.json').write_text(json.dumps({'passed': True, 'screenshots': 8,
        'checks': ['missing key', 'official accounts only', 'persistence', 'save failure and retry',
                   'disabled account', 'English and Chinese', 'light and dark', 'narrow layout'],
        'paidRequests': 0}, indent=2), encoding='utf-8')
    print('DeepSeek web settings: real IPC, persistence, failure recovery and 8 layout checks passed')
finally:
    driver.stdin.close()
    driver.terminate()
    driver.wait(timeout=10)
