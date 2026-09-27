from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1180, "height": 820})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""
      window.calls = [];
      window.defaultHarness = 'codex';
      const conversation = {id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',title:'Server conversation',seq:2,workspaceId:'project',activity:null};
      const info = {instanceId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',workspaces:[{id:'project',name:'Paper agent'}],capabilities:['create-workspace','attachments','restore'],engines:['dsh'],nextOffset:null};
      window.dshDesktop = { camelliaDevices: {
        onEvent() {}, onTransfer() {},
        async call(action, payload) {
          window.calls.push({action, payload});
          if (action === 'state') return {ok:true,result:{language:window.language || 'en',theme:'light',devices:[{id:'server-a',name:'GPU server',address:'http://100.80.1.2:43127',defaultHarness:window.defaultHarness}],network:{state:window.networkState || 'Running'}}};
          if (action === 'preferences') window.defaultHarness = payload.defaultHarness;
          if (action === 'pair') return {ok:true,result:{id:'pending'}};
          if (action === 'claim') return {ok:true,result:{state:'approved'}};
          if (action === 'conversations') return {ok:true,result:{...info,conversations:[conversation]}};
          if (action === 'snapshot') return {ok:true,result:{...info,conversation,messages:[{seq:1,role:'user',text:'hello'}],live:null,nextBefore:null,settings:{editable:true,version:'v1',model:'model-a',permissionMode:'ask',models:[{id:'model-a',name:'Model A'}],permissionLevels:['ask','auto','full']}}};
          if (action === 'watch') return {ok:true,result:{watching:true}};
          return {ok:true,result:{}};
        } } };
    """)
    page.goto((root / "tests/fixtures/devices-settings-host.html").as_uri())
    page.wait_for_load_state("networkidle")

    # The settings page owns unprefixed ids, so every device control is prefixed.
    assert page.locator("#cli-device").count() == 0
    assert page.locator("#device").count() == 0
    assert page.locator("#cli-add").count() == 1
    assert page.locator('[data-copy="networkHint"][id="cli-networkState"]').count() == 0
    assert page.locator("#cli-networkState").count() == 1
    assert page.locator("#cliDevicesRoot").get_attribute("data-embedded") == "true"
    assert page.locator("#cliDevicesRoot").get_attribute("class") == "cli-devices embedded"

    # The page loads its own state through the settings bridge, not camelliaDevices.
    page.evaluate("window.cliDevicesUI.setVisible(true)")
    page.wait_for_function("calls.some(call => call.action === 'state')")
    expect(page.locator("#cli-servers")).to_contain_text("GPU server")
    assert page.locator("#cli-tree, #cli-chat, #cli-prompt").count() == 0
    assert page.evaluate("calls.every(call => call.action === 'state')")
    page.locator('#cli-servers select').select_option('kimi')
    expect(page.locator('#cli-servers select')).to_have_value('kimi')
    assert page.evaluate("calls.find(call => call.action === 'preferences').payload.deviceId") == 'server-a'
    page.locator('#cli-servers select').select_option('pi')
    expect(page.locator('#cli-servers select')).to_have_value('pi')
    expect(page.locator('#cli-servers select option[value="pi"]')).to_have_text('Pi')
    assert page.evaluate("calls.filter(call => call.action === 'preferences').at(-1).payload.defaultHarness") == 'pi'

    # Scoped styles: settings controls keep the settings look, device controls use the device look.
    assert page.evaluate("getComputedStyle(document.getElementById('outsideButton')).borderRadius") == "18px"
    assert page.evaluate("getComputedStyle(document.getElementById('outsideButton')).padding") == "6px 14px"
    assert page.evaluate("getComputedStyle(document.getElementById('outsideDialog')).padding") == "24px"
    assert page.evaluate("getComputedStyle(document.getElementById('cli-refresh')).borderRadius") == "16px"
    assert page.evaluate("getComputedStyle(document.getElementById('cli-refresh')).padding") == "8px 13px"
    assert page.evaluate("getComputedStyle(document.getElementById('cli-pairDialog')).padding") == "26px"
    page.evaluate("window.networkState = 'NeedsLogin'")
    page.locator('#cli-refresh').click()
    page.locator('#cli-add').click()
    expect(page.locator('#cli-error')).to_contain_text('sign in first')
    page.evaluate("window.networkState = 'Running'")
    page.locator('#cli-refresh').click()
    page.locator('#cli-add').click()
    page.locator('#cli-deviceName').fill('Build server')
    page.locator('#cli-address').fill('100.80.1.3')
    expect(page.locator('#cli-port')).to_have_value('43127')
    for invalid_port in ['', '0', '65536', '1.5']:
        page.locator('#cli-port').fill(invalid_port)
        assert not page.locator('#cli-port').evaluate('(input) => input.checkValidity()')
    page.locator('#cli-port').fill('43128')
    page.locator('#cli-code').fill('a' * 24)
    page.locator('#cli-pairSubmit').click()
    expect(page.locator('#cli-pairSubmit')).to_have_text('Check approval')
    assert page.evaluate("calls.find(call => call.action === 'pair').payload.address") == 'http://100.80.1.3:43128'
    page.locator('#cli-pairSubmit').click()
    expect(page.locator('#cli-pairDialog')).not_to_be_visible()
    page.locator('#cli-servers .danger').click()
    expect(page.locator('#cli-forgetDialog')).to_contain_text('GPU server')
    page.locator('#cli-forgetCancel').click()
    page.evaluate("window.language = 'zh-CN'")
    page.locator('#cli-refresh').click()
    expect(page.locator('#cli-servers')).to_contain_text('默认 Harness')
    assert not errors, errors
    page.evaluate("document.querySelectorAll('#cliDevicesRoot img').forEach(image => image.remove())")
    page.screenshot(path=str(root / ".tmp-cli-devices-embedded.png"), full_page=True)
    browser.close()
print("CLI devices settings page: prefixed ids, scoped styles and settings bridge passed")
