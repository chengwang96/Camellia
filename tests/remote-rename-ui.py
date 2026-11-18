"""Rename mobile devices in place on both desktop surfaces, including polling and failures."""
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)

bridge = """(() => {
  const state = { running: true, enabled: true, address: 'http://100.80.1.2:43127',
    computerName: 'Desktop', pending: [], workspaces: [], closeToTray: false,
    language: TEST_LANGUAGE, theme: 'system', network: {state: 'Running'}, devices: [
      { id: 'ipad', name: 'iPad14,1', workspaceIds: [], allWorkspaces: true, includeUnassigned: true },
      { id: 'tablet', name: 'Y700', workspaceIds: [], allWorkspaces: true, includeUnassigned: true }
    ] };
  window.remoteTest = state;
  window.remoteCalls = [];
  const control = async (action, payload) => {
    remoteCalls.push({ action, payload });
    if (action === 'state' && window.remoteStateFailure) return { ok: false, error: 'Mobile access is unavailable' };
    if (action === 'rename') {
      if (window.holdRename) await new Promise(resolve => {
        window.pendingRenameResolvers ||= [];
        window.pendingRenameResolvers.push(resolve);
        window.finishRename = () => { for (const finish of window.pendingRenameResolvers.splice(0)) finish(); };
      });
      if (window.renameFailure) return { ok: false, error: 'Rename failed. Please retry.' };
      state.devices.find(device => device.id === payload.id).name = payload.name;
    }
    return { ok: true, result: structuredClone(state) };
  };
  window.camelliaRemote = { control };
  const empty = { ok: true, result: {}, engines: [], providers: [], models: [],
    config: { providers: [], usage: {}, active: {} }, state: {} };
  window.dshDesktop = new Proxy({}, { get: (_target, name) => {
    if (String(name).startsWith('on')) return () => () => {};
    if (name === 'remoteControl') return control;
    if (name === 'workbenchSettings') return async () => ({ ...empty, language: state.language, theme: state.theme });
    if (name === 'camelliaDevices') return { onEvent() {}, onTransfer() {}, async call() {
      return { ok: true, result: { language: state.language, devices: [], network: { state: 'Stopped' } } };
    } };
    return async () => ({ ...empty });
  } });
})();"""


def poll(page):
    before = page.evaluate("remoteCalls.filter(call => call.action === 'state').length")
    page.clock.fast_forward(5100)
    page.wait_for_function("before => remoteCalls.filter(call => call.action === 'state').length > before", arg=before)


