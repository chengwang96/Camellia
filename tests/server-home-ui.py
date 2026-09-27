from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""
      window.openedServers = [];
      window.servers = [
        {id:'gpu',name:'GPU server',address:'http://100.80.1.2:43127',defaultHarness:'codex'},
        {id:'build',name:'Build server',address:'http://100.80.1.3:43127',defaultHarness:'kimi'}
      ];
      window.dshDesktop = {
        onRuntimeState() {}, onConfig() {}, onLanguageChanged() {},
        async workbenchSettings() { return {ok:true,language:'zh-CN'}; },
        async getConfig() { return {language:'zh-CN',theme:'light'}; },
        async runtimeState() { return {ok:true,engines:[]}; },
        async listCliServers() { return {ok:true,devices:window.servers,language:'zh-CN'}; },
        async openCliServer(id) { window.openedServers.push(id); return {ok: !window.openError,error:'Connection unavailable'}; },
        async openCliDevices() { window.settingsOpened = true; return {ok:true}; }
      };
    """)
    page.goto((root / "src/renderer/home/home.html").as_uri())
    page.wait_for_load_state("networkidle")
    expect(page.locator('[data-server]')).to_have_count(2)
    expect(page.locator('[data-server="gpu"]')).to_contain_text('Codex CLI')
    expect(page.locator('[data-server="build"]')).to_contain_text('Kimi Code')
    page.locator('[data-server="gpu"]').click()
    assert page.evaluate('openedServers') == ['gpu']
    page.evaluate('window.openError = true')
    page.locator('[data-server="build"]').click()
    expect(page.locator('#homeStatus')).to_have_text('Connection unavailable')
    expect(page.locator('[data-server="build"]')).to_be_enabled()
    page.locator('#openCliDevices').click()
    assert page.evaluate('settingsOpened')
    page.screenshot(path=str(root / '.tmp-server-home.png'), full_page=True)
    page.evaluate("servers.pop(); window.dispatchEvent(new Event('focus'))")
    expect(page.locator('[data-server]')).to_have_count(1)
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(page.locator('[data-server]')).to_have_count(1)
    page.set_viewport_size({"width": 480, "height": 820})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors, errors
    browser.close()
print('Server home: one card per server, defaults, launch, refresh and error recovery passed')
