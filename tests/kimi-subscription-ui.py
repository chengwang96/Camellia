"""Headless Kimi account layout check using isolated metadata. No login or model calls."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')

def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response['result']

bridge = """window.dshDesktop = new Proxy({}, {get: (_, method) => {
  if (method === 'onKimiAccount') return fn => {window.deliverKimiAccount = fn; return () => {};};
  if (method === 'onProviderInsights') return fn => {window.deliverInsights = fn; return () => {};};
  if (method.startsWith('on')) return () => () => {};
  return payload => window.testRpc(method, payload);
}});"""
try:
    rpc('configureTestApi')
    rpc('seedKimiAccount')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        errors = []
        for width, theme in [(1440, 'light'), (960, 'dark')]:
            page = browser.new_page(viewport={'width': width, 'height': 1000}, color_scheme=theme)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.expose_function('testRpc', rpc)
            page.add_init_script(bridge)
            page.goto((repo/'src/renderer/settings/api-settings.html').as_uri()+'?page=engines&engine=kimi', wait_until='networkidle')
            expect(page.locator('#kimiAccountStatus')).to_contain_text('Signed in')
            expect(page.locator('#kimiConnection')).to_have_value('subscription')
            page.locator('#kimiModelDetails summary').click()
            expect(page.locator('#kimiModelList')).to_contain_text('Kimi Coding')
            page.locator('#kimiUsage').click()
            expect(page.locator('#balanceDetail')).to_contain_text('72% remaining')
            expect(page.locator('#balanceDetail')).to_contain_text('90% remaining')
            expect(page.locator('#balanceDetail')).to_contain_text('Resets')
            expect(page.locator('#balanceDetail .chart-dot')).to_have_count(2)
            expect(page.locator('#balanceDetail')).not_to_contain_text('$0')
            page.screenshot(path=str(preview/f'kimi-quota-{theme}.png'), animations='disabled')
            page.locator('[data-view=providers]').click()
            expect(page.locator('#subscriptionCards')).to_contain_text('Kimi account')
            expect(page.locator('#subscriptionCards')).to_contain_text('72% remaining')
            assert page.locator('#subscriptionCards img').evaluate('(img) => img.complete && img.naturalWidth > 0')
            page.screenshot(path=str(preview/f'kimi-provider-{theme}.png'), animations='disabled')
            page.locator('[data-view=usage]').click()
            expect(page.locator('#subscriptionUsageCards')).to_contain_text('Kimi Code')
            expect(page.locator('#usageSummary')).to_contain_text('0')
            expect(page.locator('#usageRows')).not_to_contain_text('Kimi account')
            page.locator('#subscriptionUsageCards [data-balance]').click()
            page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
            expect(page.locator('#balanceDetail')).to_contain_text('剩余 72%')
            expect(page.locator('#balanceDetail')).to_contain_text('5 小时')
            expect(page.locator('#balanceDetail')).to_contain_text('30 天观测记录')
            page.screenshot(path=str(preview/f'kimi-quota-zh-{theme}.png'), animations='disabled')
            page.evaluate("CamelliaI18n.setLanguage('en')")
            info = rpc('providerInsights')
            info['subscriptions'][0]['info'].update({'status': 'error', 'error': 'Could not load Kimi quota. Check your connection or refresh your account.'})
            page.evaluate('state => deliverInsights(state)', info)
            expect(page.locator('#balanceDetail')).to_contain_text('last successful result')
            expect(page.locator('#balanceDetail')).to_contain_text('72% remaining')
            page.evaluate('state => deliverInsights(state)', dict(info, subscriptions=[]))
            expect(page.locator('#balanceCards [data-balance="kimi-subscription"]')).to_have_count(0)
            expect(page.locator('#subscriptionOverview')).to_be_hidden()
            page.locator('[data-view=engines]').click()
            page.locator('#kimiConnectionPanel').evaluate("el => el.scrollIntoView({block: 'start'})")
            page.screenshot(path=str(preview/f'kimi-subscription-{theme}.png'), animations='disabled')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            state = rpc('kimiAccountState')
            state.update({'loginPending': True, 'login': {'verificationUrl': 'https://auth.kimi.com/device', 'userCode': 'TEST-123', 'expiresAt': 1790000000000}})
            page.evaluate('state => deliverKimiAccount(state)', state)
            expect(page.locator('#kimiUserCode')).to_have_text('TEST-123')
            expect(page.locator('#kimiCancelLogin')).to_be_visible()
            expect(page.locator('#kimiSignIn')).to_be_disabled()
            expect(page.locator('#kimiRefresh')).to_be_disabled()
            page.screenshot(path=str(preview/f'kimi-device-login-{theme}.png'), animations='disabled')
            state.update({'account': None, 'models': [], 'loginPending': False, 'login': None, 'error': 'Kimi sign-in timed out. Start sign-in again.'})
            page.evaluate('state => deliverKimiAccount(state)', state)
            expect(page.locator('#kimiAccountStatus')).to_contain_text('timed out')
            expect(page.locator('#kimiUserCode')).to_have_text('')
            expect(page.locator('#kimiSignIn')).to_be_enabled()
            page.close()
        assert errors == [], errors
        browser.close()
    print('PASS Kimi UI: subscription cards, usage separation, quota trends, bilingual labels, failure recovery, sign-out, account models and login; light/dark and narrow layout')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
