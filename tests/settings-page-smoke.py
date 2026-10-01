from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1180, "height": 820}, reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""
      window.deviceCalls = [];
      const empty = { ok: true, result: {}, engines: [], providers: [], models: [], config: { providers: [], usage: {}, active: {} }, state: {} };
      window.dshDesktop = new Proxy({}, { get: (_target, name) => {
        if (String(name).startsWith('on')) return () => () => {};
        if (name === 'workbenchSettings') return async () => ({ ...empty, version: '0.3.0', dataPath: '/test-profile/camellia', language: 'en', theme: 'system' });
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
    # Compare the rendered categories rather than a bare count so a renamed or
    # dropped page fails with a useful diff instead of an off-by-one.
    views = page.locator(".settings-nav nav [data-view]").evaluate_all(
        "els => els.map(el => el.dataset.view)")
    assert views == ["subscriptions", "providers", "usage", "general", "network", "engines",
                     "runtimes", "archived", "mobile", "devices"], views
    page.locator('.settings-nav nav [data-view="devices"]').click()
    expect(page.locator("#pageTitle")).to_have_text("CLI devices")
    expect(page.locator("#devicesPage")).to_be_visible()
    page.wait_for_function("deviceCalls.includes('state')")
    # The embedded page renders the connection view (not the standalone
    # workbench); its paired servers come from the settings bridge above.
    expect(page.locator("#cli-servers")).to_contain_text("GPU server")
    assert page.locator("#cli-tree, #cli-chat, #cli-prompt").count() == 0

    # Settings pages keep working after visiting the device page.
    page.locator('.settings-nav nav [data-view="mobile"]').click()
    expect(page.locator("#pageTitle")).to_have_text("Mobile access")
    expect(page.locator("#mobilePage")).to_be_visible()
    expect(page.locator("#devicesPage")).to_be_hidden()
    page.locator('.settings-nav nav [data-view="general"]').click()
    expect(page.locator("#pageTitle")).to_have_text("General")
    # Network is its own page: the connection choice and the one-click
    # connectivity test live there, and neither is on General any more.
    expect(page.locator("#networkPage")).to_be_hidden()
    page.locator('.settings-nav nav [data-view="network"]').click()
    expect(page.locator("#pageTitle")).to_have_text("Network")
    expect(page.locator("#networkPage")).to_be_visible()
    expect(page.locator("#generalPage")).to_be_hidden()
    expect(page.locator("#networkMode")).to_be_visible()
    expect(page.locator("#networkTest")).to_have_text("Test all connections")
    for language in ["en", "zh-CN"]:
        page.evaluate("language => CamelliaI18n.setLanguage(language)", language)
        page.set_viewport_size({"width": 1180, "height": 820})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), language
    page.evaluate("CamelliaI18n.setLanguage('en')")
    page.locator('.settings-nav nav [data-view="general"]').click()
    expect(page.locator("#pageTitle")).to_have_text("General")
    for language in ["en", "zh-CN"]:
        page.evaluate("language => CamelliaI18n.setLanguage(language)", language)
        for width in [1180, 850, 700, 390, 320]:
            page.set_viewport_size({"width": width, "height": 820})
            # An available update reveals a second action; both states must keep
            # the action group at the right edge without horizontal overflow.
            for install_visible in [False, True]:
                page.locator("#installAppUpdate").evaluate("(el, visible) => el.hidden = !visible", install_visible)
                page.locator("#checkAppUpdate").scroll_into_view_if_needed()
                row = page.locator(".app-update").bounding_box()
                actions = page.locator(".app-update-actions").bounding_box()
                assert abs(actions["x"] + actions["width"] - row["x"] - row["width"]) < 2, (language, width)
                for button in page.locator(".app-update-actions button:visible").all():
                    box = button.bounding_box()
                    assert box["x"] >= row["x"] and box["x"] + box["width"] <= row["x"] + row["width"] + 1
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (language, width)
    page.set_viewport_size({"width": 1180, "height": 820})
    page.locator("#installAppUpdate").evaluate("el => el.hidden = true")
    output = root / "dist/engine-settings-qa"
    output.mkdir(parents=True, exist_ok=True)
    page.locator(".app-update").scroll_into_view_if_needed()
    page.screenshot(path=str(output / "general-actions.png"))
    page.evaluate("CamelliaI18n.setLanguage('en')")
    page.locator('.settings-nav nav [data-view="devices"]').click()
    expect(page.locator("#devicesPage")).to_be_visible()

    # Scoped styles keep settings controls and device controls visually distinct.
    assert page.evaluate("getComputedStyle(document.getElementById('refresh')).borderRadius") == "18px"
    assert page.evaluate("getComputedStyle(document.getElementById('cli-refresh')).borderRadius") == "16px"
    assert not errors, errors
    browser.close()
print("Settings page: all scripts load, navigation stays interactive and CLI devices render in place")
