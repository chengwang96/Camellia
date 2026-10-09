from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1180, "height": 820}, reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""
      window.deviceCalls = []; window.savedPreferences = {}; window.hiddenModels = {};
      const empty = { ok: true, result: {}, engines: [], providers: [], models: [], config: { providers: [], usage: {}, active: {} }, state: {} };
      window.dshDesktop = new Proxy({}, { get: (_target, name) => {
        if (String(name).startsWith('on')) return () => () => {};
        if (name === 'workbenchSaveSettings') return async patch => {
          if (window.failPreferences) return {ok:false,error:'Could not save preferences'};
          if (patch.hiddenSubscriptionModels) Object.assign(window.hiddenModels, patch.hiddenSubscriptionModels);
          window.savedPreferences = patch; return {ok:true};
        };
        if (name === 'apiRouterGetState') return async () => {
          const state = {...empty, enabled:true, models:['model-a','model-b']};
          return window.deferRouter ? new Promise(resolve => window.pendingRouters.push(() => resolve(state))) : state;
        };
        if (name === 'workbenchSettings') return async () => ({ ...empty, version: '0.3.0', dataPath: '/test-profile/camellia', language: 'en', theme: 'system', hiddenSubscriptionModels: window.hiddenModels });
        if (name === 'codexAccountState') return async payload => payload?.id === 'other'
          ? {ok:true, models:[{id:'gpt-other',name:'GPT Other'}]}
          : {ok:true, activeId:'default', accounts:[{id:'default',signedIn:true},{id:'other',signedIn:true}], models:[{id:'gpt-a',name:'GPT A'},{id:'gpt-b',name:'GPT B'}]};
        if (name === 'kimiAccountState') return async () => ({ok:true,models:[{id:'kimi-a',name:'Kimi A'}]});
        if (name === 'antigravityAccountState') return async () => ({ok:true,models:[{id:'google-a',name:'Google A'}]});
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
    page.goto((root / "src/renderer/settings/api-settings.html").as_uri() + "?page=models")
    page.wait_for_load_state("networkidle")
    expect(page.locator('#pageTitle')).to_have_text('Model Settings')
    page.evaluate("config = null")
    page.locator('[data-view=models]').click()
    expect(page.locator('#pageTitle')).to_have_text('Model Settings')
    page.locator('[data-view=general]').click()
    expect(page.locator('#pageTitle')).to_have_text('General')
    page.locator('[data-view=models]').click()
    expect(page.locator('#pageTitle')).to_have_text('Model Settings')
    page.locator('[data-view=general]').click()
    page.evaluate("refresh(true)")
    expect(page.locator('#generalPage #pythonCard')).to_be_visible()
    expect(page.locator('#quickSwitchModels')).to_be_hidden()
    page.locator('[data-view=models]').click()
    expect(page.locator('#pageTitle')).to_have_text('Model Settings')
    expect(page.locator('#pythonCard')).to_be_hidden()
    expect(page.locator('#contextCapacityPanel, #contextProbeDialog')).to_have_count(0)

    # One model and one reasoning-level menu per engine, aligned in one grid.
    expect(page.locator('#quickSwitchModels .quick-switch-model')).to_have_count(6)
    expect(page.locator('#quickSwitchModels .quick-switch-level')).to_have_count(6)
    expect(page.locator('#subscriptionModels .subscription-model-group')).to_have_count(3)
    expect(page.locator('#subscriptionModels .subscription-model-row')).to_have_count(5)
    expect(page.locator('#subscriptionModels .subscription-model-row span[title="gpt-other"]')).to_have_text('GPT Other')
    page.locator('#quickSwitch-codex').select_option('gpt-b')
    page.wait_for_function("savedPreferences.quickSwitchModels?.codex === 'gpt-b'")
    page.locator('#subscriptionModels .subscription-model-row', has_text='GPT B').locator('input').uncheck()
    page.wait_for_function("hiddenModels.codex?.includes('gpt-b')")
    expect(page.locator('#quickSwitch-codex')).to_have_value('gpt-b')
    expect(page.locator('#quickSwitch-codex option[value="gpt-b"]')).to_be_disabled()
    page.locator('#subscriptionModels .subscription-model-row', has_text='Kimi A').locator('input').uncheck()
    page.wait_for_function("hiddenModels.kimi?.includes('kimi-a')")
    page.locator('#subscriptionModels .subscription-model-row', has_text='Google A').locator('input').uncheck()
    page.wait_for_function("hiddenModels.antigravity?.includes('google-a')")
    page.evaluate('window.failPreferences = true')
    page.locator('#subscriptionModels .subscription-model-row', has_text='GPT A').locator('input').click()
    expect(page.locator('#status')).to_contain_text('Could not save preferences')
    expect(page.locator('#subscriptionModels .subscription-model-row', has_text='GPT A').locator('input')).to_be_checked()
    page.evaluate('window.failPreferences = false')
    page.locator('#quickSwitch-codex').select_option('model-b')
    page.wait_for_function("savedPreferences.quickSwitchModels?.codex === 'model-b'")
    page.locator('#subscriptionModels .subscription-model-row', has_text='GPT Other').locator('input').uncheck()
    page.wait_for_function("hiddenModels.codex?.includes('gpt-other')")
    expect(page.locator('#quickSwitch-codex')).to_have_value('model-b')
    page.locator('#quickSwitchLevel-codex').select_option('high')
    page.wait_for_function("savedPreferences.quickSwitchLevels?.codex === 'high'")
    expect(page.locator('#quickSwitchLevel-codex')).to_have_value('high')
    # A failed clear must retain both the saved model and its reasoning level.
    page.evaluate('window.failPreferences = true')
    page.locator('#quickSwitch-codex').select_option('')
    expect(page.locator('#status')).to_contain_text('Could not save preferences')
    expect(page.locator('#quickSwitch-codex')).to_have_value('model-b')
    expect(page.locator('#quickSwitchLevel-codex')).to_have_value('high')
    page.evaluate('window.failPreferences = false')
    page.locator('#quickSwitch-codex').select_option('')
    page.wait_for_function("savedPreferences.quickSwitchModels?.codex === ''")
    expect(page.locator('#quickSwitchLevel-codex')).to_have_value('')

    # Concurrent refreshes can finish out of order. Only the latest preferences
    # may replace the table, with one header and one pair of menus per engine.
    page.evaluate("""() => {
      window.deferRouter = true; window.pendingRouters = []; window.quickRenderTasks = [];
      for (const model of ['model-b', 'model-b', 'model-a']) {
        quickRenderTasks.push(renderQuickSwitchModels({ ...modelPreferences,
          quickSwitchModels: { ...modelPreferences.quickSwitchModels, codex: model } }, subscriptionModelAccounts));
      }
    }""")
    assert page.evaluate('pendingRouters.length') == 3
    page.evaluate('pendingRouters[2]()')
    expect(page.locator('#quickSwitch-codex')).to_have_value('model-a')
    page.evaluate('() => { pendingRouters[0](); pendingRouters[1](); }')
    page.evaluate('Promise.all(quickRenderTasks)')
    expect(page.locator('#quickSwitchModels .quick-switch-head')).to_have_count(1)
    expect(page.locator('#quickSwitchModels .quick-switch-model')).to_have_count(6)
    expect(page.locator('#quickSwitchModels .quick-switch-level')).to_have_count(6)
    expect(page.locator('#quickSwitch-codex')).to_have_value('model-a')
    page.evaluate('async () => { deferRouter = false; await renderQuickSwitchModels(modelPreferences, subscriptionModelAccounts); }')

    # Every settings script must load: a name collision here used to break the whole panel.
    # Compare the rendered categories rather than a bare count so a renamed or
    # dropped page fails with a useful diff instead of an off-by-one.
    views = page.locator(".settings-nav nav [data-view]").evaluate_all(
        "els => els.map(el => el.dataset.view)")
    assert views == ["subscriptions", "providers", "usage", "general", "data", "network", "engines",
                     "models", "archived", "mobile", "devices"], views
    for language in ["en", "zh-CN"]:
        page.evaluate("language => CamelliaI18n.setLanguage(language)", language)
        expect(page.locator('#pageTitle')).to_have_text('Model Settings' if language == 'en' else '模型设置')
        for width in [1180, 850, 700, 390, 320]:
            page.set_viewport_size({"width": width, "height": 820})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (language, width, 'models')
    page.set_viewport_size({"width": 1180, "height": 1000})
    output = root / "dist/engine-settings-qa"
    output.mkdir(parents=True, exist_ok=True)
    for scheme in ['light', 'dark']:
        page.emulate_media(color_scheme=scheme)
        page.screenshot(path=str(output / f"models-{scheme}.png"))
    page.emulate_media(color_scheme='light')
    page.evaluate("CamelliaI18n.setLanguage('en')")
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
                update_row = page.locator(".app-update").filter(has=page.locator("#checkAppUpdate"))
                row = update_row.bounding_box()
                actions = update_row.locator(".app-update-actions").bounding_box()
                assert abs(actions["x"] + actions["width"] - row["x"] - row["width"]) < 2, (language, width)
                for button in update_row.locator(".app-update-actions button:visible").all():
                    box = button.bounding_box()
                    assert box["x"] >= row["x"] and box["x"] + box["width"] <= row["x"] + row["width"] + 1
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (language, width)
    page.set_viewport_size({"width": 1180, "height": 820})
    page.locator("#installAppUpdate").evaluate("el => el.hidden = true")
    output = root / "dist/engine-settings-qa"
    output.mkdir(parents=True, exist_ok=True)
    page.locator("#checkAppUpdate").scroll_into_view_if_needed()
    page.screenshot(path=str(output / "general-actions.png"))
    page.evaluate("CamelliaI18n.setLanguage('en')")
    page.locator('.settings-nav nav [data-view="devices"]').click()
    expect(page.locator("#devicesPage")).to_be_visible()

    # Scoped styles keep settings controls and device controls visually distinct.
    assert page.evaluate("getComputedStyle(document.getElementById('checkAppUpdate')).borderRadius") == "18px"
    assert page.evaluate("getComputedStyle(document.getElementById('cli-refresh')).borderRadius") == "16px"
    assert not errors, errors
    browser.close()
print("Settings page: model and general groups, quick-switch saves, bilingual responsive layout and CLI device navigation passed")
