"""Language switching with real preferences IPC. No model or account requests."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
driver = subprocess.Popen(['node', str(repo/'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')

def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload})+'\n')
    driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response

bridge = """(() => {
  const listeners = {};
  window.testLanguage = language => listeners.onLanguageChanged(language);
  window.dshDesktop = new Proxy({}, {get: (_, method) => method.startsWith('on')
    ? fn => {listeners[method] = fn; return () => {};}
    : async payload => {
      const response = await window.testRpc(method, payload);
      for (const event of response.events || []) {
        if (event.channel === 'dsh:language-changed') listeners.onLanguageChanged?.(event.data);
      }
      return response.result;
    }});
})();"""
try:
    fixtures = rpc('fixtures')['result']
    rpc('claudeMetaOp', {'op':'create-workspace', 'name':'Settings', 'path':fixtures['alpha']})
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        errors = []
        def open_page(file):
            page = browser.new_page(viewport={'width':1160,'height':900})
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.expose_function('testRpc', rpc)
            page.add_init_script(bridge)
            page.goto((repo/'src/renderer'/file).as_uri(), wait_until='networkidle')
            return page
        settings = open_page('settings/api-settings.html')
        home = open_page('home/home.html')
        chat = open_page('chat/claude.html')
        expect(home.locator('h1')).to_have_text('Start working')
        expect(chat.locator('.ws-name')).to_have_text('Settings')
        chat.locator('#input').fill('Settings / Ready / Keep this draft 原样保留')
        # Unsaved API entries must survive translating the settings window.
        settings.locator('#addProvider').click()
        settings.locator('#confirmAdd').click()
        settings.locator('#pName').fill('Settings')
        settings.locator('[data-field=key]').fill('not-a-real-key')
        settings.locator('[data-view=general]').click()
        expect(settings.locator('#language')).to_have_value('en')
        settings.locator('#language').select_option('zh-CN')
        expect(settings.locator('#status')).to_have_text('偏好设置已保存')
        expect(settings.locator('#pageTitle')).to_have_text('通用')
        assert rpc('workbenchSettings')['result']['language'] == 'zh-CN'
        for page in [home, chat]:
            page.evaluate("window.testLanguage('zh-CN')")
        expect(home.locator('h1')).to_have_text('开始工作')
        expect(home.locator('#enterClaude .entry-action')).to_contain_text('Claude')
        expect(chat.locator('#newSessionBtn')).to_contain_text('新会话')
        expect(chat.locator('.ws-name')).to_have_text('Settings')
        expect(chat.locator('#input')).to_have_value('Settings / Ready / Keep this draft 原样保留')
        expect(chat.locator('#input')).to_have_attribute('placeholder', '给 Claude Code 发送消息')
        # Newly created menus and buttons use the current language too.
        chat.locator('#sessionCurrent .session-more').click()
        expect(chat.get_by_text('无工作区 · 独立会话', exact=True)).to_be_visible()
        expect(chat.locator('.dsh-pop').get_by_text('Settings', exact=True)).to_be_visible()
        chat.locator('#input').click()
        settings.locator('.scroll-content').evaluate('el => el.scrollTop = 0')
        settings.screenshot(path=str(preview/'general-zh-CN.png'), full_page=True)
        home.screenshot(path=str(preview/'home-zh-CN.png'), full_page=True)
        settings.locator('[data-view=providers]').click()
        expect(settings.locator('#pName')).to_have_value('Settings')
        expect(settings.locator('[data-field=key]')).to_have_value('not-a-real-key')
        expect(settings.locator('#addKey')).to_have_text('+ 添加 Key')
        settings.locator('[data-view=engines]').click()
        expect(settings.locator('label[for=nativeField0]')).to_have_text('回复语言')
        # Reload loads the saved preference; it does not depend on OS language.
        home.reload(wait_until='networkidle')
        expect(home.locator('html')).to_have_attribute('lang', 'zh-CN')
        expect(home.locator('h1')).to_have_text('开始工作')
        settings.locator('[data-view=general]').click()
        settings.locator('#language').select_option('en')
        expect(settings.locator('#pageTitle')).to_have_text('General')
        expect(settings.locator('#status')).to_have_text('Preferences saved')
        for page in [home, chat]:
            page.evaluate("window.testLanguage('en')")
        expect(home.locator('h1')).to_have_text('Start working')
        expect(chat.locator('#newSessionBtn')).to_contain_text('New session')
        expect(chat.locator('#input')).to_have_value('Settings / Ready / Keep this draft 原样保留')
        for page in [home, settings, chat]:
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        settings.locator('.scroll-content').evaluate('el => el.scrollTop = 0')
        settings.screenshot(path=str(preview/'general-en.png'), full_page=True)
        assert not errors, errors
        browser.close()
    print('PASS: language persistence, live switching, menus, and draft/name preservation')
finally:
    rpc('cleanup')
    driver.terminate()
