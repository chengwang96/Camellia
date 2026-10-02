"""Rename mobile devices through both desktop surfaces, including polling and failures."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)

bridge = """(() => {
  const state = { running: true, enabled: true, address: 'http://100.80.1.2:43127',
    computerName: 'Desktop', pending: [], workspaces: [], closeToTray: false,
    language: TEST_LANGUAGE, theme: 'system', devices: [
      { id: 'ipad', name: 'iPad14,1', workspaceIds: [], allWorkspaces: true, includeUnassigned: true },
      { id: 'tablet', name: 'Y700', workspaceIds: [], allWorkspaces: true, includeUnassigned: true }
    ] };
  window.remoteTest = state;
  window.remoteCalls = [];
  const control = async (action, payload) => {
    remoteCalls.push({ action, payload });
    if (action === 'state' && window.remoteStateFailure) return { ok: false, error: 'Mobile access is unavailable' };
    if (action === 'rename') {
      if (window.holdRename) await new Promise(resolve => { window.finishRename = resolve; });
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
                rename = devices.get_by_role('button', name='重命名' if chinese else 'Rename', exact=True).first
                dialog = page.locator('dialog.device-rename')
                field = dialog.get_by_role('textbox', name='移动设备名称' if chinese else 'Mobile device name', exact=True)
                save = dialog.get_by_role('button', name='保存' if chinese else 'Save', exact=True)
                cancel = dialog.get_by_role('button', name='取消' if chinese else 'Cancel', exact=True)
                original = page.evaluate('structuredClone(remoteTest)')

                rename.click()
                expect(dialog.get_by_role('heading')).to_have_text('重命名移动设备' if chinese else 'Rename mobile device')
                expect(field).to_have_value('iPad14,1')
                expect(dialog).to_contain_text('已授权设备列表' if chinese else 'authorized devices list')
                field.fill('Reading iPad')
                poll(page)
                expect(save).to_be_enabled()
                expect(cancel).to_be_enabled()
                expect(field).to_have_value('Reading iPad')
                page.screenshot(path=str(screenshots / f'remote-rename-{surface}-{language}.png'))
                cancel.click()
                expect(dialog).to_have_count(0)
                assert rename_calls(page) == []
                assert page.evaluate('remoteTest.devices') == original['devices']

                # Validation and a failed save leave the form usable, with the error visible inside it.
                rename.click()
                field.fill('   ')
                save.click()
                expect(dialog.get_by_role('alert')).not_to_be_empty()
                assert rename_calls(page) == []
                field.fill('  Reading iPad  ')
                page.evaluate('window.renameFailure = true')
                save.click()
                expect(dialog.get_by_role('alert')).to_have_text('Rename failed. Please retry.')
                expect(save).to_be_enabled()
                expect(cancel).to_be_enabled()
                expect(field).to_be_enabled()
                expect(field).to_have_value('  Reading iPad  ')
                poll(page)
                expect(dialog.get_by_role('alert')).to_have_text('Rename failed. Please retry.')
                expect(save).to_be_enabled()

                # Only the rename request locks the form; duplicate submission sends no second request.
                page.evaluate('window.renameFailure = false; window.holdRename = true')
                save.click()
                page.wait_for_function("typeof window.finishRename === 'function'")
                expect(save).to_be_disabled()
                expect(cancel).to_be_disabled()
                expect(field).to_be_disabled()
                page.evaluate("document.querySelector('dialog form').requestSubmit()")
                assert len(rename_calls(page)) == 2  # Failed request plus the in-flight retry.
                page.keyboard.press('Escape')
                expect(dialog).to_be_visible()
                page.evaluate('window.holdRename = false; window.finishRename()')
                expect(dialog).to_have_count(0)
                expect(devices.locator('.name').first).to_contain_text('Reading iPad')
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
                expect(dialog).to_have_count(0)
                page.evaluate('window.remoteStateFailure = false')
                poll(page)
                rename.click()
                expect(field).to_have_value('Reading iPad')
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0)
                assert len(rename_calls(page)) == 2
                assert not errors, errors
                page.close()
                print(f'PASS: mobile device rename in {surface}, {language}')
    finally:
        browser.close()
