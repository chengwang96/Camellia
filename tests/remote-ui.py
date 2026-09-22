"""Mobile-access authorization, using an isolated desktop bridge."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)
bridge = """(() => {
  const state = { running: false, address: null, devices: [], pending: [],
    workspaces: [{ id: 'project', name: 'Research workspace' }, { id: 'second', name: 'Second workspace' }], closeToTray: false, language: 'zh-CN', theme: 'system' };
  window.remoteTest = state;
  window.camelliaRemote = { control: async (action, payload) => {
    if (window.remoteTestFailure) return { ok: false, error: 'Mobile access is unavailable' };
    if (action === 'start') { state.running = true; state.address = 'http://100.80.1.2:43127'; }
    if (action === 'stop') { state.running = false; state.address = null; }
    if (action === 'invite') {
      window.lastInviteScope = payload.workspaceIds;
      window.lastInviteOptions = payload;
      state.pending = [{ id: 'phone', name: '<img src=x onerror=alert(1)>', ...payload }];
      return { ok: true, result: { code: 'preview-pairing-code', address: state.address, expiresAt: Date.now() + 300000 } };
    }
    if (action === 'approve') { state.devices = state.pending; state.pending = []; }
    if (action === 'reject') state.pending = [];
    if (action === 'revoke') state.devices = [];
    if (action === 'scope') Object.assign(state.devices.find(device => device.id === payload.id), payload);
    return { ok: true, result: structuredClone(state) };
  } };
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for scheme in ['light', 'dark']:
            page = browser.new_page(viewport={'width': 640, 'height': 850}, color_scheme=scheme)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            page.add_init_script('window.remoteTestFailure = true')
            page.goto((repo / 'src/renderer/remote/remote.html').as_uri())
            page.wait_for_load_state('networkidle')
            expect(page.locator('#error')).to_have_text('无法加载手机访问状态，请重试。')
            expect(page.locator('#toggle')).to_have_text('开启手机访问')
            expect(page.locator('#toggle')).to_be_disabled()
            expect(page.locator('#devices')).to_have_text('暂时无法加载已授权设备，请重试。')
            page.evaluate('window.remoteTestFailure = false')
            page.get_by_role('button', name='重试', exact=True).click()
            expect(page.locator('#retry')).to_be_hidden()
            expect(page.locator('#error')).to_be_empty()
            expect(page.get_by_role('heading', name='手机访问', exact=True)).to_be_visible()
            expect(page.locator('#invite')).to_be_disabled()
            expect(page.get_by_role('checkbox')).to_have_count(0)
            expect(page.locator('#invite')).to_be_disabled()
            page.get_by_role('button', name='开启手机访问', exact=True).click()
            expect(page.locator('#address')).to_have_text('http://100.80.1.2:43127')
            page.get_by_role('button', name='生成一次性配对码').click()
            expect(page.locator('#code')).to_have_text('preview-pairing-code')
            assert page.evaluate('window.lastInviteScope') == []
            assert page.evaluate('window.lastInviteOptions.allWorkspaces') is True
            assert page.evaluate('window.lastInviteOptions.includeUnassigned') is True
            page.evaluate("remoteTest.workspaces.push({id:'future', name:'Future workspace'})")
            page.get_by_role('button', name='生成一次性配对码').click()
            expect(page.get_by_role('checkbox')).to_have_count(0)
            expect(page.locator('#code')).to_have_text('preview-pairing-code')
            expect(page.locator('#invite')).to_be_enabled()
            assert page.evaluate('window.lastInviteScope') == []
            assert page.evaluate('window.lastInviteOptions.allWorkspaces') is True
            expect(page.locator('#pending .name')).to_contain_text('<img src=x onerror=alert(1)>')
            assert page.locator('img').count() == 0
            page.get_by_role('button', name='授权设备', exact=True).click()
            expect(page.locator('#pending .device')).to_have_count(0)
            expect(page.locator('#devices .device')).to_have_count(1)
            expect(page.get_by_role('button', name='授权全部访问', exact=True)).to_have_count(0)
            page.evaluate("remoteTest.devices[0].allWorkspaces = false; remoteTest.devices[0].workspaceIds = ['project']")
            page.get_by_role('button', name='关闭手机访问', exact=True).click()
            page.on('dialog', lambda dialog: dialog.accept())
            page.get_by_role('button', name='授权全部访问', exact=True).click()
            expect(page.get_by_role('button', name='授权全部访问', exact=True)).to_have_count(0)
            page.get_by_role('button', name='开启手机访问', exact=True).click()
            expect(page.locator('#devices .name')).to_contain_text('全部工作区（含今后新增）及独立会话')
            expect(page.locator('#devices button')).to_have_count(1)
            expect(page.locator('#devices button')).to_have_text('撤销')
            expect(page.get_by_text('仅查看', exact=True)).to_have_count(0)
            page.screenshot(path=str(screenshots / f'remote-{scheme}.png'), full_page=True)
            page.get_by_role('button', name='撤销', exact=True).click()
            expect(page.locator('#devices .device')).to_have_count(0)
            page.get_by_role('button', name='关闭手机访问', exact=True).click()
            expect(page.locator('#invitation')).to_be_hidden()
            page.set_viewport_size({'width': 480, 'height': 650})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.evaluate("remoteTest.language = 'en'")
            page.get_by_role('button', name='开启手机访问', exact=True).click()
            expect(page.get_by_role('heading', name='Mobile access', exact=True)).to_be_visible()
            expect(page.get_by_role('checkbox')).to_have_count(0)
            page.evaluate("remoteTest.workspaces = []")
            page.get_by_role('button', name='Disable mobile access', exact=True).click()
            expect(page.locator('#invite')).to_be_disabled()
            page.get_by_role('button', name='Enable mobile access', exact=True).click()
            expect(page.locator('#invite')).to_be_enabled()
            page.get_by_role('button', name='Generate one-time pairing code', exact=True).click()
            assert page.evaluate('window.lastInviteOptions') == {'workspaceIds': [], 'allWorkspaces': True, 'includeUnassigned': True}
            assert not errors, errors
            page.close()
        print('PASS: remote-access controls, scopes, approval, revocation, themes, localization and layout')
    finally:
        browser.close()
