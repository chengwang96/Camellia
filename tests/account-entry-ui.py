"""Real preferences IPC; authorization is simulated and never opens a login."""
import json
import re
import subprocess
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')


def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response['result']


def wait_for(check, message='Timed out waiting for the automatic save'):
    for _ in range(200):
        if check():
            return
        time.sleep(0.05)
    raise AssertionError(message)


bridge = """window.calls=[]; window.accountListeners = {};
window.camelliaDevices = { onEvent: () => () => {}, onTransfer: () => () => {}, call: async () => ({ok:true,result:{}}) };
window.dshDesktop = new Proxy({}, {get: (_, method) => method.startsWith('on') ? fn => { accountListeners[method] = fn; return () => {}; } : async payload => {
  calls.push({method, payload});
  if (method === 'kimiSignIn') return {ok:true,installed:true,models:[],account:null,loginPending:true,
    login:{userCode:'TEST-123',verificationUrl:'https://auth.kimi.com/device',expiresAt:1790000000000}};
  if (method === 'codexSignIn') return {ok:true,installed:true,models:[],account:null,loginPending:true};
  return window.testRpc(method, payload);
}});"""
try:
    rpc('configureTestApi')
    for engine in ['kimi', 'codex', 'antigravity']:
        rpc(engine + 'SaveSettings', {'connection': 'api'})
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1180, 'height': 850})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=engines&engine=codex', wait_until='networkidle')
        expect(page.locator('#enginesPage select[id$="Connection"]')).to_have_count(0)
        expect(page.locator('#enginesPage')).not_to_contain_text('Manage subscription accounts')
        page.locator('#nativeDocuments summary').click()
        page.locator('#engineSource').fill('invalid unsaved TOML [')
        page.locator('[data-view=providers]').click()
        expect(page.locator('#pageTitle')).to_have_text('API Keys')
        expect(page.locator('#subscriptionAccounts')).not_to_be_visible()
        assert not page.evaluate("calls.some(call => call.method === 'subscriptionPreferencesGet')")
        page.locator('#port').fill('14223')
        page.locator('#port').blur()
        wait_for(lambda: any(call['method'] == 'apiRouterSaveConfig' for call in page.evaluate('window.calls')))
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('kimi-code')
        page.locator('#openPresetAccount').click()
        expect(page.locator('#addDialog')).not_to_be_visible()
        expect(page.locator('#subscriptionsPage')).to_be_visible()
        expect(page.locator('#port')).not_to_be_visible()
        expect(page.locator('#codexSignIn')).to_be_enabled()
        expect(page.locator('#kimiSignIn')).to_be_enabled()
        expect(page.locator('#googleSignIn, #googleRefresh')).to_have_count(0)
        expect(page.locator('#googleAccountPanel > .account-actions')).to_have_count(0)
        expect(page.locator('#codexConnection')).to_have_count(0)
        expect(page.locator('#enginesPage [id$="Connection"]')).to_have_count(0)
        page.locator('.account-shortcuts [data-account-engine=antigravity]').click()
        expect(page.locator('#googleAccountPanel')).to_be_in_viewport()
        expect(page.locator('#googleUseCredits')).to_be_focused()
        page.locator('.account-shortcuts [data-account-engine=kimi]').click()
        expect(page.locator('#kimiAccountPanel')).to_be_in_viewport()
        page.locator('#kimiLoginRegion').select_option('global')
        # Login preferences apply on change; wait for the automatic save instead
        # of a removed Save button.
        wait_for(lambda: rpc('kimiGetSettings')['region'] == 'global')
        expect(page.locator('#kimiSignIn')).to_be_enabled()
        page.locator('#kimiSignIn').click()
        expect(page.locator('#kimiUserCode')).to_have_text('TEST-123')
        expect(page.locator('#codexProxyUrl')).to_have_count(0)
        page.locator('#codexSignIn').click()
        expect(page.locator('#codexCancelLogin')).to_be_visible()
        expect(page.locator('#codexAddAccount')).to_be_disabled()
        page.evaluate("""() => {
          const account = {id:'default',signedIn:true,active:true,email:'signed@example.test'};
          window.signedAccount = {installed:true,models:[{id:'test',name:'Test model'}],account:{email:account.email},accounts:[account,{id:'account-1',signedIn:false}],loginPending:false};
          accountListeners.onCodexAccount(signedAccount);
        }""")
        page.evaluate("""() => {
          const windows = [{id:'weekly',label:'7d',usedPercent:20}];
          const latest = {at:new Date().toISOString(),windows};
          accountListeners.onProviderInsights({providers:{},keys:{},subscriptions:[{id:'codex:default',engine:'codex',name:'ChatGPT',label:'Test account',info:{latest,history:[latest]},capability:{supported:true}}]});
        }""")
        # The account panel keeps a hidden error-details disclosure; quota
        # history charts still belong to the separate usage page.
        expect(page.locator('#subscriptionAccounts details:visible, #subscriptionAccounts .chart-grid-layout')).to_have_count(0)
        expect(page.locator('#googleQuotaErrorDetails')).to_be_hidden()

        expect(page.locator('#codexAutoSwitchQuota')).not_to_be_visible()
        page.evaluate("accountListeners.onCodexAccount({...signedAccount,accounts:[signedAccount.accounts[0],{id:'backup',signedIn:true,email:'backup@example.test'}]})")
        expect(page.locator('#codexAutoSwitchQuota')).to_be_visible()
        page.locator('#codexAutoSwitchQuota').uncheck()
        wait_for(lambda: rpc('subscriptionPreferencesGet', {'engine':'codex'})['preferences']['autoSwitchQuota'] is False)
        page.evaluate("accountListeners.onCodexAccount(signedAccount)")
        expect(page.locator('#codexSignIn')).not_to_be_visible()
        expect(page.locator('#codexAddAccount')).to_be_visible()
        expect(page.locator('#codexAccountList .subscription-card')).to_have_count(1)
        page.evaluate("accountListeners.onCodexAccount({...signedAccount,loginPending:true})")
        expect(page.locator('#codexAddAccount')).to_be_disabled()
        expect(page.locator('#codexAccountList .subscription-card')).to_have_count(1)

        expect(page.locator('#googleProxyUrl')).to_have_count(0)
        baseline = len(page.evaluate('calls'))
        for engine in ['kimi', 'codex', 'antigravity']:
            assert rpc(engine + 'GetSettings')['connection'] == 'api'
        # The connection follows the session that last ran; the composer now
        # picks it from the model list, so no settings selector remains.
        rpc('codexSaveSettings', {'connection': 'subscription'})
        wait_for(lambda: rpc('codexGetSettings')['connection'] == 'subscription')
        page.locator('#googleUseCredits').check()
        wait_for(lambda: rpc('subscriptionPreferencesGet', {'engine': 'antigravity'})['preferences']['useG1Credits'] is True)
        # Account actions must not save engine or API-route settings.
        assert not page.evaluate("baseline => calls.slice(baseline).some(call => ['engineSettingsSave','apiRouterSaveConfig'].includes(call.method))", baseline)
        page.locator('[data-view=providers]').click()
        expect(page.locator('#port')).to_have_value('14223')
        expect(page.locator('#subscriptionAccounts')).not_to_be_visible()
        page.locator('[data-view=engines]').click()
        expect(page.locator('#engineSource')).to_have_value('invalid unsaved TOML [')
        expect(page.locator('#saveEngine')).to_be_enabled()
        expect(page.locator('#enginesPage [id$="SaveConnection"]')).to_have_count(0)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=engines&engine=antigravity&focus=account', wait_until='networkidle')
        expect(page.locator('#subscriptionsPage')).to_be_visible()
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=providers&focus=antigravity', wait_until='networkidle')
        expect(page.locator('#subscriptionsPage')).to_be_visible()
        assert rpc('antigravityGetSettings')['connection'] == 'api'
        page.set_viewport_size({'width': 600, 'height': 800})
        page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
        expect(page.locator('#pageTitle')).to_have_text('订阅账号')
        expect(page.locator('[data-view=providers]')).to_have_text('API Key')
        expect(page.locator('#googleSignIn, #googleRefresh')).to_have_count(0)
        expect(page.locator('#googleAccountList .subscription-card')).to_have_count(0)
        expect(page.locator('#googleAccountList')).to_contain_text('暂无账号。')
        page.evaluate("accountListeners.onAntigravityAccount({ok:true,installed:true,accounts:[{id:'default',signedIn:true,active:true}],usage:{}})")
        expect(page.locator('#googleAccountList .subscription-card')).to_have_count(1)
        page.evaluate("accountListeners.onAntigravityAccount({ok:true,installed:true,accounts:[{id:'default',signedIn:false,active:true}],usage:{}})")
        expect(page.locator('#googleAccountList .subscription-card')).to_have_count(0)
        # An expired model verification keeps the account visible with a warning
        # and a usable quota refresh instead of hiding it as signed out.
        page.evaluate("accountListeners.onAntigravityAccount({ok:true,installed:true,accounts:[{id:'default',signedIn:false,stale:true,active:true,quotaWindows:[{label:'Gemini\\u00a0Models \\u00b7 Weekly',usedPercent:5,resetsAt:'2026-10-08T18:47:45Z'}],verifiedAt:1790880533399,models:1}],usage:{}})")
        google = page.locator('#googleAccountList .subscription-card')
        expect(google).to_have_count(1)
        expect(google.locator('.subscription-state')).to_have_class(re.compile(r'\bstale\b'))
        expect(google.locator('.subscription-state')).to_contain_text('上次验证已过期')
        expect(google.locator('[data-card-action=refresh]')).to_be_enabled()
        expect(google.locator('.subscription-meter')).to_have_count(1)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        (repo / 'dist/ui-preview').mkdir(parents=True, exist_ok=True)
        page.locator('#googleAccountPanel').screenshot(path=str(repo / 'dist/ui-preview/subscription-accounts.png'))
        assert not errors, errors
        browser.close()
    print('PASS: separate subscription/API pages, account login, preferences, untouched drafts, old deep links and Chinese layout')
finally:
    driver.terminate()
    driver.wait(timeout=10)
