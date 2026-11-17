"""Check device-name save feedback against independent API and helper results."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = """(() => {
  const state = { running: true, enabled: true, address: 'http://100.80.1.2:43127',
    computerName: 'HP', devices: [], pending: [], workspaces: [], closeToTray: true,
    language: 'zh-CN', theme: 'light', network: { state: 'Running' } };
  window.remoteTest = state;
  window.nameSyncResult = {};
  window.nameSaveCalls = [];
  const control = async (action, payload) => {
    if (action === 'set-name') {
      state.computerName = payload.name;
      window.nameSaveCalls.push(payload);
      return { ok: true, result: { ...structuredClone(state), ...structuredClone(window.nameSyncResult) } };
    }
    return { ok: true, result: structuredClone(state) };
  };
  window.camelliaRemote = { control };
  window.dshDesktop = { remoteControl: control };
})();"""

messages = {
    'zh-CN': {
        'synced': '已同步到 Tailscale。',
        'local': '已更新内置网络；控制台名称未同步。',
        'offline': '已保存；连接 Tailscale 后再同步。',
        'invalid': '已保存；Tailscale 名称需要字母、数字或连字符，未同步。',
        'error': '已保存；Tailscale 同步失败：Test API error',
    },
    'en': {
        'synced': 'Synced to Tailscale.',
        'local': 'Embedded network updated; the console name was not synced.',
        'offline': 'Saved; connect to Tailscale to sync it.',
        'invalid': 'Saved; Tailscale names allow letters, digits and hyphens only, so it was not synced.',
        'error': 'Saved; Tailscale sync failed: Test API error',
    },
}
scenarios = [
    # API success must never be presented as an unsynced console name.
    ({'tailscaleSync': {'synced': True}, 'embeddedNetworkSync': {'synced': False, 'reason': 'not-running'}}, 'synced'),
    ({'tailscaleSync': {'synced': True}, 'embeddedNetworkSync': {'synced': False, 'reason': 'error', 'error': 'Test helper error'}}, 'synced'),
    ({'tailscaleSync': {'synced': True}, 'embeddedNetworkSync': {'synced': True}}, 'synced'),
    ({'tailscaleSync': {'synced': True}}, 'synced'),
    ({'tailscaleSync': {'synced': False, 'reason': 'unconfigured'}, 'embeddedNetworkSync': {'synced': True}}, 'local'),
    ({'tailscaleSync': {'synced': False, 'reason': 'device-not-found'}, 'embeddedNetworkSync': {'synced': False}}, 'offline'),
    ({'tailscaleSync': {'synced': False, 'reason': 'invalid-name'}, 'embeddedNetworkSync': {'synced': True}}, 'invalid'),
    ({'tailscaleSync': {'synced': False, 'reason': 'error', 'error': 'Test API error'}, 'embeddedNetworkSync': {'synced': True}}, 'error'),
]

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for embedded in [False, True]:
            for language in messages:
                page = browser.new_page(viewport={'width': 760, 'height': 900})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.add_init_script(bridge + f'\nwindow.remoteTest.language = {language!r}; window.CamelliaI18n = {{ language: {language!r} }};')
                entry = 'tests/fixtures/mobile-access-settings-host.html' if embedded else 'src/renderer/remote/remote.html'
                page.goto((repo / entry).as_uri())
                page.wait_for_load_state('networkidle')
                if embedded:
                    page.evaluate('window.mobileAccessUI.setVisible(true)')
                prefix = 'mobile-' if embedded else ''
                save = page.locator(f'#{prefix}saveDeviceName')
                status = page.locator(f'#{prefix}deviceNameStatus')
                expect(save).to_be_enabled()
                for index, (result, key) in enumerate(scenarios):
                    page.evaluate('result => { window.nameSyncResult = result; }', result)
                    status.evaluate("element => { element.textContent = ''; }")
                    page.locator(f'#{prefix}deviceName').fill('ROG')
                    save.click()
                    saved = '已保存本机名称：ROG' if language == 'zh-CN' else 'Computer name saved: ROG'
                    expect(status).to_have_text(f'{saved} · {messages[language][key]}')
                    expect(save).to_be_enabled()
                    assert page.evaluate('window.nameSaveCalls.length') == index + 1
                    assert page.evaluate('window.remoteTest.computerName') == 'ROG'
                assert not errors, errors
                page.close()
        print('PASS: device-name sync feedback, 32 cases across both panels and languages')
    finally:
        browser.close()
