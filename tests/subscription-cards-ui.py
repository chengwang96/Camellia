"""Real settings page with simulated account actions; never sends a paid request."""
import json
import math
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo/'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload})+'\n'); driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response: raise RuntimeError(response['error'])
    return response['result']

bridge = """window.calls=[]; window.accountListeners={};
window.mockAccounts = ['default','account-1','account-2'].map((id,i)=>({id, label:['','长任务备用','个人账号'][i],
 email:['work@example.com','research@example.com','personal@example.com'][i], plan:['plus','pro','free'][i], signedIn:true,
 active:i===0, exhausted:false, verifiedAt:'2026-09-29T07:00:00Z', quotaWindows:[
 {label:'5h',usedPercent:[4,13,40][i],resetsAt:'2026-09-29T10:02:00Z'},
 {label:'7d',usedPercent:[15,25,85][i],resetsAt:'2026-10-04T07:52:00Z'}]}));
const snapshot=()=>({ok:true, installed:true,activeId:mockAccounts.find(a=>a.active).id, accounts:mockAccounts,
 account:{email:'work@example.com',planType:'plus'},models:[{id:'test',name:'Test model'}]});
window.accountSnapshot=snapshot;
window.dshDesktop=new Proxy({}, {get:(_,method)=>method.startsWith('on')?fn=>{accountListeners[method]=fn;return()=>{};}:async (...args)=>{
 calls.push({method,args});
 if(method==='codexAccountState')return snapshot();
 if(method==='codexAccountSelect'){mockAccounts.forEach(a=>a.active=a.id===args[0]);return snapshot();}
 if(method==='codexAccountLabel'){mockAccounts.find(a=>a.id===args[0]).label=args[1];return snapshot();}
 if(method==='codexAccountRefresh'||method==='codexAccountWake')return {...snapshot(),wakeSent:method==='codexAccountWake'};
 if(method==='codexAccountRemove'){mockAccounts=mockAccounts.filter(a=>a.id!==args[0]);return snapshot();}
 if(method==='antigravityAccountState')return window.mockGoogle ||= await window.testRpc(method,args[0]);
 if(method==='antigravityAccountRefreshUsage'){
   mockGoogle.usage.status=window.failGoogleQuota?'stale':'ok';
   mockGoogle.usage.error=window.failGoogleAvatar?'Google account profile picture unavailable.':window.failGoogleQuota?'Could not load Google quota. Check the connection and retry.':null;
   accountListeners.onAntigravityAccount(mockGoogle);
   return mockGoogle;
 }
 return window.testRpc(method,args[0]);
}});
window.camelliaDevices={onEvent:()=>()=>{},onTransfer:()=>()=>{},call:async()=>({ok:true,result:{}})};
"""

def assert_card_layout(cards):
    problems = cards.locator('.subscription-card').evaluate_all("""cards => cards.flatMap(card => {
      const problems = [], bounds = card.getBoundingClientRect();
      for (const element of card.querySelectorAll('header strong, .subscription-badges, .subscription-state, .subscription-meter, .subscription-note-text, .subscription-checked, .subscription-actions button, .subscription-note:not([hidden]) > *')) {
        const box = element.getBoundingClientRect();
        if (box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1)
          problems.push(`${card.dataset.cardId}: ${element.className || element.dataset.cardAction} escapes card`);
        const style = getComputedStyle(element);
        if (element.matches('.subscription-actions button') && (parseFloat(style.width) < 34 || parseFloat(style.height) < 34))
          problems.push(`${card.dataset.cardId}: ${element.dataset.cardAction} is compressed`);
      }
      const note = card.querySelector('.subscription-note-text');
      if (note && parseFloat(getComputedStyle(note).height) > 26)
        problems.push(`${card.dataset.cardId}: note inherits a page empty-state layout`);
      if (card.scrollWidth > card.clientWidth)
        problems.push(`${card.dataset.cardId}: horizontal overflow inside card`);
      for (const progress of card.querySelectorAll('.subscription-meter progress')) {
        const bar = progress.getBoundingClientRect();
        const value = progress.parentElement.querySelector('strong').getBoundingClientRect();
        if (Math.abs(bar.top + bar.height / 2 - value.top - value.height / 2) > 1 || value.left < bar.right)
          problems.push(`${card.dataset.cardId}: quota value is not beside its meter`);
      }
      return problems;
    })""")
    assert not problems, problems


