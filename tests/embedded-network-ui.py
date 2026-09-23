"""Embedded network login states in both desktop settings and standalone panel."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = """(() => {
  const state = { running: false, enabled: false, address: null, devices: [], pending: [], workspaces: [],
    closeToTray: true, language: 'zh-CN', theme: 'system', network: { state: 'Stopped' } };
  window.remoteTest = state;
  const control = async action => {
    window.lastAction = action;
    if (action === 'open-login') window.openedLogin = true;
    if (action === 'start') { state.enabled = true; state.network = { state: 'NeedsLogin', loginUrl: 'https://login.tailscale.com/a/test' }; }
    if (action === 'stop' || action === 'logout') { state.enabled = false; state.running = false; state.address = null; state.network = { state: 'Stopped' }; }
    return { ok: true, result: structuredClone(state) };
  };
  window.camelliaRemote = { control };
  window.dshDesktop = { remoteControl: control };
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for embedded in [False, True]:
            page = browser.new_page(viewport={'width': 640, 'height': 800})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            if embedded:
                html = (repo / 'src/renderer/settings/api-settings.html').read_text(encoding='utf-8')
                html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
                page.route('**/api-settings.html', lambda route: route.fulfill(body=html, content_type='text/html'))
                page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri())
                page.evaluate("document.getElementById('mobilePage').hidden = false; document.documentElement.lang = 'zh-CN'")
                page.add_script_tag(url=(repo / 'src/renderer/remote/remote.js').as_uri())
                page.evaluate('window.mobileAccessUI.setVisible(true)')
            else:
                page.goto((repo / 'src/renderer/remote/remote.html').as_uri())
            page.wait_for_load_state('networkidle')
            prefix = '#mobile-' if embedded else '#'
            expect(page.locator(prefix + 'networkState')).to_have_text('内置网络已关闭')
            page.locator(prefix + 'toggle').click()
            expect(page.locator(prefix + 'toggle')).to_have_text('关闭手机访问')
            expect(page.locator(prefix + 'networkState')).to_have_text('请登录 Tailscale')
            expect(page.locator(prefix + 'invite')).to_be_disabled()
            page.locator(prefix + 'login').click()
            assert page.evaluate('window.openedLogin') is True
            page.evaluate("remoteTest.network = {state: 'NeedsMachineAuth'}")
            page.locator(prefix + 'retry').dispatch_event('click')
            expect(page.locator(prefix + 'networkState')).to_have_text('请在 Tailscale 管理后台批准此设备')
            expect(page.locator(prefix + 'login')).to_be_hidden()
            page.evaluate("remoteTest.network = {state: 'Running'}; remoteTest.running = true; remoteTest.address = 'http://100.80.1.2:43127'")
            page.locator(prefix + 'retry').dispatch_event('click')
            expect(page.locator(prefix + 'address')).to_have_text('http://100.80.1.2:43127')
            expect(page.locator(prefix + 'invite')).to_be_enabled()
            page.on('dialog', lambda dialog: dialog.accept())
            # Sign-out lives in the collapsible connection help, so open it first.
            page.locator('summary[data-copy=connectionHelp]').click()
            page.locator(prefix + 'logout').click()
            expect(page.locator(prefix + 'networkState')).to_have_text('内置网络已关闭')
            expect(page.locator(prefix + 'invite')).to_be_disabled()
            page.set_viewport_size({'width': 480, 'height': 650})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert not errors, errors
            page.close()
        print('PASS: embedded login, approval, online, logout and narrow layout states')
    finally:
        browser.close()
