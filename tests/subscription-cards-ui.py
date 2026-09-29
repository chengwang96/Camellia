"""Real settings page with simulated account actions; never sends a paid request."""
import json
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

bridge = """window.calls=[];
window.mockAccounts = ['default','account-1','account-2'].map((id,i)=>({id, label:['日常工作','长任务备用','个人账号'][i],
 email:['work@example.com','research@example.com','personal@example.com'][i], plan:['plus','pro','free'][i], signedIn:true,
 active:i===0, exhausted:false, verifiedAt:'2026-09-29T07:00:00Z', quotaWindows:[
 {label:'5h',usedPercent:[4,13,40][i],resetsAt:'2026-09-29T10:02:00Z'},
 {label:'7d',usedPercent:[15,25,85][i],resetsAt:'2026-10-04T07:52:00Z'}]}));
const snapshot=()=>({ok:true, installed:true,activeId:mockAccounts.find(a=>a.active).id, accounts:mockAccounts,
 account:{email:'work@example.com',planType:'plus'},models:[{id:'test',name:'Test model'}]});
window.dshDesktop=new Proxy({}, {get:(_,method)=>method.startsWith('on')?()=>()=>{}:async (...args)=>{
 calls.push({method,args});
 if(method==='codexAccountState')return snapshot();
 if(method==='codexAccountSelect'){mockAccounts.forEach(a=>a.active=a.id===args[0]);return snapshot();}
 if(method==='codexAccountLabel'){mockAccounts.find(a=>a.id===args[0]).label=args[1];return snapshot();}
 if(method==='codexAccountRefresh'||method==='codexAccountWake')return {...snapshot(),wakeSent:method==='codexAccountWake'};
 if(method==='codexAccountRemove'){mockAccounts=mockAccounts.filter(a=>a.id!==args[0]);return snapshot();}
 return window.testRpc(method,args[0]);
}});
window.camelliaDevices={onEvent:()=>()=>{},onTransfer:()=>()=>{},call:async()=>({ok:true,result:{}})};
"""
try:
    rpc('configureTestApi')
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1420,'height':960})
        errors=[]; page.on('pageerror',lambda error:errors.append(str(error)))
        page.expose_function('testRpc',rpc); page.add_init_script(bridge)
        page.goto((repo/'src/renderer/settings/api-settings.html').as_uri()+'?page=subscriptions',wait_until='networkidle')
        cards=page.locator('#codexAccountList')
        expect(cards.locator('.subscription-card')).to_have_count(3)
        backup=cards.locator('[data-card-id="account-1"]')
        backup.locator('[data-card-action=refresh]').click()
        expect(cards.locator('[data-card-id=default]')).to_have_class('subscription-card active')
        backup.locator('[data-card-action=wake]').click()
        expect(cards.locator('[data-card-id=default]')).to_have_class('subscription-card active')
        backup.locator('[data-card-action=edit]').click()
        backup.locator('input').fill('Edited note')
        backup.locator('form button[type=submit]').click()
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
        cards.screenshot(path=str(out/'subscription-cards.png'))
        for width in [700,390,320]:
            page.set_viewport_size({'width':width,'height':950})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
            assert cards.evaluate('el=>el.scrollWidth<=el.clientWidth'),width
        page.evaluate("document.documentElement.dataset.theme='dark'")
        page.set_viewport_size({'width':1420,'height':960})
        cards.screenshot(path=str(out/'subscription-cards-dark.png'))
        assert not errors,errors
        browser.close()
    print('PASS: targeted switch, note, quota refresh, wake, removal; Chinese, dark and 320px layouts')
finally:
    driver.terminate()
