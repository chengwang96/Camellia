"""Shared-conversation retention settings drive the real settings page.

Loads the real settings renderer against a fake desktop bridge, so the parking
TTL and per-engine session limit are exercised end to end: defaults render, an
edit saves through workbenchSaveSettings, and the reload reflects the saved
value. No Electron startup and no network calls.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]

# The bridge records every save and echoes a mutable preferences object, so the
# page both reads defaults and observes the values it just wrote.
BRIDGE = """
  window.savedSettings = [];
  const defaults = { language: 'en', theme: 'system', autoRefreshBalances: true, accountRefreshMinutes: 15,
    closeToTray: false, version: '0.3.0', dataPath: '/test-profile/camellia',
    conversations: { mode: 'direct', warnOnSwitch: false, showOrigin: false, sessionTtlMinutes: 30, sessionLimit: 4 } };
  // localStorage survives the reload below, so the fake bridge behaves like the
  // persisted main-process configuration rather than resetting to defaults.
  const savedStore = (() => { try { return JSON.parse(localStorage.getItem('retention-prefs') || 'null'); } catch { return null; } })();
  const state = { ...defaults, ...(savedStore || {}) };
  const empty = { ok: true, result: {}, engines: [], providers: [], models: [], config: { providers: [], usage: {}, active: {} }, state: {} };
  window.dshDesktop = new Proxy({}, { get: (_target, name) => {
    if (String(name).startsWith('on')) return () => () => {};
    if (name === 'workbenchSettings') return async () => ({ ...empty, ...state });
    if (name === 'workbenchSaveSettings') return async payload => {
      window.savedSettings.push(payload);
      if (payload && payload.conversations) {
        // Mirror the main process: persist and re-serve exactly what was sent,
        // so a reload reads back the saved value.
        state.conversations = payload.conversations;
        if (payload.language) state.language = payload.language;
        if (payload.theme) state.theme = payload.theme;
        localStorage.setItem('retention-prefs', JSON.stringify(state));
      }
      return { ok: true };
    };
    if (name === 'runtimeState') return async () => ({ ...empty, engines: [] });
    return () => Promise.resolve({ ...empty });
  } });
"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1160, "height": 900}, reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script(BRIDGE)
    page.goto((root / "src/renderer/settings/api-settings.html").as_uri() + "?page=general")
    page.wait_for_load_state("networkidle")

    ttl = page.locator("#conversationSessionTtl")
    limit = page.locator("#conversationSessionLimit")
    expect(ttl).to_be_visible()
    expect(limit).to_be_visible()
    expect(ttl).to_have_value("30")
    expect(limit).to_have_value("4")

    # Editing both fields persists them through the preferences payload.
    ttl.fill("5")
    ttl.press("Tab")
    limit.fill("2")
    limit.press("Tab")
    # Each field saves on change; poll briefly so both writes land before the
    # last one is read. wait_for_function evaluates a string, which the page's
    # Content Security Policy forbids, so poll through evaluate instead.
    for _ in range(50):
        if page.evaluate("window.savedSettings.length") >= 2:
            break
        page.wait_for_timeout(50)
    expect(page.locator("#status")).to_contain_text("Preferences saved")
    saved = page.evaluate("window.savedSettings.at(-1).conversations")
    assert saved["sessionTtlMinutes"] == 5 and saved["sessionLimit"] == 2, saved
    assert saved["mode"] == "direct" and saved["warnOnSwitch"] is False, saved

    # A reload shows the retained value, proving it is read back from settings.
    page.reload(wait_until="networkidle")
    expect(page.locator("#conversationSessionTtl")).to_have_value("5")
    expect(page.locator("#conversationSessionLimit")).to_have_value("2")

    # Localized labels exist for both rows in both languages.
    for language, ttl_label, limit_label in [
        ("en", "Keep a model's session briefly", "Models kept ready per engine"),
        ("zh-CN", "短暂保留模型的会话", "每个引擎保留就绪的模型数"),
    ]:
        page.evaluate("language => CamelliaI18n.setLanguage(language)", language)
        assert ttl_label in page.locator("#generalPage").inner_text()
        assert limit_label in page.locator("#generalPage").inner_text()

    # The new rows do not introduce horizontal overflow at narrow widths.
    for width in [1160, 700, 390, 320]:
        page.set_viewport_size({"width": width, "height": 900})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), width

    assert not errors, errors
    browser.close()
print("Conversation retention settings render, save, reload and localize")
