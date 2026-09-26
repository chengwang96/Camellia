"""Account entry points with isolated real settings IPC and simulated authorization.

No personal profiles, desktop controls, browser login, or model API calls.
"""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')

def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response['result']

bridge = """window.calls=[];
window.dshDesktop = new Proxy({}, {get: (_, method) => method.startsWith('on') ? () => () => {} : async payload => {
  calls.push({method, payload});
  if (method === 'kimiSignIn') return {ok:true,installed:true,models:[],account:null,loginPending:true,
    login:{userCode:'TEST-123',verificationUrl:'https://auth.kimi.com/device',expiresAt:1790000000000}};
  if (method === 'antigravitySignIn') return {ok:true,opened:true};
  return window.testRpc(method, payload);
}});"""
try:
    rpc('configureTestApi')
    rpc('kimiSaveSettings', {'connection': 'api'})
    rpc('antigravitySaveSettings', {'connection': 'api'})
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1180, 'height': 850})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo/'src/renderer/settings/api-settings.html').as_uri(), wait_until='networkidle')
        expect(page.locator('.account-shortcuts button')).to_have_count(3)
        page.locator('[data-view=providers]').click()
        expect(page.locator('#port')).to_be_visible()
        page.locator('#port').fill('14223')
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('kimi-code')
        expect(page.locator('#preset option:checked')).to_have_text('Kimi Code (API key)')
        expect(page.locator('#presetAccountHint')).to_contain_text('browser sign-in in Kimi Code')
        page.screenshot(path=str(preview/'kimi-account-entry.png'), animations='disabled')
        page.locator('#openPresetAccount').click()
        expect(page.locator('#addDialog')).not_to_be_visible()
        expect(page.locator('[data-engine=kimi]')).to_have_attribute('aria-selected', 'true')
        expect(page.locator('#kimiAccountPanel')).to_be_visible()
        expect(page.locator('#kimiConnection')).to_have_value('subscription')
        expect(page.locator('#kimiSaveConnection')).to_be_focused()
        expect(page.locator('#kimiSignIn')).to_be_disabled()
        assert rpc('engineSettingsGet', {'engine': 'kimi'})['desktop']['connection'] == 'api'
        assert not page.evaluate("calls.some(c=>['engineSettingsSave','kimiSignIn','antigravitySignIn','apiRouterSaveConfig'].includes(c.method))")
        page.locator('#kimiLoginRegion').select_option('global')
        page.locator('#kimiSaveConnection').click()
        expect(page.locator('#kimiSignIn')).to_be_enabled()
        assert rpc('engineSettingsGet', {'engine': 'kimi'})['desktop']['connection'] == 'subscription'
        page.locator('#kimiSignIn').click()
        expect(page.locator('#kimiUserCode')).to_have_text('TEST-123')
        expect(page.locator('#kimiOpenLogin')).to_be_enabled()
        assert page.evaluate("calls.filter(c=>c.method==='kimiSignIn').length") == 1

        page.locator('[data-view=providers]').click()
        expect(page.locator('#port')).to_have_value('14223')
        expect(page.locator('#save')).to_be_enabled()
        assert not page.evaluate("calls.some(c=>c.method==='apiRouterSaveConfig')")
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('gemini')
        expect(page.locator('#presetAccountHint')).to_contain_text('Google account sign-in is available in Antigravity')
        # A small CSS viewport represents the reduced space when zoomed in.
        page.set_viewport_size({'width': 430, 'height': 420})
        expect(page.locator('#openPresetAccount')).to_be_in_viewport()
        assert page.locator('#addDialog').evaluate('el=>el.scrollWidth<=el.clientWidth')
        page.screenshot(path=str(preview/'google-account-entry-compact.png'), animations='disabled')
        page.locator('#openPresetAccount').click()
        expect(page.locator('[data-engine=antigravity]')).to_have_attribute('aria-selected', 'true')
        expect(page.locator('#googleAccountPanel')).to_be_visible()
        expect(page.locator('#googleSaveConnection')).to_be_focused()
        expect(page.locator('#googleSaveConnection')).to_be_in_viewport()
        assert rpc('engineSettingsGet', {'engine': 'antigravity'})['desktop']['connection'] == 'api'
        page.locator('#googleSaveConnection').click()
        expect(page.locator('#googleSignIn')).to_be_enabled()
        page.locator('#googleSignIn').click()
        expect(page.locator('#status')).to_contain_text('Complete Google sign-in in the terminal')
        assert page.evaluate("calls.filter(c=>c.method==='antigravitySignIn').length") == 1

        page.set_viewport_size({'width': 1180, 'height': 850})
        page.locator('[data-view=providers]').click()
        page.locator('.account-shortcuts [data-account-engine=antigravity]').click()
        expect(page.locator('#googleSignIn')).to_be_focused()
        page.locator('[data-view=providers]').click()
        page.locator('.account-shortcuts [data-account-engine=kimi]').click()
        expect(page.locator('#kimiSignIn')).to_be_focused()
        page.locator('[data-view=providers]').click()
        page.screenshot(path=str(preview/'account-sign-in-shortcuts.png'), animations='disabled')
        assert errors == [], errors
        browser.close()
    print('PASS account entries: Kimi/Google shortcuts, save before authorization, API edits retained, compact dialog, no real login')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
