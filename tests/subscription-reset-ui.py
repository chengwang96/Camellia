"""Real desktop settings UI with mock reset credits; never redeems a user's card."""
import ast
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo/'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, encoding='utf-8')

def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload})+'\n'); driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response['result']

# Reuse the existing isolated account bridge without executing its test body.
source = ast.parse((repo/'tests/subscription-cards-ui.py').read_text(encoding='utf-8'))
bridge = ast.literal_eval(next(node.value for node in source.body if isinstance(node, ast.Assign)
                              and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets)))
bridge += """
window.resetReads=[]; window.resetUses=[]; window.resetMode='reset'; window.resetTokens={};
const resetCredit=(id,days)=>({id,resetType:'codexRateLimits',status:'available',
 grantedAt:Math.floor(Date.now()/1000)-86400,expiresAt:days?Math.floor(Date.now()/1000)+days*86400:null});
mockAccounts.forEach((account,i)=>account.rateLimitResetCredits={availableCount:[3,2,0][i],
 credits:i===2?[]:[resetCredit(account.id+'-later',14),resetCredit(account.id+'-soon',3)]});
const desktop=window.dshDesktop;
window.dshDesktop=new Proxy({}, {get:(_,method)=>{
 if(method==='codexAccountResetPreview')return async id=>{
  resetReads.push(id);
  const account=mockAccounts.find(a=>a.id===id);
  const preview={account:{email:account.email,plan:account.plan},credits:structuredClone(account.rateLimitResetCredits),
   creditId:account.rateLimitResetCredits?.credits?.[1]?.id||null,
   confirmationToken:account.rateLimitResetCredits?.availableCount>0?'token-'+id:null,retry:false};
  resetTokens[id]=preview.confirmationToken;
  if(window.holdResetPreview)await new Promise(resolve=>window.finishResetPreview=resolve);
  return {...accountSnapshot(),preview};
 };
 if(method==='codexAccountResetConsume')return async payload=>{
  resetUses.push(structuredClone(payload));
  if(window.holdResetConsume)await new Promise(resolve=>window.finishResetConsume=resolve);
  if(resetMode==='offline')return {ok:false,error:'Connection closed after sending'};
  const account=mockAccounts.find(a=>a.id===payload.id);
  if(resetMode==='reset'){
   account.rateLimitResetCredits.availableCount--;
   account.quotaWindows.forEach(w=>w.usedPercent=0);
  }
  return {...accountSnapshot(),outcome:resetMode,warning:null};
 };
 return desktop[method];
}});
"""

def uses(page):
    return page.evaluate('resetUses')

def assert_layout(dialog):
    assert dialog.evaluate('el=>el.scrollWidth<=el.clientWidth'), 'modal overflows horizontally'
    assert dialog.locator('button').evaluate_all("""buttons=>buttons.every(button=>{
      const box=button.getBoundingClientRect(),modal=button.closest('dialog').getBoundingClientRect();
      return box.left>=modal.left&&box.right<=modal.right;
    })"""), 'modal controls escape dialog'

