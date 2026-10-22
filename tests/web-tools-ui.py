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
    if (method === 'apiRouterSaveConfig' && window.deferWebSave) await new Promise(resolve => { window.releaseWebSave = resolve; });
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

def expect_synced(page, value):
    for prefix in ['webTools', 'networkWebTools']:
        expect(page.locator('#' + prefix + 'Provider')).to_have_value(value)
        expect(page.locator('#' + prefix + 'Price')).to_have_js_property('hidden', value == 'native')
    assert page.locator('#webToolsHint').text_content() == page.locator('#networkWebToolsHint').text_content()

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
        network_source = page.locator('#networkWebToolsProvider')
        expect_synced(page, 'native')
        for view, prefix in [('models', 'webTools'), ('network', 'networkWebTools')]:
            page.locator('[data-view=' + view + ']').click()
            expect(page.locator('#' + prefix + 'Provider')).to_be_enabled()
            expect(page.locator('#' + prefix + 'Provider option')).to_have_count(1)
            expect(page.locator('#' + prefix + 'AddApi')).to_be_visible()
            page.locator('#' + prefix + 'AddApi').click()
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
        expect_synced(page, 'deepseek:official')
        expect(page.locator('#webToolsPrice')).to_be_visible()
        assert rpc('apiRouterGetState')['result']['webTools']['providerId'] == 'official'
        assert 'fixture-private' not in page.content()
        page.reload()
        page.wait_for_load_state('networkidle')
        expect_synced(page, 'deepseek:official')

        # The Network entry uses the same persisted setting in both directions.
        page.locator('[data-view=network]').click()
        expect(network_source).to_be_visible()
        network_source.select_option('deepseek:second')
        wait_saved(page, 'deepseek')
        expect_synced(page, 'deepseek:second')
        assert rpc('apiRouterGetState')['result']['webTools']['providerId'] == 'second'
        page.reload()
        page.wait_for_load_state('networkidle')
        page.locator('[data-view=network]').click()
        expect_synced(page, 'deepseek:second')
        network_source.select_option('native')
        wait_saved(page, 'native')
        expect_synced(page, 'native')

        # Switching pages during a save must already show the new selection.
        page.locator('[data-view=models]').click()
        page.evaluate('window.deferWebSave = true')
        source.select_option('deepseek:official')
        expect(source).to_be_disabled()
        expect(network_source).to_be_disabled()
        expect_synced(page, 'deepseek:official')
        page.locator('[data-view=network]').click()
        expect(network_source).to_be_visible()
        expect_synced(page, 'deepseek:official')
        page.wait_for_function("typeof window.releaseWebSave === 'function'")
        page.evaluate('window.deferWebSave = false; window.releaseWebSave()')
        wait_saved(page, 'deepseek')
        expect(source).to_be_enabled()
        expect(network_source).to_be_enabled()

        screenshots = 0
        for language in ['en', 'zh-CN']:
            page.evaluate('language => CamelliaI18n.setLanguage(language)', language)
            for theme in ['light', 'dark']:
                page.emulate_media(color_scheme=theme)
                for width in [1120, 550, 320]:
                    page.set_viewport_size({'width': width, 'height': 840})
                    for view, prefix in [('models', 'webTools'), ('network', 'networkWebTools')]:
                        page.locator('[data-view=' + view + ']').click()
                        page.locator('#' + prefix + 'Section').scroll_into_view_if_needed()
                        expect_synced(page, 'deepseek:official')
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (view, language, theme, width)
                        expect(page.locator('#' + prefix + 'Title')).to_have_text('网页搜索与抓取' if language == 'zh-CN' else 'Web search and fetch')
                        box = page.locator('#' + prefix + 'Provider').bounding_box()
                        assert box['x'] >= 0 and box['x'] + box['width'] <= width
                        page.screenshot(path=str(output / f'{view}-{language}-{theme}-{width}.png'))
                        screenshots += 1

        page.evaluate('window.failWebSave = true')
        network_source.select_option('native')
        expect(page.locator('#status')).to_contain_text('Fixture save failure')
        expect_synced(page, 'native')
        assert rpc('apiRouterGetState')['result']['webTools']['provider'] == 'deepseek'
        page.evaluate('window.failWebSave = false; flushSave()')
        wait_saved(page, 'native')
        expect_synced(page, 'native')
        page.locator('[data-view=models]').click()
        source.select_option('deepseek:second')
        wait_saved(page, 'deepseek')
        state = rpc('apiRouterGetState')['result']
        assert state['webTools']['providerId'] == 'second'
        state['providers'][1]['enabled'] = False
        assert rpc('apiRouterSaveConfig', state)['result']['ok']
        page.reload()
        page.wait_for_load_state('networkidle')
        expect_synced(page, 'deepseek:second')
        for prefix in ['webTools', 'networkWebTools']:
            expect(page.locator('#' + prefix + 'Provider option:checked')).to_be_disabled()
            expect(page.locator('#' + prefix + 'AddApi')).to_have_js_property('hidden', False)
        expect(page.locator('#webToolsAddApi')).to_be_visible()
        source.select_option('native')
        wait_saved(page, 'native')
        expect_synced(page, 'native')
        assert not errors, errors
        browser.close()
    (output / 'verification.json').write_text(json.dumps({'passed': True, 'screenshots': screenshots,
        'checks': ['missing key on both pages', 'official accounts only', 'bidirectional synchronization',
                   'persistence from both pages', 'navigation during save', 'save failure and retry',
                   'disabled account', 'English and Chinese', 'light and dark', 'narrow layout'],
        'paidRequests': 0}, indent=2), encoding='utf-8')
    print(f'DeepSeek web settings: real IPC, bidirectional synchronization, persistence, failure recovery and {screenshots} layout checks passed')
finally:
    driver.stdin.close()
    driver.terminate()
    driver.wait(timeout=10)
