"""Account/API model choices stay unambiguous and switch in both directions."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = r"""(() => {
  window.settings = {model:'route-only',connection:'api',permissionMode:'ask'};
  window.savedSettings = [];
  window.accountUnavailable = false;
  window.hiddenModels = {}; window.visibilityReads = 0;
  window.settingsTarget = null;
  const accountState = async () => {
    if (window.accountUnavailable) throw new Error('Account temporarily unavailable');
    return {ok:true,models:[{id:'account-only',name:'Account model'}, {id:'shared-model',name:'Shared account model'}]};
  };
  window.dshDesktop = new Proxy({
    sharedConversations: true,
    conversationCommand: async ({action,payload}) => {
      if (action === 'list-sessions') return {ok:true,sessions:[],workspaces:[],pagination:{}};
      if (action === 'get-settings') return {...window.settings};
      if (action === 'save-settings') {
        window.savedSettings.push(payload);
        Object.assign(window.settings,payload);
        return {ok:true,settings:{...window.settings}};
      }
      return {ok:true};
    },
    apiRouterGetState: async () => ({enabled:true,models:['route-only','shared-model'],providers:[]}),
    workbenchSettings: async () => { window.visibilityReads++; return {ok:true,hiddenSubscriptionModels:window.hiddenModels}; },
    openSettingsWindow: async target => { window.settingsTarget = target; return {ok:true}; },
    codexAccountState: accountState, kimiAccountState: accountState, antigravityAccountState: accountState,
    onEngineSettingsChanged: fn => {window.refreshSettings = fn;},
  }, {get: (target, key) => key in target ? target[key] : key.startsWith('on') ? () => () => {} : async () => ({ok:true})});
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for engine in ['codex', 'kimi', 'antigravity']:
        page = browser.new_page(viewport={'width': 1160, 'height': 820})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=' + engine, wait_until='networkidle')
        page.wait_for_function('uiReady')

        def model_menu():
            page.locator('#modelPill').click()
            page.locator('.pop-row').filter(has_text='Model').first.click()
            return page.locator('.dsh-pop').last

        menu = model_menu()
        expect(menu.locator('.pop-opt')).to_have_count(3)
        expect(menu.locator('.pop-opt', has_text='shared-model')).to_have_count(1)
        expect(menu.locator('.pop-opt', has_text='Shared account model')).to_have_count(0)
        menu.locator('.pop-opt', has_text='Account model').click()
        page.wait_for_function("settings.connection === 'subscription' && settings.model === 'account-only'")
        expect(page.locator('#modelPillName')).to_have_text('Account model')
        expect(page.locator('#statusLine')).to_contain_text('Model changed: Account model')

        # Hiding the selected subscription model removes it from choices but
        # keeps the current conversation and its model label intact.
        reads = page.evaluate('visibilityReads')
        page.evaluate("engine => { hiddenModels = {[engine]: ['account-only']}; refreshSettings({engine}); }", engine)
        page.wait_for_function('before => visibilityReads > before', arg=reads)
        expect(page.locator('#modelPillName')).to_have_text('Account model')
        menu = model_menu()
        expect(menu.get_by_text('Account model', exact=True)).to_have_count(0)
        expect(menu.locator('.pop-manage')).to_have_text('Manage subscription models')
        menu.locator('.pop-manage').click()
        assert page.evaluate("settingsTarget?.page") == 'models'
        if engine == 'antigravity':
            reads = page.evaluate('visibilityReads')
            page.evaluate("engine => { hiddenModels = {[engine]: ['account-only', 'shared-model']}; refreshSettings({engine}); }", engine)
            page.wait_for_function('before => visibilityReads > before', arg=reads)
            menu = model_menu()
            expect(menu.locator('.pop-opt')).to_have_count(0)
            expect(menu).to_contain_text('No visible models')
            page.locator('#modelPill').click()
        reads = page.evaluate('visibilityReads')
        page.evaluate("engine => { hiddenModels = {}; refreshSettings({engine}); }", engine)
        page.wait_for_function('before => visibilityReads > before', arg=reads)
        if engine != 'antigravity':
            # When the account copy of an ID is hidden, choosing its visible
            # API copy must change the connection too.
            reads = page.evaluate('visibilityReads')
            page.evaluate("engine => { hiddenModels = {[engine]: ['shared-model']}; refreshSettings({engine}); }", engine)
            page.wait_for_function('before => visibilityReads > before', arg=reads)
            menu = model_menu()
            menu.get_by_text('shared-model', exact=True).click()
            page.wait_for_function("settings.connection === 'api' && settings.model === 'shared-model'")
            menu = model_menu()
            menu.get_by_text('Account model', exact=True).click()
            page.wait_for_function("settings.connection === 'subscription' && settings.model === 'account-only'")
            reads = page.evaluate('visibilityReads')
            page.evaluate("engine => { hiddenModels = {}; refreshSettings({engine}); }", engine)
            page.wait_for_function('before => visibilityReads > before', arg=reads)

        menu = model_menu()
        if engine == 'antigravity':
            # Google subscription mode owns its native model list. Returning
            # to API routes is a settings change, not a subscription-model pick.
            expect(menu.locator('.pop-opt')).to_have_count(2)
            expect(menu).not_to_contain_text('route-only')
            page.locator('#modelPill').click()
            page.evaluate("settings.connection = 'api'; settings.model = 'route-only'; refreshSettings({engine: 'antigravity'})")
            expect(page.locator('#modelPillName')).to_have_text('route-only')
            menu = model_menu()
        expect(menu.locator('.pop-opt')).to_have_count(3)
        expect(menu.locator('.pop-opt', has_text='Shared account model')).to_have_count(0 if engine == 'antigravity' else 1)
        menu.locator('.pop-opt', has_text='route-only').click()
        page.wait_for_function("settings.connection === 'api' && settings.model === 'route-only'")

        # A failed optional account read must not prevent API settings loading,
        # or leave the previous account models selectable.
        page.evaluate("accountUnavailable = true; settings.model = 'shared-model'; refreshSettings({engine: '" + engine + "'})")
        expect(page.locator('#modelPillName')).to_have_text('shared-model')
        menu = model_menu()
        expect(menu.locator('.pop-opt')).to_have_count(2)
        expect(menu).not_to_contain_text('Account model')

        # An older saved model can belong only to the other connection. Picking
        # it must repair the connection even though its ID has not changed.
        page.locator('#modelPill').click()
        expect(page.locator('.dsh-pop')).to_have_count(0)
        page.evaluate("accountUnavailable = false; settings.model = 'account-only'; refreshSettings({engine: '" + engine + "'})")
        expect(page.locator('#modelPillName')).to_contain_text('account-only')
        menu = model_menu()
        menu.locator('.pop-opt', has_text='Account model').click()
        page.wait_for_function("settings.connection === 'subscription'", timeout=5000)
        assert errors == [], errors
        page.close()
    browser.close()
print('PASS account/API model switching, duplicate IDs, labels and account failure isolation')
