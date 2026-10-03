"""Exercise the memory setting against real IPC handlers in isolated storage."""
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
    return response['result']


try:
    fixtures = rpc('fixtures')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1000, 'height': 850})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script("""
          window.dshDesktop = new Proxy({}, { get: (_, method) => {
            if (method.startsWith('on')) return () => () => {};
            return payload => testRpc(method, payload);
          }});
        """)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri(), wait_until='networkidle')
        field = page.get_by_label('Global memory', exact=True)
        expect(field).to_have_value('')
        page.locator('#chooseMemoryDirectory').click()
        expect(field).to_have_value(fixtures['alpha'])
        expect(page.locator('#status')).to_have_text('Memory folder saved. Applies from the next message.')
        assert rpc('workbenchSettings')['memoryDirectory'] == fixtures['alpha']
        page.reload(wait_until='networkidle')
        expect(field).to_have_value(fixtures['alpha'])

        field.fill('missing-relative-folder')
        field.press('Tab')
        expect(page.locator('#status')).to_have_text('Use an absolute path for the memory folder.')
        assert rpc('workbenchSettings')['memoryDirectory'] == fixtures['alpha']
        field.fill(fixtures['beta'])
        field.press('Tab')
        expect(page.locator('#status')).to_have_text('Memory folder saved. Applies from the next message.')
        assert rpc('workbenchSettings')['memoryDirectory'] == fixtures['beta']

        page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
        expect(page.locator('.memory-setting h2')).to_have_text('全局记忆')
        expect(page.locator('#chooseMemoryDirectory')).to_have_text('选择文件夹')
        page.set_viewport_size({'width': 760, 'height': 800})
        box = page.locator('.memory-folder').bounding_box()
        button = page.locator('#chooseMemoryDirectory').bounding_box()
        assert button['x'] + button['width'] <= box['x'] + box['width'] + 1
        output = repo / 'dist/global-memory-qa'
        output.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(output / 'settings-zh.png'))

        page.locator('#memoryDirectory').fill('')
        page.locator('#memoryDirectory').press('Tab')
        expect(page.locator('#status')).to_have_text('记忆目录已保存，从下一条消息起生效。')
        assert rpc('workbenchSettings')['memoryDirectory'] == ''
        page.reload(wait_until='networkidle')
        expect(page.locator('#memoryDirectory')).to_have_value('')
        assert not errors, errors
        browser.close()
        print('Global memory UI: choose, persist, validate, replace, translate and disable passed')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
