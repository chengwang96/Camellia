"""Verify the General page's application update controls against a stubbed main process."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1180, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""
      window.updateListeners = [];
      window.updateCalls = [];
      window.empty = { ok: true, result: {}, engines: [], providers: [], models: [],
        config: { providers: [], usage: {}, active: {} }, state: {},
        language: 'en', theme: 'system', autoRefreshBalances: false, closeToTray: false,
        accountRefreshMinutes: 15, conversations: {}, dataPath: '/tmp/camellia', version: '1.3.0' };
      window.updateResult = { ok: true, current: '1.3.0', latest: '1.4.0', updateAvailable: true,
        supported: true, kind: 'installer', name: 'Camellia-Setup-1.4.0-win-x64.exe', size: 104857600,
        notes: 'Fixed things.', publishedAt: '2026-09-01T00:00:00Z' };
      window.dshDesktop = new Proxy({}, { get: (_target, name) => {
        if (name === 'onAppUpdateState') return callback => { window.updateListeners.push(callback); return () => {}; };
        if (String(name).startsWith('on')) return () => () => {};
        if (name === 'appUpdateCheck') return async () => { window.updateCalls.push('check'); return window.updateResult; };
        if (name === 'appUpdateInstall') return async () => { window.updateCalls.push('install'); return { ok: true, version: '1.4.0', restarting: true }; };
        if (name === 'camelliaDevices') return { onEvent() {}, onTransfer() {}, async call() { return { ok: true, result: {} }; } };
        return () => Promise.resolve({ ...window.empty });
      } });
    """)
    page.goto((root / "src/renderer/settings/api-settings.html").as_uri() + "?page=general")
    page.wait_for_load_state("networkidle")

    expect(page.locator("#appUpdateStatus")).to_contain_text("Check the official release feed")
    expect(page.locator("#installAppUpdate")).to_be_hidden()
    expect(page.locator("#appUpdateDetails")).to_be_hidden()

    # Checking is read-only and must not start a download.
    page.locator("#checkAppUpdate").click()
    expect(page.locator("#appUpdateStatus")).to_contain_text("v1.4.0 is available")
    expect(page.locator("#installAppUpdate")).to_be_visible()
    expect(page.locator("#appUpdateDetails")).to_be_visible()
    expect(page.locator("#appUpdateNotes")).to_contain_text("Fixed things.")
    assert page.evaluate("window.updateCalls") == ["check"]

    # Progress and phase text follow the main process broadcasts.
    page.evaluate("window.updateListeners.forEach(fn => fn({ status: 'downloading', percent: 42 }))")
    expect(page.locator("#appUpdateStatus")).to_contain_text("42%")
    expect(page.locator("#appUpdateProgress")).to_be_visible()
    page.evaluate("window.updateListeners.forEach(fn => fn({ status: 'applying', percent: 100 }))")
    expect(page.locator("#appUpdateStatus")).to_contain_text("Installing the update")

    page.locator("#installAppUpdate").click()
    page.wait_for_function("window.updateCalls.includes('install')")
    assert page.evaluate("window.updateCalls") == ["check", "install"]

    # Up-to-date and unsupported platforms must not offer an install button.
    page.evaluate("window.updateResult = { ok: true, current: '1.3.0', latest: '1.3.0', updateAvailable: false, supported: false }")
    page.locator("#checkAppUpdate").click()
    expect(page.locator("#appUpdateStatus")).to_contain_text("up to date")
    expect(page.locator("#installAppUpdate")).to_be_hidden()
    page.evaluate("""window.updateResult = { ok: true, current: '1.3.0', latest: '1.4.0', updateAvailable: true,
      supported: false, name: 'Camellia.AppImage' }""")
    page.locator("#checkAppUpdate").click()
    expect(page.locator("#appUpdateStatus")).to_contain_text("no in-place package")
    expect(page.locator("#installAppUpdate")).to_be_hidden()

    # A failure is shown inline and the controls stay usable.
    page.evaluate("window.updateResult = { ok: false, error: 'Update check failed (HTTP 503)' }")
    page.locator("#checkAppUpdate").click()
    expect(page.locator("#appUpdateStatus")).to_contain_text("HTTP 503")
    expect(page.locator("#checkAppUpdate")).to_be_enabled()

    assert not errors, errors
    page.screenshot(path=str(root / "dist/app-update-qa.png"), full_page=True)
    browser.close()
    print("Application update UI: idle, available, downloading, applying, installing, up-to-date, unsupported and error states passed")
