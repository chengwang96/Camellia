"""Embedded network login states in both desktop settings and standalone panel."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = """(() => {
  const state = { running: false, enabled: false, address: null, devices: [], pending: [], workspaces: [],
    closeToTray: true, language: 'zh-CN', theme: 'system', network: { state: 'Stopped' },
    tailnetUpdate: { supported: true, current: 'v1.98.6', available: null, pending: null, busy: false } };
  window.remoteTest = state;
  const control = async action => {
    window.lastAction = action;
    if (action === 'tailnet-update-check') {
      state.tailnetUpdate.available = 'v1.104.7';
      return { ok: true, result: structuredClone(state.tailnetUpdate) };
    }
    if (action === 'tailnet-update-install') {
      if (!window.retryInstall) {
        window.retryInstall = true;
        return { ok: false, error: 'Update file failed verification' };
      }
      state.tailnetUpdate.available = null;
      state.tailnetUpdate.pending = null;
      state.tailnetUpdate.current = 'v1.104.7';
      return { ok: true, result: { ...structuredClone(state.tailnetUpdate), updated: 'v1.104.7' } };
    }
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
                # Replace the parent routing and language-ready setup stripped
                # above so actual clicks exercise a visible Mobile access page.
                page.evaluate("""() => {
                    document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== 'mobilePage'; });
                    document.documentElement.lang = 'zh-CN';
                    document.documentElement.removeAttribute('data-i18n-pending');
                }""")
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
            # Sign-out lives in the collapsible connection help, so open it first.
            page.locator('summary[data-copy=connectionHelp]').click()
            page.locator(prefix + 'logout').click()
            page.locator('dialog.mobile-logout button[value=logout]').click()
            expect(page.locator(prefix + 'networkState')).to_have_text('内置网络已关闭')
            expect(page.locator(prefix + 'invite')).to_be_disabled()
            if embedded:
                button = page.locator('#mobile-tailnetUpdate')
                expect(page.locator('#mobile-tailnetVersion')).to_have_text('v1.98.6')
                expect(page.locator('#mobile-tailnetUpdateStatus')).to_contain_text('不影响正在进行的回复')
                expect(button).to_have_text('检查更新')
                button.click()
                expect(button).to_have_text('升级至 v1.104.7')
                button.click()
                expect(page.locator('#mobile-tailnetUpdateStatus')).to_contain_text('更新失败')
                expect(button).to_be_enabled()
                button.click()
                expect(page.locator('#mobile-tailnetUpdateStatus')).to_contain_text('v1.104.7 已启用。')
                expect(button).to_be_enabled()
                expect(button).to_have_text('检查更新')
                expect(page.locator('#mobile-tailnetVersion')).to_have_text('v1.104.7')
                expect(page.locator('[data-view=devices], #devicesPage')).to_have_count(0)
                page.evaluate("remoteTest.language = 'en'; document.documentElement.lang = 'en'")
                page.evaluate("mobileAccessUI.refresh()")
                expect(page.locator('#mobile-tailnetUpdateStatus')).to_contain_text('Up to date')
                page.evaluate("remoteTest.tailnetUpdate = { supported: true, current: 'v1.98.6', available: null, pending: 'v1.104.7', busy: false }")
                page.evaluate("mobileAccessUI.refresh()")
                expect(button).to_have_text('Retry activation')
                button.click()
                assert page.evaluate('window.lastAction') == 'tailnet-update-install'
                expect(page.locator('#mobile-tailnetUpdateStatus')).to_contain_text('v1.104.7 is active.')
                page.set_viewport_size({'width': 390, 'height': 650})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            else:
                expect(page.locator('#tailnetUpdate')).to_have_count(0)
            page.set_viewport_size({'width': 480, 'height': 650})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert not errors, errors
            page.close()
        print('PASS: embedded login, approval, online, logout, upgrade and narrow layout states')
    finally:
        browser.close()
