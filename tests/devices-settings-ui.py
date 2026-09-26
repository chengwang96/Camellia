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
      const conversation = {id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',title:'Server conversation',seq:2,workspaceId:'project',activity:null};
      const info = {instanceId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',workspaces:[{id:'project',name:'Paper agent'}],capabilities:['create-workspace','attachments','restore'],engines:['dsh'],nextOffset:null};
      window.dshDesktop = { camelliaDevices: {
        onEvent() {}, onTransfer() {},
        async call(action, payload) {
          window.calls.push({action, payload});
          if (action === 'state') return {ok:true,result:{language:'en',theme:'light',devices:[{id:'server-a',name:'GPU server',address:'http://100.80.1.2:43127'}],network:{state:'Running'}}};
          if (action === 'conversations') return {ok:true,result:{...info,conversations:[conversation]}};
          if (action === 'snapshot') return {ok:true,result:{...info,conversation,messages:[{seq:1,role:'user',text:'hello'}],live:null,nextBefore:null,settings:{editable:true,version:'v1',model:'model-a',permissionMode:'ask',models:[{id:'model-a',name:'Model A'}],permissionLevels:['ask','auto','full']}}};
          if (action === 'watch') return {ok:true,result:{watching:true}};
          return {ok:true,result:{}};
        } } };
    """)
    page.goto((root / "tests/fixtures/devices-settings-host.html").as_uri())
    page.wait_for_load_state("networkidle")

    # The settings page owns unprefixed ids, so every device control is prefixed.
    assert page.locator("#cli-device").count() == 1
    assert page.locator("#device").count() == 0
    assert page.locator("#cli-add").count() == 1
    assert page.locator('[data-copy="networkHint"][id="cli-networkState"]').count() == 0
    assert page.locator("#cli-networkState").count() == 1
    assert page.locator("#cliDevicesRoot").get_attribute("data-embedded") == "true"
    assert page.locator("#cliDevicesRoot").get_attribute("class") == "cli-devices embedded"

    # The page loads its own state through the settings bridge, not camelliaDevices.
    page.evaluate("window.cliDevicesUI.setVisible(true)")
    page.wait_for_function("calls.some(call => call.action === 'state')")
    page.locator("#cli-device").select_option("server-a")
    expect(page.locator("#cli-targetName")).to_have_text("GPU server")
    expect(page.locator("#cli-tree")).to_contain_text("Server conversation")

    # Scoped styles: settings controls keep the settings look, device controls use the device look.
    assert page.evaluate("getComputedStyle(document.getElementById('outsideButton')).borderRadius") == "18px"
    assert page.evaluate("getComputedStyle(document.getElementById('outsideButton')).padding") == "6px 14px"
    assert page.evaluate("getComputedStyle(document.getElementById('outsideDialog')).padding") == "24px"
    assert page.evaluate("getComputedStyle(document.getElementById('cli-refresh')).borderRadius") == "16px"
    assert page.evaluate("getComputedStyle(document.getElementById('cli-refresh')).padding") == "8px 13px"
    assert page.evaluate("getComputedStyle(document.getElementById('cli-dialog')).padding") == "26px"
    assert page.evaluate("getComputedStyle(document.querySelector('.cli-devices footer')).display") == "block"
    expect(page.locator("#cli-empty")).to_be_visible()
    expect(page.locator("#cli-chat")).to_be_hidden()
    assert not errors, errors
    page.evaluate("document.querySelectorAll('#cliDevicesRoot img').forEach(image => image.remove())")
    page.screenshot(path=str(root / ".tmp-cli-devices-embedded.png"), full_page=True)
    browser.close()
print("CLI devices settings page: prefixed ids, scoped styles and settings bridge passed")
