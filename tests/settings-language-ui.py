"""Settings first paint and live language switching with real preferences IPC."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding='utf-8')

def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError(driver.stderr.read())
    response = json.loads(line)
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response

bridge = """(() => {
  const listeners = {};
  let languageRequested = false;
  const languageReady = new Promise(resolve => { window.releaseLanguage = resolve; });
  window.dshDesktop = new Proxy({}, {get: (_, method) => method.startsWith('on')
    ? fn => {listeners[method] = fn; return () => {};}
    : async payload => {
      const initialLanguage = method === 'workbenchSettings' && !languageRequested;
      if (method === 'workbenchSettings') languageRequested = true;
      if (initialLanguage && window.holdLanguage) await languageReady;
      if (initialLanguage && window.failLanguage) throw new Error('Preferences unavailable');
      const response = await window.testRpc(method, payload);
      for (const event of response.events || []) {
        if (event.channel === 'dsh:language-changed') listeners.onLanguageChanged?.(event.data);
      }
      return response.result;
    }});
})();"""

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        errors = []

        def open_settings(hold=False, fail=False):
            page = browser.new_page(viewport={'width': 1160, 'height': 900})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.expose_function('testRpc', rpc)
            page.add_init_script(f'window.holdLanguage = {json.dumps(hold)};'
                f'window.failLanguage = {json.dumps(fail)};' + bridge)
            page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri(),
                wait_until='networkidle')
            return page

        for language, title in [('zh-CN', '通用'), ('en', 'General')]:
            rpc('workbenchSaveSettings', {'language': language, 'autoRefreshBalances': False})
            page = open_settings(hold=True)
            frames = page.evaluate("""async () => {
              const frames = [];
              for (let i = 0; i < 3; i++) {
                await new Promise(requestAnimationFrame);
                const title = document.getElementById('pageTitle');
                frames.push({text: title.textContent, visible: getComputedStyle(title).visibility === 'visible'});
              }
              return frames;
            }""")
            assert all(not frame['visible'] for frame in frames), frames
            # Record the first visible frame, not just the eventual translated DOM.
            page.evaluate("""() => {
              function sample() {
                const title = document.getElementById('pageTitle');
                if (getComputedStyle(title).visibility === 'visible') {
                  window.firstVisibleTitle = title.textContent;
                } else requestAnimationFrame(sample);
              }
              requestAnimationFrame(sample);
              window.releaseLanguage();
            }""")
            expect(page.locator('#pageTitle')).to_be_visible()
            expect(page.locator('#pageTitle')).to_have_text(title)
            expect(page.locator('[data-view=general]')).to_have_text(title)
            page.wait_for_function('window.firstVisibleTitle !== undefined')
            assert page.evaluate('window.firstVisibleTitle') == title
            expect(page.locator('#language')).to_have_value(language)
            other_language, other_title = ('en', 'General') if language == 'zh-CN' else ('zh-CN', '通用')
            page.locator('#language').select_option(other_language)
            expect(page.locator('#pageTitle')).to_have_text(other_title)
            expect(page.locator('#pageTitle')).to_be_visible()
            assert rpc('workbenchSettings')['result']['language'] == other_language
            page.close()

        # An unavailable preference read must not leave the page hidden.
        rpc('workbenchSaveSettings', {'language': 'en'})
        page = open_settings(fail=True)
        expect(page.locator('#pageTitle')).to_be_visible()
        expect(page.locator('#pageTitle')).to_have_text('General')
        page.locator('#language').select_option('zh-CN')
        expect(page.locator('#pageTitle')).to_have_text('通用')
        assert not errors, errors
        browser.close()
    print('PASS: English/Chinese settings first paint, slow and failed preferences, live language switching')
finally:
    rpc('cleanup')
    driver.terminate()
