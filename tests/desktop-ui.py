"""Visual and keyboard checks for desktop menus and settings. No external API calls."""
import json
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

        def new_page(width=1320, height=900, scheme='light'):
            page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=scheme)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.expose_function('testRpc', rpc)
            page.add_init_script(bridge)
            return page

        for scheme in ['light', 'dark']:
            landing = new_page(scheme=scheme)
            landing.goto((repo / 'src/renderer/home/home.html').as_uri())
            expect(landing.get_by_role('button', name='Open DSH', exact=True)).to_be_visible()
            expect(landing.get_by_role('button', name='Open Claude', exact=True)).to_be_visible()
            expect(landing.get_by_role('button', name='Open Kimi', exact=True)).to_be_visible()
            expect(landing.get_by_role('button', name='Settings', exact=True)).to_be_visible()
            landing.screenshot(animations='disabled', path=str(screenshots / f'home-{scheme}.png'))
            landing.keyboard.press('Tab')
            expect(landing.locator('#enterDsh')).to_be_focused()
            landing.keyboard.press('Tab')
            expect(landing.locator('#enterClaude')).to_be_focused()
            landing.set_viewport_size({'width': 520, 'height': 820})
            no_overflow(landing)
            landing.close()

        rpc('configureTestApi')
        page = new_page()
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri())
        page.wait_for_load_state('networkidle')
        permission = check_picker(page, '#selPermission')
        page.screenshot(animations='disabled', path=str(screenshots / 'claude-permission.png'))
        permission.get_by_role('option', name='Plan only', exact=True).click()
        expect(permission).to_have_value('plan')
        expect(page.locator('#statusLine')).to_contain_text('Permission mode saved')
        assert rpc('claudeGetSettings')['result']['permissionMode'] == 'plan'
        page.reload()
        expect(page.locator('#selPermission')).to_have_value('plan')
        # Keyboard changes persist too; Escape dismisses without changing selection.
        page.locator('#selPermission').focus()
        page.keyboard.press('Space')
        page.keyboard.press('End')
        page.keyboard.press('Enter')
        expect(page.locator('#selPermission')).to_have_value('default')
        expect(page.locator('#statusLine')).to_contain_text('Permission mode saved')
        page.locator('#selPermission').click()
        page.keyboard.press('Escape')
        expect(page.locator('#selPermission')).to_be_focused()
        page.locator('#newSessionBtn').click()
        page.screenshot(animations='disabled', path=str(screenshots / 'claude-home.png'))
        page.locator('#modelPill').click()
        page.locator('.pop-row').first.click()
        expect(page.locator('.dsh-pop')).to_have_count(2)
        page.screenshot(animations='disabled', path=str(screenshots / 'claude-model-menu.png'))
        page.locator('.pop-opt').first.click()
        expect(page.locator('.dsh-pop')).to_have_count(0)
        page.locator('#usageDot').click()
        page.screenshot(animations='disabled', path=str(screenshots / 'claude-usage-menu.png'))
        page.locator('#input').click()
        page.locator('#goalPillBtn').click()
        rounds = check_picker(page, '#goalRounds')
        rounds.get_by_role('option', name='50 turns', exact=True).click()
        page.locator('#goalInput').fill('验证选择的目标轮数')
        page.locator('#goalStartBtn').click()
        expect(page.locator('#goalMeta')).to_contain_text('50')
        assert rpc('claudeGoalGet')['result']['goal']['maxRounds'] == 50
        page.locator('#goalPauseBtn').click()
        page.locator('#goalClearBtn').click()

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
