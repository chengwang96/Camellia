"""Mobile-access authorization, using an isolated desktop bridge."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)
bridge = """(() => {
  const state = { running: false, enabled: false, address: null, devices: [], pending: [],
    guard: { supported: true, available: true, enabled: false, running: false, retrying: false },
    workspaces: [{ id: 'project', name: 'Research workspace' }, { id: 'second', name: 'Second workspace' }], closeToTray: false, language: 'zh-CN', theme: 'system' };
  window.remoteTest = state;
  window.camelliaRemote = { control: async (action, payload) => {
    if (window.remoteTestFailure) return { ok: false, error: 'Mobile access is unavailable' };
    if (action === 'start') { state.enabled = true; state.running = true; state.address = 'http://100.80.1.2:43127'; state.guard.running = state.guard.enabled; }
    if (action === 'stop') { state.enabled = false; state.running = false; state.address = null; state.guard.running = false; }
    if (action === 'guard-enable') { state.guard.enabled = true; state.guard.running = true; }
    if (action === 'guard-disable') { state.guard.enabled = false; state.guard.running = false; }
    if (action === 'set-name') {
      state.computerName = payload.name;
      return { ok: true, result: { ...structuredClone(state),
        embeddedNetworkSync: { synced: true, hostName: payload.name.toLowerCase().replaceAll(' ', '-') },
        tailscaleSync: { synced: true, deviceId: 'node', name: payload.name } } };
    }
    if (action === 'invite') {
      window.lastInviteScope = payload.workspaceIds;
      window.lastInviteOptions = payload;
      return { ok: true, result: { code: 'preview-pairing-code', address: state.address, expiresAt: Date.now() + 300000 } };
    }
    if (action === 'simulate-phone-request') state.pending = [{ id: 'phone', name: '<img src=x onerror=alert(1)>', state: 'pending', ...window.lastInviteOptions }];
    if (action === 'approve') { state.devices = state.pending; state.pending = []; }
    if (action === 'reject') state.pending = [];
    if (action === 'revoke') { state.devices = []; state.guard.running = false; }
    if (action === 'scope') Object.assign(state.devices.find(device => device.id === payload.id), payload);
    return { ok: true, result: structuredClone(state) };
  } };
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for scheme in ['light', 'dark']:
            page = browser.new_page(viewport={'width': 640, 'height': 850}, color_scheme=scheme)
            page.clock.install()
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
            expect(page.locator('#relayUse')).to_have_count(1)
            expect(page.locator('#invite')).to_be_disabled()
            page.get_by_role('button', name='开启手机访问', exact=True).click()
            expect(page.locator('#address')).to_have_text('http://100.80.1.2:43127')
            page.locator('#deviceName').fill('Work PC')
            page.get_by_role('button', name='保存名称', exact=True).click()
            expect(page.locator('#deviceNameStatus')).to_contain_text('已同步到 Tailscale')
            page.get_by_role('button', name='生成配对码').click()
            expect(page.locator('#qr img')).to_have_count(1)
            expect(page.locator('#code')).to_have_text('preview-pairing-code')
            assert page.evaluate('window.lastInviteScope') == []
            assert page.evaluate('window.lastInviteOptions.allWorkspaces') is True
            assert page.evaluate('window.lastInviteOptions.includeUnassigned') is True
            page.evaluate("remoteTest.workspaces.push({id:'future', name:'Future workspace'})")
            page.get_by_role('button', name='刷新二维码').click()
            expect(page.locator('#relayUse')).to_have_count(1)
            expect(page.locator('#qr img')).to_have_count(1)
            expect(page.locator('#code')).to_have_text('preview-pairing-code')
            expect(page.locator('#refreshInvite')).to_be_enabled()
            assert page.evaluate('window.lastInviteScope') == []
            assert page.evaluate('window.lastInviteOptions.allWorkspaces') is True
            # Generating a code does not create a request until the phone scans it.
            page.evaluate("camelliaRemote.control('simulate-phone-request')")
            page.clock.fast_forward(5100)
            expect(page.locator('#invitation')).to_be_hidden()
            expect(page.locator('#pairPending')).to_be_visible()
            expect(page.locator('#pending .name')).to_contain_text('<img src=x onerror=alert(1)>')
            # The pairing QR is the only image; a hostile device name must stay text.
            assert page.locator('#pending img, #devices img').count() == 0
            page.get_by_role('button', name='授权设备', exact=True).click()
            expect(page.locator('#pending .device')).to_have_count(0)
            expect(page.locator('#devices .device')).to_have_count(1)
            expect(page.get_by_role('button', name='授权全部访问', exact=True)).to_have_count(0)
            expect(page.locator('#guardSection')).to_be_visible()
            expect(page.locator('#guardToggle')).to_be_enabled()
            page.locator('#guardToggle').check()
            expect(page.locator('#guardStatus')).to_have_text('守护中')
            assert page.evaluate('window.remoteTest.guard.enabled') is True
            page.locator('#guardToggle').uncheck()
            expect(page.locator('#guardStatus')).to_have_text('未开启。')
            page.locator('#guardToggle').check()
            page.get_by_role('button', name='关闭手机访问', exact=True).click()
            expect(page.locator('#guardStatus')).to_have_text('手机访问关闭时暂停；重新开启后自动恢复。')
            page.get_by_role('button', name='开启手机访问', exact=True).click()
            expect(page.locator('#guardStatus')).to_have_text('守护中')
            expect(page.locator('#devices .name')).to_contain_text('<img src=x onerror=alert(1)>')
            assert page.evaluate('remoteTest.devices[0].allWorkspaces') is True
            assert page.evaluate('remoteTest.devices[0].includeUnassigned') is True
            expect(page.locator('#devices .device-actions button:visible')).to_have_count(2)
            expect(page.locator('#devices .device-actions button:visible').first).to_have_text('重命名')
            expect(page.locator('#devices .device-actions button:visible').last).to_have_text('撤销')
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
            expect(page.locator('#relayUse')).to_have_count(1)
            page.locator('#deviceName').fill('Work PC')
            page.get_by_role('button', name='Save name', exact=True).click()
            expect(page.locator('#deviceNameStatus')).to_contain_text('Synced to Tailscale')
            switch_style = page.locator('#relayUse').evaluate("element => { const style = getComputedStyle(element); return { width: style.width, height: style.height, radius: style.borderRadius }; }")
            assert switch_style == {'width': '36px', 'height': '21px', 'radius': '20px'}, switch_style
            page.evaluate("remoteTest.workspaces = []")
            page.get_by_role('button', name='Disable mobile access', exact=True).click()
            expect(page.locator('#invite')).to_be_disabled()
            page.get_by_role('button', name='Enable mobile access', exact=True).click()
            expect(page.locator('#invite')).to_be_enabled()
            page.get_by_role('button', name='Generate pairing code', exact=True).click()
            expect(page.locator('#qr img')).to_have_count(1)
            assert page.evaluate('window.lastInviteOptions') == {'workspaceIds': [], 'allWorkspaces': True, 'includeUnassigned': True}
            page.evaluate('window.scrollTo(0, 1e6)')
            page.wait_for_timeout(100)
            tail = page.evaluate("""() => {
              const scroller = document.scrollingElement;
              const sections = [...document.querySelectorAll('main > section, main > details')]
                .filter(section => getComputedStyle(section).display !== 'none');
              return {
                atEnd: scroller.scrollTop === scroller.scrollHeight - scroller.clientHeight,
                cardBottom: sections.at(-1).getBoundingClientRect().bottom,
                mainBottom: document.querySelector('main').getBoundingClientRect().bottom,
                documentTop: scroller.scrollTop,
                actionsHidden: document.querySelector('#error').getBoundingClientRect().height === 0
                  && getComputedStyle(document.querySelector('#retry')).display === 'none'
              };
            }""")
            assert tail['atEnd'], tail
            assert abs(tail['cardBottom'] - tail['mainBottom']) <= 1, tail
            assert tail['actionsHidden'], tail
            page.mouse.move(page.viewport_size['width'] / 2, page.viewport_size['height'] / 2)
            page.mouse.wheel(0, 600)
            page.wait_for_timeout(100)
            assert page.evaluate('document.scrollingElement.scrollTop') == tail['documentTop']
            assert not errors, errors
            page.close()
        print('PASS: remote-access controls, scopes, approval, revocation, themes, localization and layout')
    finally:
        browser.close()
