"""Cache maintenance settings flow through real desktop IPC, with isolated files."""
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
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError(driver.stderr.read())
    response = json.loads(line)
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response

bridge = """(() => {
  const listeners = {};
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
    rpc('workbenchSaveSettings', {'language': 'zh-CN', 'autoRefreshBalances': False})
    rpc('seedPluginCacheMaintenance', {'fail': True})
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1160, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri(), wait_until='networkidle')
        page.locator('[data-view=data]').click()
        button = page.locator('#maintainPluginCaches')
        expect(button).to_have_text('去重并重启')
        button.click()
        expect(page.locator('#pluginCacheStatus')).to_have_text('relaunch failed')
        expect(button).to_be_enabled()
        assert rpc('workbenchSettings')['result']['pluginCacheMaintenance']['pending'] is False
        rpc('seedPluginCacheMaintenance', {})
        button.click()
        expect(page.locator('#pluginCacheStatus')).to_have_text('正在重启并整理 Codex 插件缓存…')
        expect(button).to_be_disabled()
        result = rpc('finishPluginCacheMaintenance')['result']
        assert result['duplicates'] == 2 and result['bytes'] == 8, result
        assert result['nativeContexts'] == ['cache-one', 'cache-two'], result
        page.reload(wait_until='networkidle')
        page.locator('[data-view=data]').click()
        expect(page.locator('#pluginCacheStatus')).to_have_text('已合并 2 份重复缓存，释放 8 B，跳过 0 项。')
        page.locator('[data-view=general]').click()
        page.locator('#language').select_option('en')
        page.locator('[data-view=data]').click()
        expect(page.locator('#pluginCacheStatus')).to_have_text('Shared 2 duplicate caches; freed 8 B. Skipped 0 items.')
        assert not errors, errors
        browser.close()
    print('PASS: plugin cache settings, failed restart recovery, requested maintenance, preserved native contexts and bilingual saved result')
finally:
    rpc('cleanup')
    driver.terminate()
    driver.wait(timeout=5)
