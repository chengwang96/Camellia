"""Visual and keyboard checks for desktop menus and settings. No external API calls."""
import json
import re
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)
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
  const listeners = {};
  const channels = {'dsh:claude-event': 'onClaudeEvent', 'dsh:claude-goal': 'onClaudeGoal', 'dsh:api-router-state': 'onApiRouterState', 'dsh:provider-insights': 'onProviderInsights'};
  window.dshDesktop = new Proxy({}, { get: (_, method) => method.startsWith('on')
    ? fn => { listeners[method] = fn; }
    : async payload => {
      const response = await window.testRpc(method, payload);
      for (const event of response.events || []) listeners[channels[event.channel]]?.(event.data);
      return response.result;
    }
  });
})();"""


def no_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')


def check_picker(page, selector):
    select = page.locator(selector)
    select.click()
    assert select.evaluate("el => el.matches(':open')")
    # An option has an actual, styled DOM box, rather than a Windows popup.
    option = select.locator('option').first
    expect(option).to_be_visible()
    bounds = option.bounding_box()
    size = page.viewport_size
    assert 0 <= bounds['x'] < size['width']
    assert 0 <= bounds['y'] and bounds['y'] + bounds['height'] <= size['height']
    return select


try:
    with tempfile.TemporaryDirectory(prefix='dsh-ui-views-') as temp, sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        errors = []

        def new_page(width=1320, height=900, scheme='light', fresh=False):
            page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=scheme)
            page.on('pageerror', lambda e: errors.append(str(e)))
            def page_rpc(method, payload=None):
                if fresh and method == 'runtimeState':
                    return {'result': {'ok': True, 'engines': [
                        {'id': engine, 'name': name, 'status': 'missing'} for engine, name in
                        [('claude', 'Claude Code'), ('codex', 'Codex CLI'), ('dsh', 'DeepSeek Harness'), ('kimi', 'Kimi Code'), ('antigravity', 'Antigravity')]
                    ]}}
                return rpc(method, payload)
            page.expose_function('testRpc', page_rpc)
            page.add_init_script(bridge)
            return page

        for scheme in ['light', 'dark']:
            landing = new_page(scheme=scheme, fresh=True)
            landing.goto((repo / 'src/renderer/home/home.html').as_uri())
            expect(landing.get_by_role('button', name='Download & open DSH', exact=True)).to_be_visible()
            expect(landing.get_by_role('button', name='Download & open Claude', exact=True)).to_be_visible()
            expect(landing.get_by_role('button', name='Download & open Codex', exact=True)).to_be_visible()
            expect(landing.get_by_role('button', name='Download & open Kimi', exact=True)).to_be_visible()
            expect(landing.get_by_role('button', name='Download & open Antigravity', exact=True)).to_be_visible()
            expect(landing.get_by_role('button', name='Settings', exact=True)).to_be_visible()
            landing.screenshot(animations='disabled', path=str(screenshots / f'home-{scheme}.png'))
            landing.keyboard.press('Tab')
            expect(landing.locator('#enterClaude')).to_be_focused()
            landing.keyboard.press('Tab')
            expect(landing.locator('#enterCodex')).to_be_focused()
            landing.set_viewport_size({'width': 520, 'height': 820})
            no_overflow(landing)
            landing.close()

            downloads = new_page(1040, scheme=scheme, fresh=True)
            downloads.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=runtimes')
            expect(downloads.locator('#runtimeCards [data-install]:not(:disabled)')).to_have_count(5)
            expect(downloads.get_by_role('button', name='Download', exact=True)).to_have_count(5)
            expect(downloads.locator('#downloadMode')).to_have_value('direct')
            expect(downloads.locator('#downloadProxyUrl')).to_have_value('')
            downloads.locator('#downloadMode').select_option('proxy')
            downloads.locator('#downloadProxyUrl').fill('socks5://proxy.example:1080')
            downloads.locator('#saveDownload').click()
            expect(downloads.locator('#status')).to_contain_text('HTTP or HTTPS')
            assert rpc('downloadSettings')['result']['url'] == ''
            downloads.locator('#downloadProxyUrl').fill('http://proxy.example:8080')
            downloads.locator('#saveDownload').click()
            expect(downloads.locator('#status')).to_have_text('Download connection saved')
            downloads.reload()
            expect(downloads.locator('#downloadMode')).to_have_value('proxy')
            expect(downloads.locator('#downloadProxyUrl')).to_have_value('http://proxy.example:8080/')
            downloads.screenshot(animations='disabled', path=str(screenshots / f'optional-downloads-{scheme}.png'))
            no_overflow(downloads)
            downloads.set_viewport_size({'width': 760, 'height': 820})
            no_overflow(downloads)
            downloads.locator('#downloadMode').select_option('direct')
            downloads.locator('#downloadProxyUrl').fill('')
            downloads.locator('#saveDownload').click()
            expect(downloads.locator('#status')).to_have_text('Download connection saved')
            downloads.close()

        rpc('configureTestApi')
        codex = new_page()
        codex.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex')
        codex.wait_for_load_state('networkidle')
        expect(codex.locator('#input')).to_have_attribute('placeholder', 'Message Codex CLI')
        expect(codex.locator('#connectionInfo')).to_contain_text('API key / third-party API')
        expect(codex.locator('.ws-row.active')).to_have_count(0)
        codex.screenshot(animations='disabled', path=str(screenshots / 'codex-chat.png'))
        no_overflow(codex)
        codex.close()
        codex_settings = new_page(1040)
        codex_settings.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=engines&engine=codex')
        codex_settings.wait_for_load_state('networkidle')
        expect(codex_settings.locator('#codexConnection')).to_have_value('api')
        expect(codex_settings.locator('#engineScopeTitle')).to_have_text('Codex in Camellia')
        codex_settings.locator('#codexConnection').select_option('subscription')
        expect(codex_settings.locator('#codexSignIn')).to_be_disabled()
        codex_settings.locator('#saveEngine').click()
        expect(codex_settings.locator('#status')).to_contain_text('Codex settings saved')
        expect(codex_settings.locator('#codexSignIn')).to_be_enabled()
        codex_settings.locator('#codexConnection').select_option('api')
        expect(codex_settings.locator('#saveEngine')).to_be_enabled()
        codex_settings.locator('#saveEngine').click()
        expect(codex_settings.locator('#status')).to_contain_text('Codex settings saved')
        codex_settings.reload()
        expect(codex_settings.locator('#codexConnection')).to_have_value('api')
        codex_settings.screenshot(animations='disabled', path=str(screenshots / 'codex-settings.png'))
        no_overflow(codex_settings)
        codex_settings.close()
        agy = new_page()
        agy.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=antigravity')
        expect(agy.locator('#input')).to_have_attribute('placeholder', 'Message Antigravity')
        expect(agy.locator('.ws-row.active')).to_have_count(0)
        permission = check_picker(agy, '#selPermission')
        permission.get_by_role('option', name='Act, ask when risky', exact=True).click()
        expect(agy.locator('#statusLine')).to_contain_text('Permission mode saved')
        assert rpc('antigravityGetSettings')['result']['permissionMode'] == 'auto'
        agy.locator('#attachBtn').click()
        expect(agy.locator('#statusLine')).to_contain_text('Use Claude or Kimi for images')
        expect(agy.locator('.attchip')).to_have_count(1)
        expect(agy.locator('.attchip-name')).to_have_text('notes.txt')
        agy.locator('.attchip-x').click()
        for scheme in ['light', 'dark']:
            agy.emulate_media(color_scheme=scheme)
            agy.screenshot(animations='disabled', path=str(screenshots / f'antigravity-{scheme}.png'))
            no_overflow(agy)
        agy.close()
        agy_settings = new_page(1160, 860)
        agy_settings.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=engines&engine=antigravity')
        expect(agy_settings.locator('[data-field=instructions]')).to_be_visible()
        agy_settings.locator('[data-field=instructions]').fill('Use the project conventions.')
        agy_settings.locator('#saveEngine').click()
        expect(agy_settings.locator('#status')).to_contain_text('Antigravity settings saved')
        agy_settings.screenshot(animations='disabled', path=str(screenshots / 'antigravity-settings.png'))
        agy_settings.reload()
        expect(agy_settings.locator('[data-field=instructions]')).to_have_value('Use the project conventions.')
        agy_settings.locator('#antigravityConnection').select_option('subscription')
        expect(agy_settings.locator('#googleAccountPanel')).to_be_visible()
        expect(agy_settings.locator('#googleSignIn')).to_be_disabled()
        agy_settings.locator('#googleProxyUrl').fill('http://proxy.example:8080')
        agy_settings.locator('#saveEngine').click()
        expect(agy_settings.locator('#googleSignIn')).to_be_enabled()
        expect(agy_settings.locator('[data-field=agentMode]')).to_be_visible()
        expect(agy_settings.locator('#engineScopeTitle')).to_contain_text('also apply to the CLI')
        assert rpc('antigravityGetSettings')['result']['model'] == ''
        assert rpc('antigravityGetSettings')['result']['proxyUrl'] == 'http://proxy.example:8080/'
        rpc('seedGoogleAccount')
        agy_settings.reload()
        expect(agy_settings.locator('#googleAccountStatus')).to_contain_text('2 models available')
        expect(agy_settings.locator('[data-field=useG1Credits]')).not_to_be_checked()
        for scheme in ['light', 'dark']:
            agy_settings.emulate_media(color_scheme=scheme)
            agy_settings.locator('.scroll-content').evaluate('el => el.scrollTop = 0')
            agy_settings.screenshot(animations='disabled', path=str(screenshots / f'antigravity-google-{scheme}.png'))
            no_overflow(agy_settings)
        google_chat = new_page()
        google_chat.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=antigravity')
        expect(google_chat.locator('#connectionInfo')).to_have_text('Google subscription · Manage account')
        expect(google_chat.locator('#modelPillName')).to_have_text('Gemini Fixture (High)')
        google_chat.locator('#modelPill').click()
        google_chat.locator('.pop-row').filter(has_text='Model').first.click()
        expect(google_chat.locator('.dsh-pop').last).to_contain_text('Model · Google account')
        expect(google_chat.locator('.dsh-pop').last).to_contain_text('Model · Shared API routes')
        expect(google_chat.locator('.pop-opt').filter(has_text='Gemini Fixture (Low)')).to_have_count(1)
        expect(google_chat.locator('.pop-opt').filter(has_text='test-model')).to_have_count(1)
        google_chat.keyboard.press('Escape')
        google_chat.close()
        no_overflow(agy_settings)
        agy_settings.close()
        page = new_page()
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri())
        page.wait_for_load_state('networkidle')
        permission = check_picker(page, '#selPermission')
        page.screenshot(animations='disabled', path=str(screenshots / 'claude-permission.png'))
        permission.get_by_role('option', name='Ask before acting', exact=True).click()
        expect(permission).to_have_value('ask')
        expect(page.locator('#statusLine')).to_contain_text('Permission mode saved')
        assert rpc('claudeGetSettings')['result']['permissionMode'] == 'ask'
        page.reload()
        expect(page.locator('#selPermission')).to_have_value('ask')
        # Keyboard changes persist too; Escape dismisses without changing selection.
        page.locator('#selPermission').focus()
        page.keyboard.press('Space')
        page.keyboard.press('End')
        page.keyboard.press('Enter')
        expect(page.locator('#selPermission')).to_have_value('full')
        expect(page.locator('#statusLine')).to_contain_text('Permission mode saved')
        page.locator('#selPermission').click()
        page.keyboard.press('Escape')
        expect(page.locator('#selPermission')).to_be_focused()

        # A rejected disk write must not show a model, effort or permission
        # selection as saved. Exercise the real IPC handler with an unreadable
        # config in the driver's isolated profile, then restore that profile.
        config_file = Path(rpc('fixtures')['result']['userData']) / 'desktop-config.json'
        saved_config = config_file.read_bytes()
        model_before = page.locator('#modelPillName').inner_text()
        level_before = page.locator('#modelPillLevel').inner_text()
        config_file.write_text('{invalid json', encoding='utf-8')
        try:
            page.locator('#selPermission').select_option('ask')
            expect(page.locator('#selPermission')).to_have_value('full')
            expect(page.locator('#statusLine')).to_contain_text('Could not save settings:')
            page.evaluate("persistModel('')")
            expect(page.locator('#modelPillName')).to_have_text(model_before)
            page.evaluate("persistLevel('high')")
            expect(page.locator('#modelPillLevel')).to_have_text(level_before)
            expect(page.locator('#statusLine')).to_contain_text('Invalid JSON')
            assert config_file.read_text(encoding='utf-8') == '{invalid json'
        finally:
            config_file.write_bytes(saved_config)

        page.locator('#newSessionBtn').click()
        page.screenshot(animations='disabled', path=str(screenshots / 'claude-home.png'))
        page.locator('#modelPill').click()
        page.locator('.pop-row').first.click()
        expect(page.locator('.dsh-pop')).to_have_count(2)
        page.screenshot(animations='disabled', path=str(screenshots / 'claude-model-menu.png'))
        page.locator('.pop-opt').first.click()
        expect(page.locator('.dsh-pop')).to_have_count(0)
        expect(page.locator('#usageDot')).to_have_count(0)
        page.locator('#modelPill').click()
        expect(page.locator('.dsh-pop')).to_have_count(1)
        page.locator('#input').click()
        expect(page.locator('.dsh-pop')).to_have_count(0)

        # A long paste becomes a .txt attachment; short pastes stay inline.
        def paste(text):
            page.evaluate("""text => {
              const data = new DataTransfer();
              data.setData('text/plain', text);
              document.getElementById('input').dispatchEvent(new ClipboardEvent('paste',
                {clipboardData: data, bubbles: true, cancelable: true}));
            }""", text)

        paste('短文本粘贴')
        expect(page.locator('#attachRow .attchip')).to_have_count(0)
        paste('会议纪要 ' + '内容足够长' * 1200)
        expect(page.locator('#attachRow .attchip')).to_have_count(1)
        expect(page.locator('#attachRow .attchip-name')).to_have_text(re.compile(r'^pasted-text-.*\.txt$'))
        expect(page.locator('#statusLine')).to_contain_text('.txt attachment')
        expect(page.locator('#input')).to_have_value('')
        attachment_path = page.locator('#attachRow .attchip').get_attribute('title')
        assert Path(attachment_path).read_text(encoding='utf-8').startswith('会议纪要 ')
        page.locator('#attachRow .attchip-x').click()
        expect(page.locator('#attachRow .attchip')).to_have_count(0)

        page.locator('#input').fill('/goal')
        page.locator('#input').press('Enter')
        expect(page.locator('#goalChipRow')).to_be_visible()
        page.locator('#input').fill('持续完成目标并验证结果')
        page.locator('#input').press('Enter')
        expect(page.locator('#goalChipRow .goal-chip').first).to_contain_text('Goal ·')
        assert 'maxRounds' not in rpc('claudeGoalGet')['result']['goal']
        page.locator('#goalChipRow .goal-chip').first.click()
        page.locator('.dsh-pop .pop-row',has_text='Pause goal').click()
        page.locator('#goalChipRow .goal-chip').first.click()
        page.locator('.dsh-pop .pop-row',has_text='Remove goal').click()

        page.locator('#settingsBtn').click()
        expect(page.locator('#settingsPanel')).to_have_count(0)
        page.locator('#wsCreateBtn').click()
        page.screenshot(animations='disabled', path=str(screenshots / 'workspace-dialog.png'))
        page.locator('#wsCancel').click()
        for scheme in ['light', 'dark']:
            page.emulate_media(color_scheme=scheme)
            page.set_viewport_size({'width': 860, 'height': 620})
            check_picker(page, '#selPermission')
            page.screenshot(animations='disabled', path=str(screenshots / f'claude-permission-{scheme}-compact.png'))
            page.keyboard.press('Escape')
            no_overflow(page)

        rpc('apiRouterSaveConfig', {'version': 2, 'enabled': False, 'providers': []})
        api = new_page(1040)
        api.goto((repo / 'src/renderer/settings/api-settings.html').as_uri())
        api.wait_for_load_state('networkidle')
        api.locator('#addProvider').click()
        presets = check_picker(api, '#preset')
        presets.get_by_role('option', name='DeepSeek', exact=True).click()
        api.locator('#confirmAdd').click()
        api.locator('#connectionAdvanced > summary').click()
        protocol = check_picker(api, '#pProtocol')
        api.screenshot(animations='disabled', path=str(screenshots / 'api-protocol.png'))
        protocol.get_by_role('option', name='Anthropic Messages', exact=True).click()
        expect(api.locator('#aUrlField')).not_to_be_visible()
        api.locator('#modelAdvanced > summary').click()
        api.locator('#addModel').click()
        api.get_by_role('textbox', name='Canonical model ID 1', exact=True).fill('test-model')
        api.get_by_role('textbox', name='Upstream model ID 1', exact=True).fill('test-upstream')
        model = check_picker(api, '[data-model="0"][data-field="protocol"]')
        model.get_by_role('option', name='OpenAI', exact=True).click()
        # A dummy key with the router disabled never reaches an upstream.
        api.get_by_role('textbox', name='API Key 1', exact=True).fill('test-ui-key')
        api.locator('.router-options > summary').click()
        api.locator('#enabled').uncheck()
        api.locator('#save').click()
        expect(api.locator('#status')).to_contain_text('Saved')
        saved = rpc('apiRouterGetState')['result']['providers'][0]
        assert saved['protocol'] == 'anthropic'
        assert saved['models'][0]['protocol'] == 'openai'
        api.reload()
        api.locator('.provider [data-select]').first.click()
        api.locator('#connectionAdvanced > summary').click()
        api.locator('#modelAdvanced > summary').click()
        expect(api.locator('#pProtocol')).to_have_value('anthropic')
        expect(api.locator('[data-model="0"][data-field="protocol"]')).to_have_value('openai')
        for scheme in ['light', 'dark']:
            api.emulate_media(color_scheme=scheme)
            api.locator('.scroll-content').evaluate('el => el.scrollTop = 0')
            api.screenshot(animations='disabled', path=str(screenshots / f'api-settings-{scheme}.png'))
            api.set_viewport_size({'width': 780, 'height': 620})
            check_picker(api, '#pProtocol')
            api.keyboard.press('Escape')
            no_overflow(api)
            api.set_viewport_size({'width': 1040, 'height': 900})

        api.evaluate("""const currentDay = localDay(new Date()); const before = new Date(); before.setDate(before.getDate()-1);
          const previousDay = localDay(before), key = live.providers[0].keys[0].id;
          const stats = {requests:769,inputTokens:20653512,outputTokens:848891,cacheReadTokens:16123942,failures:3};
          live.usage[key] = {...stats,byModel:{'test-model':stats},daily:{[previousDay]:{'test-model':{requests:1,inputTokens:0}},[currentDay]:{'test-model':stats}}};""")
        api.locator('[data-view=usage]').click()
        api.locator('#usageMetric').select_option('tokens')
        for width in [1040, 2160, 760]:
            api.set_viewport_size({'width':width,'height':900})
            expected_chart_width = api.locator('#usageChart').evaluate('el => el.clientWidth')
            expect(api.locator('#usageChart svg')).to_have_attribute('width', str(expected_chart_width))
            dimensions = api.locator('#usageChart svg').evaluate("el => ({height:el.getBoundingClientRect().height,labelSize:parseFloat(getComputedStyle(el.querySelector('text')).fontSize) * el.getScreenCTM().a})")
            assert abs(dimensions['height'] - 248) < 1, dimensions
            assert 12 <= dimensions['labelSize'] <= 14, dimensions
            no_overflow(api)
            api.screenshot(animations='disabled', path=str(screenshots / f'usage-type-scale-{width}.png'))

        # Render the same templates used by Electron's data URL windows.
        script = """
          const { createDesktopViews } = require('./src/main/desktop-views');
          const pages = {};
          for (const dark of [false, true]) {
            const v = createDesktopViews({ appName: 'Camellia', dshHome: 'D:/DSH',
              loadConfig: () => ({}), isDark: () => dark, detectRuntime: () => ({}) });
            const theme = dark ? 'dark' : 'light';
            pages['welcome-' + theme] = v.welcomeHtml({});
            pages['error-' + theme] = v.errorHtml(new Error('Test backend failed to start'));
          }
          process.stdout.write(JSON.stringify(pages));
        """
        templates = json.loads(subprocess.check_output(['node', '-e', script], cwd=repo, text=True, encoding='utf-8'))
        for name, html in templates.items():
            file = Path(temp) / f'{name}.html'
            file.write_text(html, encoding='utf-8')
            view = new_page(800, 760)
            view.goto(file.as_uri())
            view.wait_for_load_state('networkidle')
            no_overflow(view)
            view.screenshot(animations='disabled', path=str(screenshots / f'{name}.png'), full_page=True)
            view.close()
        assert not errors, errors
        browser.close()
    print('PASS: styled menus, mouse/keyboard selections, settings save and dismiss, compact/dark layouts, and desktop templates')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=5)