def screenshot_with_shadow(page, locator, path):
    # Element screenshots crop the shadow. Include the actual page canvas.
    locator.scroll_into_view_if_needed()
    page.mouse.move(0, 0)
    bounds = locator.bounding_box()
    viewport = page.viewport_size
    left = max(0, math.floor(bounds['x']) - 24)
    top = max(0, math.floor(bounds['y']) - 18)
    right = min(viewport['width'], math.ceil(bounds['x'] + bounds['width']) + 24)
    bottom = min(viewport['height'], math.ceil(bounds['y'] + bounds['height']) + 26)
    page.screenshot(path=str(path), animations='disabled', clip={
        'x': left, 'y': top, 'width': right - left, 'height': bottom - top})

try:
    rpc('configureTestApi')
    rpc('seedGoogleAccount')
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1420,'height':960})
        errors=[]; page.on('pageerror',lambda error:errors.append(str(error)))
        page.expose_function('testRpc',rpc); page.add_init_script(bridge)
        page.goto((repo/'src/renderer/settings/api-settings.html').as_uri()+'?page=subscriptions',wait_until='networkidle')
        cards=page.locator('#codexAccountList')
        expect(cards.locator('.subscription-card')).to_have_count(3)
        assert_card_layout(cards)
        google=page.locator('#googleAccountList')
        expect(google.locator('.subscription-card')).to_have_count(1)
        expect(page.locator('#googleSignIn, #googleRefresh')).to_have_count(0)
        expect(page.locator('#googleAccountPanel > .account-actions')).to_have_count(0)
        expect(google.locator('.subscription-meter')).to_have_count(4)
        expect(google.locator('.subscription-meter strong')).to_have_text(['100%','99%','40%','0%'])
        expect(google.locator('[data-card-action]')).to_have_count(1)
        expect(google.locator('.subscription-meter.critical')).to_have_count(1)
        page.locator('.account-shortcuts [data-account-engine=antigravity]').click()
        expect(google.locator('[data-card-action=refresh]')).to_be_focused()
        google.locator('[data-card-action=refresh]').click()
        expect(page.locator('#status')).to_have_text('Account status updated.')
        assert page.evaluate("calls.filter(c=>c.method==='antigravityAccountRefreshUsage').length") == 1
        assert page.evaluate("calls.filter(c=>c.method==='antigravityAccountRefresh').length") == 0
        page.evaluate('window.failGoogleQuota=true')
        google.locator('[data-card-action=refresh]').click()
        expect(page.locator('#googleQuotaStatus')).to_contain_text('Showing the last successful reading')
        expect(google.locator('.subscription-meter strong')).to_have_text(['100%','99%','40%','0%'])
        # Avatar lookup is optional. It must not turn a successful quota reading
        # into a visible error or a retry toast.
        raw_error = 'error: Eligibility check failed: failed to get profile picture: Get "https://lh3.googleusercontent.com/a/' + 'avatar-id' * 40 + '=s96-c": EOF'
        page.evaluate('error => { mockGoogle.usage.error=error; accountListeners.onAntigravityAccount(mockGoogle); }', raw_error)
        notice=page.locator('#googleQuotaStatus')
        details=page.locator('#googleQuotaErrorDetails')
        raw=page.locator('#googleQuotaErrorRaw')
        expect(notice).to_be_hidden()
        expect(details).to_be_hidden()
        expect(raw).to_have_text('')
        expect(raw).not_to_contain_text('https://')
        page.evaluate('window.failGoogleAvatar=true')
        google.locator('[data-card-action=refresh]').click()
        expect(page.locator('#status')).to_have_text('Account status updated.')
        expect(notice).to_be_hidden()
        page.evaluate('window.failGoogleAvatar=false')
        page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
        expect(notice).to_be_hidden()
        expect(details).to_be_hidden()
        expect(raw).to_have_text('')
        for width in [1420,390,320]:
            page.set_viewport_size({'width':width,'height':960})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), ('Google error overflow',width)
        page.set_viewport_size({'width':1420,'height':960})
        # Unknown output is inert text inside details, and no stale-data claim
        # appears when there has never been a successful reading.
        page.evaluate("""() => {
          window.savedGoogleLatest=mockGoogle.usage.latest;
          mockGoogle.usage.latest=null;
          mockGoogle.usage.error='<img src=x onerror=alert(1)> unrecognized CLI failure';
          accountListeners.onAntigravityAccount(mockGoogle);
        }""")
        expect(notice).to_contain_text('暂时无法刷新 Google 额度')
        expect(notice).not_to_contain_text('上次成功')
        expect(raw.locator('img')).to_have_count(0)
        expect(raw).to_be_hidden()
        details.locator('summary').click()
        expect(raw).to_be_visible()
        error_out=repo/'dist/subscription-error-qa'
        error_out.mkdir(parents=True,exist_ok=True)
        screenshot_with_shadow(page,page.locator('#googleAccountPanel'),error_out/'google-quota-error-zh.png')
        page.evaluate('mockGoogle.usage.latest=savedGoogleLatest')
        page.evaluate("CamelliaI18n.setLanguage('en')")
        google.locator('[data-card-action=refresh]').click()
        expect(page.locator('#status')).to_contain_text('Could not connect to Google.')
        page.evaluate('window.failGoogleQuota=false')
        google.locator('[data-card-action=refresh]').click()
        expect(page.locator('#googleQuotaStatus')).to_be_hidden()
        expect(details).to_be_hidden()
        expect(raw).to_have_text('')
        backup=cards.locator('[data-card-id="account-1"]')
        backup.locator('[data-card-action=refresh]').click()
        expect(cards.locator('[data-card-id=default]')).to_have_class('subscription-card active')
        backup.locator('[data-card-action=wake]').click()
        expect(cards.locator('[data-card-id=default]')).to_have_class('subscription-card active')
        backup.locator('[data-card-action=edit]').click()
        backup.locator('input').fill('Edited note')
        backup.locator('form button[type=submit]').click()
        expect(backup.locator('.subscription-note-text')).to_have_text('Edited note')
        backup.locator('[data-card-action=edit]').click()
        backup.locator('input').fill('Unsaved note')
        backup.locator('input').press('Escape')
        expect(backup.locator('form')).to_be_hidden()
        expect(backup.locator('[data-card-action=edit]')).to_be_focused()
        expect(backup.locator('.subscription-note-text')).to_have_text('Edited note')
        backup.locator('[data-card-action=switch]').click()
        expect(backup).to_have_class('subscription-card active')
        assert page.evaluate("calls.filter(c=>c.method==='codexAccountWake').length") == 1
        assert page.evaluate("calls.find(c=>c.method==='codexAccountWake').args[0]") == 'account-1'
        page.on('dialog',lambda dialog:dialog.accept())
        cards.locator('[data-card-id="account-2"] [data-card-action=remove]').click()
        expect(cards.locator('.subscription-card')).to_have_count(2)
        # Reload restores the illustrative fixtures for the preview.
        page.reload(wait_until='networkidle')
        page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
        expect(cards.locator('.subscription-card')).to_have_count(3)
        out=repo/'artifacts';out.mkdir(exist_ok=True)
        screenshot_with_shadow(page, cards, out/'subscription-cards.png')
        page.screenshot(path=str(out/'subscription-page-depth.png'), animations='disabled')
        expect(page.locator('#googleAccountList [data-card-action=edit]')).to_have_count(0)
        expect(google.locator('.subscription-meter-head')).to_have_text(['Gemini · 每周','Gemini · 5 小时','Claude / GPT · 每周','Claude / GPT · 5 小时'])
        screenshot_with_shadow(page, google.locator('.subscription-card'), out/'google-subscription-card.png')
        for language in ['en','zh-CN']:
            page.evaluate('language=>CamelliaI18n.setLanguage(language)',language)
            for theme in ['light','dark']:
                page.evaluate('theme=>document.documentElement.dataset.theme=theme',theme)
                for width in [1420,1180,960,850,700,480,390,320]:
                    page.set_viewport_size({'width':width,'height':950})
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(language,theme,width)
                    assert cards.evaluate('el=>el.scrollWidth<=el.clientWidth'),(language,theme,width)
                    assert_card_layout(cards)
                    assert_card_layout(google)
        page.evaluate("document.documentElement.dataset.theme='dark'")
        page.set_viewport_size({'width':1420,'height':960})
        screenshot_with_shadow(page, cards, out/'subscription-cards-dark.png')
        screenshot_with_shadow(page, google.locator('.subscription-card'), out/'google-subscription-card-dark.png')
        page.set_viewport_size({'width':1180,'height':960})
        page.evaluate("""() => {
          window.depthPreviewAccounts=mockAccounts;
          mockAccounts=mockAccounts.slice(0,1);
          accountListeners.onCodexAccount(accountSnapshot());
        }""")
        screenshot_with_shadow(page, cards.locator('[data-card-id=default]'), out/'subscription-card-depth-dark.png')
        page.evaluate("document.documentElement.dataset.theme='light'")
        screenshot_with_shadow(page, cards.locator('[data-card-id=default]'), out/'subscription-card-depth.png')
        page.evaluate("""() => {
          mockAccounts=depthPreviewAccounts;
          accountListeners.onCodexAccount(accountSnapshot());
        }""")
        # Subscription accounts share the settings background in both themes.
        for theme in ['light','dark']:
            page.evaluate('theme=>document.documentElement.dataset.theme=theme',theme)
            subscription_canvas = page.locator('body, .settings-main').evaluate_all('els=>els.map(el=>getComputedStyle(el).backgroundColor)')
            for view in ['general','providers']:
                page.locator(f'[data-view={view}]').click()
                assert page.locator('body, .settings-main').evaluate_all('els=>els.map(el=>getComputedStyle(el).backgroundColor)') == subscription_canvas,(theme,view)
            page.locator('[data-view=subscriptions]').click()
        expect(cards.locator('.subscription-card')).to_have_count(3)

        # One Pro account with no note and just the weekly meter reproduces the
        # reported screenshot. Zoom must not squeeze buttons out of the card.
        page.evaluate("""() => {
          document.documentElement.dataset.theme='light';
          window.previewAccounts=structuredClone(mockAccounts);
          mockAccounts=[{...mockAccounts[0],email:'pro.account@example.com',plan:'pro',quotaWindows:[
            {label:'7d',usedPercent:51,resetsAt:'2026-10-04T01:09:00+08:00'}]}];
          accountListeners.onCodexAccount(accountSnapshot());
        }""")
        expect(cards.locator('.subscription-card')).to_have_count(1)
        expect(cards.locator('progress')).to_have_attribute('value','49')
        for zoom in [1,1.25,1.75,2]:
            page.evaluate('zoom=>document.documentElement.style.zoom=zoom',zoom)
            assert_card_layout(cards)
        page.evaluate("document.documentElement.style.zoom=1")
        screenshot_with_shadow(page, cards.locator('.subscription-card'), out/'subscription-card-fixed.png')

        # Long user content, missing quotas and errors stay readable at narrow
        # widths instead of displacing the controls or clipping timestamps.
        page.evaluate("""() => {
          mockAccounts=previewAccounts;
          Object.assign(mockAccounts[1],{email:'account-owner-with-a-long-email-address@example.test',label:'长期研究项目 / '.repeat(6)});
          Object.assign(mockAccounts[2],{error:'Quota service is temporarily unavailable. Please refresh after signing in again.',quotaWindows:[{label:'Weekly',usedPercent:null}]});
          accountListeners.onCodexAccount(accountSnapshot());
        }""")
        expect(cards.locator('[data-card-id="account-2"] progress')).to_have_count(0)
        for width in [1180,700,390,320]:
            page.set_viewport_size({'width':width,'height':950})
            assert_card_layout(cards)
        backup.locator('[data-card-action=edit]').click()
        assert_card_layout(cards)
        backup.locator('[data-note-cancel]').click()
        expect(backup.locator('form')).to_be_hidden()
        screenshot_with_shadow(page, cards.locator('[data-card-id=default]'), out/'subscription-card-compact.png')
        assert not errors,errors
        browser.close()
    print('PASS: account actions; Google four-window quota, quota-only refresh and stale recovery; English/Chinese, light/dark, 320-1420px and 100-200% zoom without clipped controls')
finally:
    driver.terminate()
    driver.wait(timeout=10)
