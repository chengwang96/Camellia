"""Grok multi-account cards and dual-connection UI through the real IPC bridge."""
import json
from pathlib import Path
import subprocess
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
    return response.get('result')

bridge = """window.dshDesktop = new Proxy({}, {get: (_, method) => method.startsWith('on') ? () => () => {} : method === 'grokAccountLabel' ? (...args) => window.testRpc(method, args) : payload => window.testRpc(method, payload)});"""
try:
    rpc('configureTestApi')
    rpc('seedGrokAccounts')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1180, 'height': 900}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=subscriptions&engine=grok', wait_until='networkidle')
        cards = page.locator('#grokAccountList .subscription-card')
        expect(cards).to_have_count(2)
        expect(cards.nth(0)).to_contain_text('SuperGrok')
        expect(cards.nth(0)).to_contain_text('Prepaid balance')
        expect(cards.nth(0)).to_contain_text('$12.34')
        expect(cards.nth(0).locator('progress')).to_have_attribute('value', '65')
        expect(cards.nth(0)).to_contain_text('Personal')
        expect(cards.nth(1)).to_contain_text('Grok Basic')
        expect(cards.nth(1).locator('progress')).to_have_attribute('value', '30')
        expect(page.locator('#grokAddAccount')).to_be_visible()
        cards.nth(1).locator('[data-card-action="switch"]').click()
        assert rpc('grokAccountState')['activeId'] == 'work'
        expect(cards.nth(1)).to_have_class('subscription-card active')
        cards.nth(1).locator('[data-card-action="edit"]').click()
        cards.nth(1).locator('form input').fill('Work renamed')
        cards.nth(1).locator('form button[type="submit"]').click()
        expect(cards.nth(1).locator('form input')).to_have_value('Work renamed')
        assert rpc('grokAccountState')['accounts'][1]['label'] == 'Work renamed'
        page.screenshot(path=str(repo / 'dist/ui-preview/grok-subscription-accounts.png'), full_page=True)

        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=grok', wait_until='networkidle')
        expect(page.locator('#modelPillName')).to_have_text('Grok Fixture')
        page.locator('#modelPill').click()
        page.locator('.pop-row').filter(has_text='Reasoning level').click()
        expect(page.locator('.dsh-pop').last.locator('.pop-label')).to_have_text(['Default', 'Low', 'High'])
        page.locator('.dsh-pop').last.get_by_text('High', exact=True).click()
        page.wait_for_function("document.querySelector('#modelPillLevel').textContent === 'High'")
        assert rpc('conversationCommand', {'engine': 'grok', 'action': 'get-settings'})['thinkingBudget'] == 'high'

        rpc('conversationCommand', {'engine': 'grok', 'action': 'save-settings', 'payload': {'connection': 'api', 'model': 'test-model'}})
        page.reload(wait_until='networkidle')
        expect(page.locator('#modelPillName')).to_have_text('test-model')
        page.locator('#modelPill').click()
        page.locator('.pop-row').filter(has_text='Model').first.click()
        expect(page.locator('.dsh-pop').last).to_contain_text('Model · Shared API routes')
        expect(page.locator('.dsh-pop').last).to_contain_text('Model · Grok account')
        page.keyboard.press('Escape')
        rpc('conversationCommand', {'engine': 'grok', 'action': 'save-settings', 'payload': {'connection': 'subscription', 'model': 'grok-fixture'}})
        page.reload(wait_until='networkidle')
        expect(page.locator('#modelPillName')).to_have_text('Grok Fixture')
        assert errors == [], errors
        browser.close()
    print('PASS: Grok multi-account cards, account switching and labels, weekly quota, prepaid balance, model/reasoning and subscription/API switching')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
