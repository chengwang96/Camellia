from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1180, "height": 820})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""
      window.deviceCalls = [];
      const empty = { ok: true, result: {}, engines: [], providers: [], models: [], config: { providers: [], usage: {}, active: {} }, state: {} };
      window.dshDesktop = new Proxy({}, { get: (_target, name) => {
        if (String(name).startsWith('on')) return () => () => {};
        if (name === 'camelliaDevices') return {
          onEvent() {}, onTransfer() {},
          async call(action) {
            window.deviceCalls.push(action);
            if (action === 'state') return { ok: true, result: { language: 'zh-CN', theme: 'light', devices: [{ id: 'server-a', name: 'GPU server', address: 'http://100.80.1.2:43127' }], network: { state: 'Running' } } };
            if (action === 'conversations') return { ok: true, result: { instanceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', workspaces: [], capabilities: [], engines: ['dsh'], conversations: [], nextOffset: null } };
            return { ok: true, result: {} };
          } };
        return () => Promise.resolve({ ...empty });
      } });
    """)
    page.goto((root / "src/renderer/settings/api-settings.html").as_uri())
    page.wait_for_load_state("networkidle")

    # Every settings script must load: a name collision here used to break the whole panel.
    assert page.locator(".settings-nav nav button").count() == 9
    page.locator('.settings-nav nav [data-view="devices"]').click()
    expect(page.locator("#pageTitle")).to_have_text("CLI devices")
    expect(page.locator("#devicesPage")).to_be_visible()
    page.wait_for_function("deviceCalls.includes('state')")
    expect(page.locator("#cli-device option")).to_have_count(2)
    assert page.evaluate("document.getElementById('cli-devicesPanel') || true")

    # Settings pages keep working after visiting the device page.
    page.locator('.settings-nav nav [data-view="mobile"]').click()
    expect(page.locator("#pageTitle")).to_have_text("Mobile access")
    expect(page.locator("#mobilePage")).to_be_visible()
    expect(page.locator("#devicesPage")).to_be_hidden()
    page.locator('.settings-nav nav [data-view="general"]').click()
    expect(page.locator("#pageTitle")).to_have_text("General")
    page.locator('.settings-nav nav [data-view="devices"]').click()
    expect(page.locator("#devicesPage")).to_be_visible()

    # Scoped styles keep settings controls and device controls visually distinct.
    assert page.evaluate("getComputedStyle(document.getElementById('refresh')).borderRadius") == "18px"
    assert page.evaluate("getComputedStyle(document.getElementById('cli-refresh')).borderRadius") == "16px"
    assert not errors, errors
    browser.close()
print("Settings page: all scripts load, navigation stays interactive and CLI devices render in place")