try:
    rpc('configureTestApi'); rpc('seedGoogleAccount')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1180, 'height': 950})
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc); page.add_init_script(bridge)
        page.goto((repo/'src/renderer/settings/api-settings.html').as_uri()+'?page=subscriptions', wait_until='networkidle')
        cards = page.locator('#codexAccountList')
        backup = cards.locator('[data-card-id=account-1]')
        reset = backup.locator('[data-card-action=reset]')
        dialog = page.locator('#codexResetDialog')
        confirm = page.locator('#confirmCodexReset'); cancel = page.locator('#cancelCodexReset')
        expect(reset).to_have_text('Reset credits · 2')
        expect(cards.locator('[data-card-id=account-2] [data-card-action=reset]')).to_be_disabled()
        expect(page.locator('#kimiAccountList [data-card-action=reset], #googleAccountList [data-card-action=reset]')).to_have_count(0)
        reset.click()
        expect(dialog).to_be_visible(); expect(confirm).to_be_enabled(); expect(cancel).to_be_focused()
        expect(page.locator('#codexResetEmail')).to_have_text('research@example.com')
        expect(page.locator('#codexResetCount')).to_have_text('2 reset credits available')
        expect(page.locator('#codexResetCredits li.selected')).to_have_count(1)
        assert not uses(page)
        cancel.click(); expect(dialog).not_to_be_visible(); assert not uses(page)
        reset.click(); expect(confirm).to_be_enabled(); page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible(); assert not uses(page)

        # A modal remains open while redeeming, and repeated clicks send once.
        reset.click(); expect(confirm).to_be_enabled()
        page.evaluate('window.holdResetConsume=true')
        confirm.evaluate('el=>{el.click();el.click();el.click()}')
        expect(confirm).to_be_disabled(); expect(cancel).to_be_disabled()
        page.keyboard.press('Escape'); expect(dialog).to_be_visible()
        assert len(uses(page)) == 1 and uses(page)[0]['confirmed'] is True
        page.evaluate('finishResetConsume(); holdResetConsume=false')
        expect(dialog).not_to_be_visible()
        expect(reset).to_have_text('Reset credits · 1')
        expect(backup.locator('.subscription-meter strong')).to_have_text(['100%', '100%'])
        assert page.evaluate('accountSnapshot().activeId') == 'default'

        # An explicit retry keeps the same confirmation token and account.
        page.evaluate("resetMode='offline'")
        reset.click(); expect(confirm).to_be_enabled(); confirm.click()
        expect(page.locator('#codexResetMessage')).to_have_text('Connection closed after sending')
        expect(confirm).to_have_text('Retry this reset request')
        original = uses(page)[-1]
        page.evaluate("resetMode='alreadyRedeemed'"); confirm.click()
        expect(dialog).not_to_be_visible(); assert uses(page)[-1] == original
        expect(page.locator('#status')).to_contain_text('already completed')

        # Count-only credit reports remain usable, with honest missing detail.
        page.evaluate("mockAccounts[1].rateLimitResetCredits.credits=null; resetMode='nothingToReset'")
        reset.click(); expect(confirm).to_be_enabled()
        expect(page.locator('#codexResetDetails')).to_be_hidden()
        expect(page.locator('#codexResetDetailHint')).to_contain_text('provider will select')
        confirm.click(); expect(dialog).not_to_be_visible()
        expect(page.locator('#status')).to_have_text('There is no eligible usage to reset.')
        expect(reset).to_have_text('Reset credits · 1')

        # Canceling a pending read cannot replace another account's dialog.
        page.evaluate('window.holdResetPreview=true')
        reset.click(); expect(confirm).to_be_disabled(); cancel.click()
        page.evaluate('window.holdResetPreview=false')
        cards.locator('[data-card-id=default] [data-card-action=reset]').click()
        expect(page.locator('#codexResetEmail')).to_have_text('work@example.com')
        page.evaluate('finishResetPreview()')
        expect(page.locator('#codexResetEmail')).to_have_text('work@example.com')
        cancel.click()

        # Review bilingual, themed, narrow and zoomed layouts in real Chromium.
        output = repo/'dist/ui-preview'; output.mkdir(parents=True, exist_ok=True)
        for language in ['en', 'zh-CN']:
            page.evaluate('value=>CamelliaI18n.setLanguage(value)', language)
            for theme in ['light', 'dark']:
                page.evaluate('value=>document.documentElement.dataset.theme=value', theme)
                for width in [1180, 700, 390, 320]:
                    page.set_viewport_size({'width': width, 'height': 950})
                    cards.locator('[data-card-id=default] [data-card-action=reset]').click()
                    expect(confirm).to_be_enabled(); assert_layout(dialog)
                    if language == 'zh-CN':
                        expect(page.locator('.codex-reset-credit-status')).to_have_text(['本次使用', '可用'])
                    if language == 'zh-CN' and width == 1180:
                        dialog.screenshot(path=str(output/f'codex-reset-{theme}.png'))
                    cancel.click()
        page.set_viewport_size({'width': 1180, 'height': 950})
        for zoom in [1.25, 1.75, 2]:
            page.evaluate('value=>document.documentElement.style.zoom=value', zoom)
            cards.locator('[data-card-id=default] [data-card-action=reset]').click()
            expect(confirm).to_be_enabled(); assert_layout(dialog); cancel.click()
        assert not errors, errors
        browser.close()
    print('PASS: official reset confirmation, cancellation, duplicate clicks, retry, selected-account isolation, count-only cards, loading races, English/Chinese, light/dark, 320–1180px and 125–200% zoom')
finally:
    driver.terminate(); driver.wait(timeout=10)
