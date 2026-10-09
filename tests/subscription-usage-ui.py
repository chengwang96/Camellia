"""Subscription accounting through real settings IPC and Chromium; no paid calls."""
import csv
import io
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')

def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    result = json.loads(driver.stdout.readline())
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result

bridge = """(() => {
  let router = () => {};
  window.testEmitRouter = value => router(value);
  window.dshDesktop = new Proxy({}, {get: (_, method) => {
    if (method === 'onApiRouterState') return callback => { router = callback; };
    if (method.startsWith('on')) return () => () => {};
    return async payload => (await window.testRpc(method, payload)).result;
  }});
})();"""

try:
    rpc('configureTestApi')
    rpc('seedSubscriptionUsage')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1180, 'height': 940}, accept_downloads=True)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri())
        page.wait_for_load_state('networkidle')
        page.locator('[data-view=usage]').click()
        expect(page.locator('#usageRange')).to_have_value('all')
        page.locator('#usageRange').select_option('7')
        page.locator('#usageSource').select_option('subscription')
        expect(page.locator('#usageRows tr')).to_have_count(3)
        # Unpriced or incomplete usage is described in the note below the
        # figure, not appended to the headline amount.
        expect(page.locator('#subscriptionCost')).not_to_contain_text('Unpriced usage')
        expect(page.locator('#subscriptionCostNote')).to_contain_text('not your subscription bill')
        expect(page.locator('#subscriptionPriceStatus')).to_contain_text('Prices refresh automatically every day.')
        page.locator('#subscriptionPricesRefresh').click()
        expect(page.locator('#subscriptionPricesRefresh')).to_be_enabled(timeout=35000)
        expect(page.locator('#subscriptionCostNote')).to_contain_text('LiteLLM')
        expect(page.locator('#subscriptionUsageSince')).not_to_contain_text('{0}')
        expect(page.locator('#usageRows')).not_to_contain_text('gpt-5.3-codex')

        page.locator('#usageProvider').select_option('subscription:codex')
        expect(page.locator('#usageRows tr')).to_have_count(2)
        page.locator('#usageKey').select_option('subscription:codex:default')
        expect(page.locator('#usageRows tr')).to_have_count(1)
        expect(page.locator('#usageRows')).to_contain_text('Personal')
        expect(page.locator('#usageRows')).to_contain_text('10,000')
        expect(page.locator('#subscriptionCost')).to_contain_text('$0.0220')
        page.locator('#usageMetric').select_option('estimatedCostUsd')
        expect(page.locator('#usageChart svg')).to_have_count(1)

        page.locator('#usageRange').select_option('all')
        expect(page.locator('#usageRows tr')).to_have_count(2)
        with page.expect_download() as download:
            page.locator('#exportUsage').click()
        rows = list(csv.DictReader(io.StringIO(Path(download.value.path()).read_text(encoding='utf-8-sig'))))
        assert len(rows) == 2 and all(row['Source'] == 'subscription' for row in rows)
        current = next(row for row in rows if row['Model'] == 'gpt-5.4')
        assert current['Input tokens'] == '10000' and current['Cache-read tokens'] == '8000'
        assert abs(float(current['Standard API estimate (USD)']) - .022) < 1e-10
        assert current['Account / Key ID'] == 'subscription:codex:default'

        page.locator('#usageKey').select_option('subscription:codex:account-1')
        expect(page.locator('#subscriptionCost')).to_have_text('Unavailable')
        expect(page.locator('#usageRows')).to_contain_text('future-model')
        page.locator('#usageSource').select_option('api')
        expect(page.locator('#subscriptionCostCard')).to_be_hidden()
        expect(page.locator('#usageRows')).not_to_contain_text('future-model')
        page.evaluate('''() => {
          const today = localDay(new Date());
          live.usageArchive = [
            {id: 'history-test', providerId: 'test', providerName: 'Local test', keyName: 'Earlier key',
              usage: {requests: 2, inputTokens: 200, outputTokens: 8,
                byModel: {'test-model': {requests: 2, inputTokens: 200, outputTokens: 8}},
                daily: {[today]: {'test-model': {requests: 1, inputTokens: 50, outputTokens: 2}}}}},
            {id: 'history-gone', providerId: 'gone', providerName: 'Removed provider', keyName: 'Former account',
              usage: {requests: 1, inputTokens: 25, byModel: {'test-model': {requests: 1, inputTokens: 25}}}},
            {id: 'history-gone-second', providerId: 'gone', providerName: 'Removed provider', keyName: 'Another account',
              usage: {requests: 1, inputTokens: 15, byModel: {'test-model': {requests: 1, inputTokens: 15}}}}
          ];
          fillUsageFilters(); renderUsage();
        }''')
        page.locator('#usageProvider').select_option('test')
        expect(page.locator('#usageKey')).to_contain_text('Earlier key')
        assert page.evaluate("usageData.filter(row => row.keyId === 'history-test').reduce((sum, row) => sum + row.inputTokens, 0)") == 200
        page.locator('#usageRange').select_option('7')
        assert page.evaluate("usageData.filter(row => row.keyId === 'history-test').reduce((sum, row) => sum + row.inputTokens, 0)") == 50
        page.locator('#usageRange').select_option('all')
        page.locator('#usageProvider').select_option('history:gone')
        assert page.evaluate("usageData.some(row => row.keyId === 'history-gone' && row.inputTokens === 25)")
        assert page.evaluate("usageData.some(row => row.keyId === 'history-gone-second' && row.inputTokens === 15)")
        expect(page.locator('#usageProvider option[value="history:gone"]')).to_have_count(1)
        page.evaluate('''() => { live.usageArchive = []; fillUsageFilters(); renderUsage(); }''')

        # A key's Usage shortcut must leave subscription-only filters behind.
        page.locator('#usageSource').select_option('subscription')
        page.locator('#usageProvider').select_option('subscription:codex')
        page.locator('#usageKey').select_option('subscription:codex:account-1')
        page.locator('#usageModel').select_option('future-model')
        page.locator('[data-view=providers]').click()
        page.locator('#providers [data-select=test]').first.click()
        page.locator('[data-key-usage=test-key]').click()
        expect(page.locator('#usageSource')).to_have_value('api')
        expect(page.locator('#usageProvider')).to_have_value('test')
        expect(page.locator('#usageKey')).to_have_value('test-key')
        expect(page.locator('#usageModel')).to_have_value('')
        expect(page.locator('#usageMetric')).to_have_value('tokens')
        expect(page.locator('#subscriptionCostCard')).to_be_hidden()

        # Restart the real main-process harness and reload persisted counters.
        rpc('restart')
        page.reload(); page.wait_for_load_state('networkidle')
        page.locator('[data-view=usage]').click()
        page.locator('#usageRange').select_option('7')
        page.locator('#usageSource').select_option('subscription')
        expect(page.locator('#usageRows tr')).to_have_count(3)
        page.locator('[data-view=general]').click()
        page.locator('#language').select_option('zh-CN')
        expect(page.locator('html')).to_have_attribute('lang', 'zh-CN')
        page.locator('[data-view=usage]').click()
        expect(page.locator('#subscriptionCostNote')).to_contain_text('不代表订阅实际账单')
        expect(page.locator('#usageRows')).to_contain_text('订阅')
        preview = repo / 'dist/ui-preview'
        preview.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(preview / 'settings-subscription-usage.png'), full_page=True)
        page.set_viewport_size({'width': 560, 'height': 900})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        assert not errors, errors
        browser.close()
    print('PASS: subscription account/model/date filters, token and cost display, unknown prices, CSV, restart, Chinese and compact layout')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