def rename_calls(page):
    return page.evaluate("remoteCalls.filter(call => call.action === 'rename')")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for embedded in [False, True]:
            for language in ['zh-CN', 'en']:
                chinese = language == 'zh-CN'
                surface = 'settings' if embedded else 'panel'
                page = browser.new_page(viewport={'width': 1180, 'height': 850}, color_scheme='light' if chinese else 'dark')
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.clock.install()
                page.add_init_script(bridge.replace('TEST_LANGUAGE', repr(language)))
                path = 'settings/api-settings.html' if embedded else 'remote/remote.html'
                page.goto((repo / 'src/renderer' / path).as_uri())
                page.wait_for_load_state('networkidle')
                if embedded:
                    page.locator('[data-view=mobile]').click()
                prefix = 'mobile-' if embedded else ''
                devices = page.locator(f'#{prefix}devices')
                row = devices.locator('.device-row').first
                rename = row.locator('.device-rename-start')
                field = row.get_by_role('textbox', name='移动设备名称' if chinese else 'Mobile device name', exact=True)
                save = row.get_by_role('button', name='保存' if chinese else 'Save', exact=True)
                cancel = row.get_by_role('button', name='取消' if chinese else 'Cancel', exact=True)
                original = page.evaluate('structuredClone(remoteTest)')

                rename.click()
                expect(page.locator('dialog.device-rename')).to_have_count(0)
                expect(row).to_have_class(re.compile(r'\bdevice-inline-rename\b'))
                expect(field).to_have_value('iPad14,1')
                expect(field).to_be_focused()
                expect(devices.locator('.device-row').nth(1).get_by_role('button', name='重命名' if chinese else 'Rename', exact=True)).to_be_visible()
                expect(devices.locator('.device-row').nth(1).get_by_role('button', name='重命名' if chinese else 'Rename', exact=True)).to_be_disabled()
                field.fill('Reading iPad')
                poll(page)
                expect(save).to_be_enabled()
                expect(cancel).to_be_enabled()
                expect(field).to_have_value('Reading iPad')
                page.evaluate("window.__scrollBeforeNarrow = scrollY")
                page.set_viewport_size({'width': 480, 'height': 760})
                page.wait_for_timeout(100)
                assert page.evaluate("""() => {
                  const field = document.querySelector('.device-inline-rename .device-rename-field').getBoundingClientRect();
                  const save = document.querySelector('.device-inline-rename .device-rename-save').getBoundingClientRect();
                  return field.bottom <= save.top && field.right <= innerWidth && save.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
                }""")
                page.evaluate("scrollTo(0, window.__scrollBeforeNarrow)")
                page.set_viewport_size({'width': 1180, 'height': 850})
                page.wait_for_timeout(100)
                page.screenshot(path=str(screenshots / f'remote-rename-{surface}-{language}.png'))
                page.keyboard.press('Escape')
                expect(field).to_have_count(0)
                expect(row).not_to_have_class(re.compile(r'\bdevice-inline-rename\b'))
                expect(row.locator('.device-rename-start')).to_be_visible()
                expect(row.locator('.device-rename-start')).to_be_enabled()
                assert rename_calls(page) == []

                # Validation and a failed save stay in the edited row.
                expect(row.locator('.device-rename-start')).to_be_enabled()
                row.locator('.device-rename-start').click()
                field.fill('   ')
                save.click()
                expect(row.get_by_role('status')).to_have_text('请输入 1–80 个字符的名称。' if chinese else 'Enter a name of 1–80 characters.')
                assert rename_calls(page) == []
                field.fill('  Reading iPad  ')
                page.evaluate('window.renameFailure = true')
                save.click()
                expect(row.get_by_role('status')).to_have_text('Rename failed. Please retry.')
                expect(save).to_be_enabled()
                expect(cancel).to_be_enabled()
                expect(field).to_be_enabled()
                expect(field).to_have_value('  Reading iPad  ')
                poll(page)
                expect(row.get_by_role('status')).to_have_text('Rename failed. Please retry.')
                expect(save).to_be_enabled()

                # Only the rename request locks the inline editor; duplicate submission sends no second request.
                page.evaluate('window.renameFailure = false; window.holdRename = true')
                save.click()
                page.wait_for_function("typeof window.finishRename === 'function'")
                expect(save).to_be_disabled()
                field.press('Enter')
                assert len(rename_calls(page)) == 2  # Failed request plus the in-flight retry.
                page.keyboard.press('Escape')
                expect(field).to_be_visible()
                page.evaluate('window.holdRename = false; window.finishRename()')
                expect(field).to_have_count(0)
                expect(row.locator('.device-name-text')).to_have_text('Reading iPad')
                assert rename_calls(page)[-1]['payload'] == {'id': 'ipad', 'name': 'Reading iPad'}
                original['devices'][0]['name'] = 'Reading iPad'
                assert page.evaluate('remoteTest') == original
                expect(page.locator(f'#{prefix}deviceName')).to_have_value('Desktop')

                # A background status failure must still allow cancellation without losing the draft.
                rename.click()
                expect(field).to_have_value('Reading iPad')
                field.fill('Unsaved draft')
                page.evaluate('window.remoteStateFailure = true')
                poll(page)
                expect(page.locator(f'#{prefix}retry')).to_be_enabled()
                expect(save).to_be_enabled()
                expect(cancel).to_be_enabled()
                expect(field).to_have_value('Unsaved draft')
                cancel.click()
                expect(field).to_have_count(0)
                expect(row.locator('.device-name-text')).to_contain_text('Reading iPad')
                page.evaluate('window.remoteStateFailure = false')
                poll(page)
                rename.click()
                expect(field).to_have_value('Reading iPad')
                page.keyboard.press('Escape')
                expect(field).to_have_count(0)
                assert len(rename_calls(page)) == 2

                # The network sign-out confirmation stays in the app, preserves
                # cancellation and focus, and survives background polling.
                page.locator('.mobile-help summary').click()
                logout = page.locator(f'#{prefix}logout')
                logout_dialog = page.locator('dialog.mobile-logout')
                logout.click()
                expect(logout_dialog).to_be_visible()
                expect(logout_dialog).to_contain_text('CLI 设备' if chinese else 'CLI device')
                logout_cancel = logout_dialog.get_by_role('button', name='取消' if chinese else 'Cancel', exact=True)
                expect(logout_cancel).to_be_focused()
                poll(page)
                expect(logout_cancel).to_be_enabled()
                logout_cancel.click()
                expect(logout_dialog).to_have_count(0)
                expect(logout).to_be_focused()
                assert not page.evaluate("remoteCalls.some(call => call.action === 'logout')")
                logout.click()
                page.keyboard.press('Escape')
                expect(logout_dialog).to_have_count(0)
                assert not page.evaluate("remoteCalls.some(call => call.action === 'logout')")
                logout.click()
                logout_dialog.get_by_role('button', name='退出 Tailscale 登录' if chinese else 'Sign out of Tailscale', exact=True).click()
                expect(logout_dialog).to_have_count(0)
                page.wait_for_function("remoteCalls.filter(call => call.action === 'logout').length === 1")
                assert not errors, errors
                page.close()
                print(f'PASS: mobile device rename in {surface}, {language}')
    finally:
        browser.close()
